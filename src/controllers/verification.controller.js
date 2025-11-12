import pool from '../config/database.js';
import encryptionService from '../services/encryption.service.js';
import auditService from '../services/audit.service.js';
import { generateHash } from '../utils/crypto.js';

class VerificationController {

  // Verify vote by receipt ID
async verifyByReceipt(req, res) {
  try {
    const { receiptId } = req.params;

    console.log('🔍 Verifying receipt:', receiptId);

    const result = await pool.query(
      `SELECT 
         vr.*,
         v.vote_hash,
         v.receipt_id as string_receipt_id,
         v.verification_code,
         v.created_at as vote_timestamp,
         e.title as election_title
       FROM votteryy_votes v
       JOIN votteryy_vote_receipts vr ON vr.voting_id = v.voting_id
       JOIN votteryyy_elections e ON vr.election_id = e.id
       WHERE v.receipt_id = $1`,
      [receiptId]
    );

    if (result.rows.length === 0) {
      console.log(' Receipt not found:', receiptId);
      return res.status(404).json({ error: 'Receipt not found' });
    }

    const receipt = result.rows[0];

    // Check if vote exists on public bulletin board
    const bulletinResult = await pool.query(
      `SELECT * FROM votteryy_public_bulletin_board WHERE vote_hash = $1`,
      [receipt.vote_hash]
    );

    const onBulletinBoard = bulletinResult.rows.length > 0;

    console.log('✅ Receipt verified:', receipt.string_receipt_id);

    res.json({
      verified: true,
      receipt: {
        receiptId: receipt.string_receipt_id,
        verificationCode: receipt.verification_code,
        voteHash: receipt.vote_hash,
        electionTitle: receipt.election_title,
        timestamp: receipt.vote_timestamp
      },
      onPublicBulletinBoard: onBulletinBoard,
      blockHash: onBulletinBoard ? bulletinResult.rows[0].block_hash : null,
      message: 'Vote successfully verified'
    });

  } catch (error) {
    console.error(' Verify by receipt error:', error);
    res.status(500).json({ error: 'Failed to verify receipt' });
  }
}

  // Verify vote by hash
  async verifyByHash(req, res) {
    try {
      const { voteHash } = req.params;
      const userId = req.user?.userId;

      const result = await pool.query(
        `SELECT 
           pbb.*,
           e.title as election_title
         FROM votteryy_public_bulletin_board pbb
         JOIN votteryyy_elections e ON pbb.election_id = e.id
         WHERE pbb.vote_hash = $1`,
        [voteHash]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ 
          verified: false,
          error: 'Vote not found on public bulletin board' 
        });
      }

      const vote = result.rows[0];

      // Verify hash chain
      let hashChainValid = true;
      if (vote.previous_block_hash) {
        const previousResult = await pool.query(
          `SELECT block_hash FROM votteryy_public_bulletin_board 
           WHERE election_id = $1 AND timestamp < $2
           ORDER BY timestamp DESC LIMIT 1`,
          [vote.election_id, vote.timestamp]
        );

        if (previousResult.rows.length > 0) {
          hashChainValid = previousResult.rows[0].block_hash === vote.previous_block_hash;
        }
      }

      res.json({
        verified: true,
        vote: {
          voteHash: vote.vote_hash,
          electionTitle: vote.election_title,
          timestamp: vote.timestamp,
          blockHash: vote.block_hash,
          previousBlockHash: vote.previous_block_hash,
          merkleRoot: vote.merkle_root
        },
        hashChainValid,
        message: 'Vote found on public bulletin board'
      });

    } catch (error) {
      console.error('Verify by hash error:', error);
      res.status(500).json({ error: 'Failed to verify vote hash' });
    }
  }

  // Verify encryption (Issue #1)
  async verifyEncryption(req, res) {
    try {
      const { electionId } = req.params;
      const { voteHash } = req.body;
      const userId = req.user.userId;

      const verification = await encryptionService.verifyEncryption(voteHash, electionId, userId);

      res.json(verification);

    } catch (error) {
      console.error('Verify encryption error:', error);
      res.status(500).json({ error: 'Failed to verify encryption' });
    }
  }

  // Get user's vote verification data
  async getMyVerificationData(req, res) {
    try {
      const { electionId } = req.params;
      const userId = req.user.userId;

      const verificationData = await encryptionService.getVoteVerificationData(userId, electionId);

      res.json({
        success: true,
        verificationData
      });

    } catch (error) {
      console.error('Get verification data error:', error);
      res.status(500).json({ error: error.message || 'Failed to retrieve verification data' });
    }
  }

  // Get public bulletin board for election
  async getPublicBulletinBoard(req, res) {
    try {
      const { electionId } = req.params;
      const { page = 1, limit = 50 } = req.query;

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT 
           vote_hash,
           timestamp,
           block_hash,
           previous_block_hash,
           merkle_root
         FROM votteryy_public_bulletin_board
         WHERE election_id = $1
         ORDER BY timestamp DESC
         LIMIT $2 OFFSET $3`,
        [electionId, limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM votteryy_public_bulletin_board WHERE election_id = $1`,
        [electionId]
      );

      res.json({
        votes: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalCount: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
        }
      });

    } catch (error) {
      console.error('Get public bulletin board error:', error);
      res.status(500).json({ error: 'Failed to retrieve public bulletin board' });
    }
  }

  // Verify audit trail integrity (Issue #3)
  async verifyAuditTrail(req, res) {
    try {
      const { electionId } = req.params;

      const verification = await auditService.verifyAuditTrailIntegrity(
        electionId ? parseInt(electionId) : null
      );

      res.json(verification);

    } catch (error) {
      console.error('Verify audit trail error:', error);
      res.status(500).json({ error: 'Failed to verify audit trail' });
    }
  }

  // Get audit trail for election (Issue #3)
  async getAuditTrail(req, res) {
    try {
      const { electionId } = req.params;
      const { page = 1, limit = 50 } = req.query;

      const auditTrail = await auditService.getElectionAuditTrail(
        parseInt(electionId),
        parseInt(page),
        parseInt(limit)
      );

      res.json(auditTrail);

    } catch (error) {
      console.error('Get audit trail error:', error);
      res.status(500).json({ error: 'Failed to retrieve audit trail' });
    }
  }

  // Export audit trail
  async exportAuditTrail(req, res) {
    try {
      const { electionId } = req.params;
      const { format = 'json' } = req.query;

      const exportData = await auditService.exportAuditTrail(parseInt(electionId), format);

      if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=audit-trail-${electionId}.csv`);
        
        // Convert to CSV string
        const csvRows = [
          exportData.headers.join(','),
          ...exportData.rows.map(row => row.join(','))
        ];
        
        res.send(csvRows.join('\n'));
      } else {
        res.json(exportData.data);
      }

    } catch (error) {
      console.error('Export audit trail error:', error);
      res.status(500).json({ error: 'Failed to export audit trail' });
    }
  }

  // Get all user verifications
  async getUserVerifications(req, res) {
    try {
      const userId = req.user.userId;

      const result = await pool.query(
        `SELECT * FROM votteryy_vote_verifications
         WHERE user_id = $1
         ORDER BY verified_at DESC`,
        [userId]
      );

      res.json({
        verifications: result.rows,
        totalCount: result.rows.length
      });

    } catch (error) {
      console.error('Get user verifications error:', error);
      res.status(500).json({ error: 'Failed to retrieve verifications' });
    }
  }
}

export default new VerificationController();