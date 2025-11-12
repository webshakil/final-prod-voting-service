import pool from '../config/database.js';
import { createHashChain, generateHash } from '../utils/crypto.js';
import { getClientIP, getUserAgent } from '../utils/helpers.js';

class AuditService {

  // Log audit event with hash chain
  async logAuditEvent(eventType, eventData, req, electionId = null, actorId = null, actorRole = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get previous event hash for chain
      const previousResult = await client.query(
        `SELECT hash FROM votteryy_audit_timeline
         ORDER BY timestamp DESC LIMIT 1`
      );

      const previousHash = previousResult.rows.length > 0 ? previousResult.rows[0].hash : null;

      // Create event data object
      const eventObject = {
        type: eventType,
        data: eventData,
        timestamp: new Date().toISOString()
      };

      // Generate hash chain
      const eventHash = createHashChain(eventObject, previousHash);

      // Insert audit event
      const result = await client.query(
        `INSERT INTO votteryy_audit_timeline
         (election_id, event_type, actor_id, actor_role, event_data, ip_address, user_agent, hash, previous_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          electionId,
          eventType,
          actorId,
          actorRole,
          JSON.stringify(eventData),
          getClientIP(req),
          getUserAgent(req),
          eventHash,
          previousHash
        ]
      );

      await client.query('COMMIT');

      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Log vote cast
  async logVoteCast(userId, electionId, votingId, voteHash, req) {
    return this.logAuditEvent(
      'vote_cast',
      { userId, votingId, voteHash },
      req,
      electionId,
      userId,
      'voter'
    );
  }

  // Log vote edited
  async logVoteEdited(userId, electionId, votingId, originalVoteId, req) {
    return this.logAuditEvent(
      'vote_edited',
      { userId, votingId, originalVoteId },
      req,
      electionId,
      userId,
      'voter'
    );
  }

  // Log lottery draw
  async logLotteryDraw(electionId, winners, randomSeed, req) {
    return this.logAuditEvent(
      'lottery_drawn',
      { winners, randomSeed, winnerCount: winners.length },
      req,
      electionId,
      'system',
      'admin'
    );
  }

  // Log payment
  async logPayment(userId, electionId, amount, gateway, req) {
    return this.logAuditEvent(
      'payment_processed',
      { userId, amount, gateway },
      req,
      electionId,
      userId,
      'voter'
    );
  }

  // Log withdrawal
  async logWithdrawal(userId, amount, status, req) {
    return this.logAuditEvent(
      'withdrawal_requested',
      { userId, amount, status },
      req,
      null,
      userId,
      'user'
    );
  }

  // Log election created
  async logElectionCreated(electionId, creatorId, req) {
    return this.logAuditEvent(
      'election_created',
      { electionId },
      req,
      electionId,
      creatorId,
      'creator'
    );
  }

  // Log election locked
  async logElectionLocked(electionId, reason, req) {
    return this.logAuditEvent(
      'election_locked',
      { reason },
      req,
      electionId,
      'system',
      'admin'
    );
  }

  // Get audit trail for election
  async getElectionAuditTrail(electionId, page = 1, limit = 50) {
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT * FROM votteryy_audit_timeline
       WHERE election_id = $1
       ORDER BY timestamp DESC
       LIMIT $2 OFFSET $3`,
      [electionId, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM votteryy_audit_timeline WHERE election_id = $1`,
      [electionId]
    );

    return {
      events: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    };
  }

  // Get audit trail for user
  async getUserAuditTrail(userId, page = 1, limit = 50) {
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT * FROM votteryy_audit_timeline
       WHERE actor_id = $1
       ORDER BY timestamp DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM votteryy_audit_timeline WHERE actor_id = $1`,
      [userId]
    );

    return {
      events: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
    };
  }

  // Verify audit trail integrity
  async verifyAuditTrailIntegrity(electionId = null) {
    const client = await pool.connect();
    try {
      let query = `SELECT * FROM votteryy_audit_timeline ORDER BY timestamp ASC`;
      const params = [];

      if (electionId) {
        query = `SELECT * FROM votteryy_audit_timeline WHERE election_id = $1 ORDER BY timestamp ASC`;
        params.push(electionId);
      }

      const result = await client.query(query, params);
      const events = result.rows;

      if (events.length === 0) {
        return { valid: true, message: 'No audit events found' };
      }

      let previousHash = null;
      const brokenChains = [];

      for (let i = 0; i < events.length; i++) {
        const event = events[i];

        // Verify hash chain
        if (event.previous_hash !== previousHash) {
          brokenChains.push({
            eventId: event.event_id,
            expectedPreviousHash: previousHash,
            actualPreviousHash: event.previous_hash,
            index: i
          });
        }

        // Verify event hash
        const eventObject = {
          type: event.event_type,
          data: event.event_data,
          timestamp: event.timestamp.toISOString()
        };

        const expectedHash = createHashChain(eventObject, event.previous_hash);

        if (expectedHash !== event.hash) {
          brokenChains.push({
            eventId: event.event_id,
            reason: 'Hash mismatch',
            expectedHash,
            actualHash: event.hash,
            index: i
          });
        }

        previousHash = event.hash;
      }

      return {
        valid: brokenChains.length === 0,
        totalEvents: events.length,
        brokenChains,
        message: brokenChains.length === 0 ? 'Audit trail integrity verified' : 'Audit trail has been tampered with'
      };
    } finally {
      client.release();
    }
  }

  // Export audit trail
  async exportAuditTrail(electionId, format = 'json') {
    const result = await pool.query(
      `SELECT * FROM votteryy_audit_timeline
       WHERE election_id = $1
       ORDER BY timestamp ASC`,
      [electionId]
    );

    if (format === 'csv') {
      // Convert to CSV
      const headers = ['Event ID', 'Type', 'Actor', 'Role', 'Timestamp', 'Hash', 'Previous Hash'];
      const rows = result.rows.map(event => [
        event.event_id,
        event.event_type,
        event.actor_id,
        event.actor_role,
        event.timestamp,
        event.hash,
        event.previous_hash
      ]);

      return { format: 'csv', headers, rows };
    }

    return { format: 'json', data: result.rows };
  }

  // Get vote audit logs (legacy table)
  async getVoteAuditLogs(electionId, userId = null) {
    let query = `SELECT * FROM votteryy_vote_audit_logs WHERE election_id = $1`;
    const params = [electionId];

    if (userId) {
      query += ` AND user_id = $2`;
      params.push(userId);
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);
    return result.rows;
  }
}

export default new AuditService();