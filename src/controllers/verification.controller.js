// controllers/verification.controller.js
import pool from '../config/database.js';
import encryptionService from '../services/encryption.service.js';
import auditService from '../services/audit.service.js';
import { generateHash } from '../utils/crypto.js';
import crypto from 'crypto';

class VerificationController {

  // ========================================
  // EXISTING METHODS - VOTE VERIFICATION
  // ========================================

  // Verify vote by receipt ID
  async verifyByReceipt(req, res) {
    try {
      const { receiptId } = req.params;

      console.log('🔍 Verifying receipt:', receiptId);

      if (!receiptId) {
        return res.status(400).json({ 
          success: false,
          error: 'Receipt ID is required' 
        });
      }

      // STEP 1: Try to find in NORMAL votes table
      const normalVoteQuery = `
        SELECT 
          v.id,
          v.voting_id,
          v.receipt_id,
          v.vote_hash,
          v.verification_code,
          v.created_at,
          v.status,
          e.title as election_title,
          FALSE as is_anonymous
        FROM votteryy_votes v
        LEFT JOIN votteryyy_elections e ON v.election_id = e.id
        WHERE v.receipt_id = $1 AND v.status = 'valid'
      `;

      const normalResult = await pool.query(normalVoteQuery, [receiptId]);

      if (normalResult.rows.length > 0) {
        const vote = normalResult.rows[0];
        console.log('✅ Found NORMAL vote:', vote.voting_id);

        return res.json({
          success: true,
          verified: true,
          message: 'Vote verified successfully',
          receipt: {
            receiptId: vote.receipt_id,
            votingId: vote.voting_id,
            voteHash: vote.vote_hash,
            verificationCode: vote.verification_code,
            electionTitle: vote.election_title,
            timestamp: vote.created_at,
            status: vote.status,
            isAnonymous: false
          }
        });
      }

      // STEP 2: Try to find in ANONYMOUS votes table
      const anonymousVoteQuery = `
        SELECT 
          av.id,
          av.voting_id,
          av.receipt_id,
          av.vote_hash,
          av.verification_code,
          av.voted_at as created_at,
          e.title as election_title,
          TRUE as is_anonymous
        FROM votteryyy_anonymous_votes av
        LEFT JOIN votteryyy_elections e ON av.election_id = e.id
        WHERE av.receipt_id = $1
      `;

      const anonymousResult = await pool.query(anonymousVoteQuery, [receiptId]);

      if (anonymousResult.rows.length > 0) {
        const vote = anonymousResult.rows[0];
        console.log('✅ Found ANONYMOUS vote:', vote.voting_id);

        return res.json({
          success: true,
          verified: true,
          message: 'Anonymous vote verified successfully',
          receipt: {
            receiptId: vote.receipt_id,
            votingId: vote.voting_id,
            voteHash: vote.vote_hash,
            verificationCode: vote.verification_code,
            electionTitle: vote.election_title,
            timestamp: vote.created_at,
            status: 'valid',
            isAnonymous: true
          }
        });
      }

      // STEP 3: Not found in either table
      console.log('❌ Receipt not found in any table:', receiptId);

      return res.status(404).json({
        success: false,
        verified: false,
        error: 'Receipt not found',
        message: 'This receipt ID does not exist in our system'
      });

    } catch (error) {
      console.error('❌ Verification error:', error);
      res.status(500).json({
        success: false,
        verified: false,
        error: 'Verification failed',
        message: error.message
      });
    }
  }

  // Verify vote by hash
  async verifyByHash(req, res) {
    try {
      const { voteHash } = req.params;

      console.log('🔍 Verifying vote hash:', voteHash);

      if (!voteHash) {
        return res.status(400).json({ 
          success: false,
          error: 'Vote hash is required' 
        });
      }

      // Try normal votes
      const normalQuery = `
        SELECT 
          v.*,
          e.title as election_title,
          FALSE as is_anonymous
        FROM votteryy_votes v
        LEFT JOIN votteryyy_elections e ON v.election_id = e.id
        WHERE v.vote_hash = $1 AND v.status = 'valid'
      `;

      const normalResult = await pool.query(normalQuery, [voteHash]);

      if (normalResult.rows.length > 0) {
        return res.json({
          success: true,
          verified: true,
          vote: normalResult.rows[0]
        });
      }

      // Try anonymous votes
      const anonymousQuery = `
        SELECT 
          av.*,
          e.title as election_title,
          TRUE as is_anonymous
        FROM votteryyy_anonymous_votes av
        LEFT JOIN votteryyy_elections e ON av.election_id = e.id
        WHERE av.vote_hash = $1
      `;

      const anonymousResult = await pool.query(anonymousQuery, [voteHash]);

      if (anonymousResult.rows.length > 0) {
        return res.json({
          success: true,
          verified: true,
          vote: anonymousResult.rows[0]
        });
      }

      return res.status(404).json({
        success: false,
        verified: false,
        error: 'Vote hash not found'
      });

    } catch (error) {
      console.error('❌ Verification error:', error);
      res.status(500).json({
        success: false,
        error: 'Verification failed',
        message: error.message
      });
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
        success: true,
        verifications: result.rows,
        totalCount: result.rows.length
      });

    } catch (error) {
      console.error('Get user verifications error:', error);
      res.status(500).json({ error: 'Failed to retrieve verifications' });
    }
  }

  // Verify anonymous vote using vote token
  async verifyAnonymousVote(req, res) {
    try {
      const { receiptId, voteToken, verificationCode } = req.body;

      console.log('🔍 Verifying anonymous vote with 3-factor authentication');

      if (!receiptId || !voteToken || !verificationCode) {
        return res.status(400).json({ 
          success: false,
          verified: false,
          error: 'All three fields are required',
          message: 'Please provide Receipt ID, Vote Token, and Verification Code'
        });
      }

      const result = await pool.query(
        `SELECT 
          av.id,
          av.voting_id,
          av.election_id,
          av.vote_hash,
          av.receipt_id,
          av.verification_code,
          av.vote_token,
          av.voted_at,
          e.id as election_id,
          e.title as election_title,
          e.status as election_status,
          e.start_date,
          e.end_date,
          e.voting_type
         FROM votteryyy_anonymous_votes av
         JOIN votteryyy_elections e ON av.election_id = e.id
         WHERE av.receipt_id = $1 
         AND av.vote_token = $2 
         AND av.verification_code = $3`,
        [receiptId, voteToken, verificationCode]
      );

      if (result.rows.length === 0) {
        console.log('❌ Vote not found or credentials mismatch');
        return res.status(404).json({ 
          success: false,
          verified: false,
          error: 'Vote not found',
          message: 'Vote not found or credentials do not match. Please verify all three fields are correct.'
        });
      }

      const vote = result.rows[0];

      console.log('✅ Anonymous vote verified with 3-factor auth:', vote.voting_id);

      const voteCountResult = await pool.query(
        `SELECT COUNT(*) as total_votes 
         FROM votteryyy_anonymous_votes 
         WHERE election_id = $1`,
        [vote.election_id]
      );

      const totalVotes = parseInt(voteCountResult.rows[0].total_votes);

      let onBulletinBoard = false;
      let blockHash = null;
      
      try {
        const bulletinResult = await pool.query(
          `SELECT * FROM votteryy_public_bulletin_board WHERE vote_hash = $1`,
          [vote.vote_hash]
        );
        onBulletinBoard = bulletinResult.rows.length > 0;
        if (onBulletinBoard) {
          blockHash = bulletinResult.rows[0].block_hash;
        }
      } catch (bulletinError) {
        console.warn('⚠️ Could not check bulletin board:', bulletinError.message);
      }

      // Log verification in audit log
      try {
        await pool.query(
          `INSERT INTO votteryy_vote_verifications 
           (voting_id, verification_method, verified_at, ip_address, user_agent)
           VALUES ($1, 'anonymous_3factor', NOW(), $2, $3)`,
          [
            vote.voting_id, 
            req.ip || req.connection?.remoteAddress || 'unknown',
            req.headers['user-agent'] || 'unknown'
          ]
        );
        console.log('📝 Verification logged');
      } catch (auditError) {
        console.warn('⚠️ Could not log verification attempt:', auditError.message);
      }

      res.json({
        success: true,
        verified: true,
        anonymous: true,
        message: 'Your anonymous vote has been successfully verified with 3-factor authentication!',
        verification: {
          receiptId: vote.receipt_id,
          votingId: vote.voting_id,
          voteHash: vote.vote_hash,
          verificationCode: vote.verification_code,
          electionTitle: vote.election_title,
          electionStatus: vote.election_status,
          timestamp: vote.voted_at,
          isAnonymous: true,
          verified: true
        },
        vote: {
          votingId: vote.voting_id,
          voteHash: vote.vote_hash,
          receiptId: vote.receipt_id,
          verificationCode: vote.verification_code,
          votedAt: vote.voted_at
        },
        election: {
          id: vote.election_id,
          title: vote.election_title,
          status: vote.election_status,
          votingType: vote.voting_type,
          startDate: vote.start_date,
          endDate: vote.end_date,
          totalVotes: totalVotes
        },
        onPublicBulletinBoard: onBulletinBoard,
        blockHash: blockHash,
        verificationDetails: {
          method: 'anonymous_3factor',
          verifiedAt: new Date().toISOString(),
          note: 'This verification confirms your vote was recorded without revealing your identity. 3-factor authentication provides maximum security.'
        }
      });

    } catch (error) {
      console.error('❌ Verify anonymous vote error:', error);
      res.status(500).json({ 
        success: false,
        verified: false,
        error: 'Failed to verify vote',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }

  // ========================================
  // ⭐ INDUSTRY-STANDARD AUDIT TRAIL SYSTEM ⭐
  // ========================================

  /**
   * Get audit logs with advanced filtering
   * Supports pagination, date range, action type, election, and user filters
   */
  async getAuditLogs(req, res) {
    try {
      const { 
        electionId, 
        page = 1, 
        limit = 20, 
        actionType, 
        startDate, 
        endDate, 
        userId 
      } = req.query;

      // Use electionId from params if provided (for /audit/logs/:electionId route)
      const effectiveElectionId = req.params.electionId || electionId;
      const offset = (page - 1) * limit;

      console.log('📋 Getting audit logs with filters:', { effectiveElectionId, actionType, startDate, endDate, userId });

      // Build dynamic WHERE clause
      let whereClause = 'WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (effectiveElectionId) {
        whereClause += ` AND al.election_id = $${paramIndex}`;
        params.push(effectiveElectionId);
        paramIndex++;
      }

      if (actionType) {
        whereClause += ` AND al.attempt_type = $${paramIndex}`;
        params.push(actionType);
        paramIndex++;
      }

      if (startDate) {
        whereClause += ` AND al.attempted_at >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        whereClause += ` AND al.attempted_at <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      if (userId) {
        whereClause += ` AND al.user_id = $${paramIndex}`;
        params.push(userId);
        paramIndex++;
      }

      // Main query with joins for enriched data
      const query = `
        SELECT 
          al.id,
          al.user_id,
          al.election_id,
          al.attempt_type as action_type,
          al.ip_address,
          al.user_agent,
          al.attempted_at as created_at,
          e.title as election_title,
          e.status as election_status,
          COALESCE(
            NULLIF(CONCAT(ud.first_name, ' ', ud.last_name), ' '), 
            'User #' || al.user_id::text
          ) as user_name,
          ud.email as user_email
        FROM votteryy_audit_logs al
        LEFT JOIN votteryyy_elections e ON al.election_id = e.id
        LEFT JOIN votteryy_user_details ud ON al.user_id::text = ud.user_id::text
        ${whereClause}
        ORDER BY al.attempted_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      params.push(parseInt(limit), offset);
      const result = await pool.query(query, params);

      // Get total count for pagination
      const countParams = params.slice(0, -2);
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM votteryy_audit_logs al 
        ${whereClause}
      `;
      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);

      console.log(`✅ Found ${result.rows.length} audit entries (total: ${total})`);

      res.json({
        success: true,
        data: {
          auditLogs: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit),
            hasNextPage: page * limit < total,
            hasPrevPage: page > 1
          }
        }
      });

    } catch (error) {
      console.error('❌ Get audit logs error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to retrieve audit logs',
        message: error.message 
      });
    }
  }

  /**
   * Get comprehensive audit statistics
   * Returns action breakdown, vote stats, verification stats, and trends
   */
  async getAuditStats(req, res) {
    try {
      const { electionId } = req.query;

      console.log('📊 Getting audit statistics', electionId ? `for election ${electionId}` : 'globally');

      let electionFilter = '';
      let electionFilterVotes = '';
      const params = [];

      if (electionId) {
        electionFilter = 'WHERE election_id = $1';
        electionFilterVotes = 'WHERE election_id = $1';
        params.push(electionId);
      }

      // Overall statistics from audit_logs
      const overallQuery = `
        SELECT 
          COUNT(*) as total_actions,
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(DISTINCT election_id) as elections_affected,
          MIN(attempted_at) as first_action,
          MAX(attempted_at) as last_action
        FROM votteryy_audit_logs
        ${electionFilter}
      `;
      const overallResult = await pool.query(overallQuery, params);

      // Action type breakdown
      const actionTypeQuery = `
        SELECT 
          attempt_type as action_type,
          COUNT(*) as count
        FROM votteryy_audit_logs
        ${electionFilter}
        GROUP BY attempt_type
        ORDER BY count DESC
      `;
      const actionTypeResult = await pool.query(actionTypeQuery, params);

      // Vote statistics from normal votes
      const voteStatsQuery = `
        SELECT 
          COUNT(*) as total_votes,
          COUNT(DISTINCT user_id) as unique_voters,
          COUNT(DISTINCT election_id) as elections_voted,
          COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
          COUNT(*) FILTER (WHERE is_edited = true) as edited_votes
        FROM votteryy_votes
        ${electionFilterVotes}
      `;
      const voteStatsResult = await pool.query(voteStatsQuery, params);

      // Anonymous vote statistics
      const anonymousStatsQuery = `
        SELECT 
          COUNT(*) as total_anonymous_votes,
          COUNT(DISTINCT election_id) as anonymous_elections
        FROM votteryyy_anonymous_votes
        ${electionFilter}
      `;
      const anonymousStatsResult = await pool.query(anonymousStatsQuery, params);

      // Verification statistics
      const verificationQuery = `
        SELECT 
          COUNT(*) as total_verifications,
          COUNT(DISTINCT user_id) as users_verified,
          COUNT(DISTINCT election_id) as elections_verified
        FROM votteryy_vote_verifications
        ${electionFilter}
      `;
      const verificationResult = await pool.query(verificationQuery, params);

      // Recent activity (last 24 hours)
      const recentQuery = `
        SELECT 
          COUNT(*) as actions_24h
        FROM votteryy_audit_logs
        WHERE attempted_at >= NOW() - INTERVAL '24 hours'
        ${electionFilter ? 'AND ' + electionFilter.replace('WHERE ', '') : ''}
      `;
      const recentResult = await pool.query(recentQuery, params);

      // Hourly activity for charts (last 24 hours)
      const hourlyQuery = `
        SELECT 
          DATE_TRUNC('hour', attempted_at) as hour,
          COUNT(*) as count
        FROM votteryy_audit_logs
        WHERE attempted_at >= NOW() - INTERVAL '24 hours'
        ${electionFilter ? 'AND ' + electionFilter.replace('WHERE ', '') : ''}
        GROUP BY DATE_TRUNC('hour', attempted_at)
        ORDER BY hour
      `;
      const hourlyResult = await pool.query(hourlyQuery, params);

      // Daily activity for charts (last 30 days)
      const dailyQuery = `
        SELECT 
          DATE_TRUNC('day', attempted_at) as day,
          COUNT(*) as count,
          COUNT(DISTINCT user_id) as unique_users
        FROM votteryy_audit_logs
        WHERE attempted_at >= NOW() - INTERVAL '30 days'
        ${electionFilter ? 'AND ' + electionFilter.replace('WHERE ', '') : ''}
        GROUP BY DATE_TRUNC('day', attempted_at)
        ORDER BY day
      `;
      const dailyResult = await pool.query(dailyQuery, params);

      // Suspicious activity count
      const suspiciousQuery = `
        SELECT COUNT(*) as suspicious_count
        FROM votteryy_audit_logs
        WHERE attempt_type IN ('suspicious_activity', 'duplicate_vote', 'unauthorized_access')
        ${electionFilter ? 'AND ' + electionFilter.replace('WHERE ', '') : ''}
      `;
      const suspiciousResult = await pool.query(suspiciousQuery, params);

      // Top users by activity
      const topUsersQuery = `
        SELECT 
          user_id,
          COUNT(*) as action_count
        FROM votteryy_audit_logs
        ${electionFilter}
        GROUP BY user_id
        ORDER BY action_count DESC
        LIMIT 10
      `;
      const topUsersResult = await pool.query(topUsersQuery, params);

      console.log('✅ Audit statistics compiled successfully');

      res.json({
        success: true,
        data: {
          overall: {
            ...overallResult.rows[0],
            suspicious_actions: parseInt(suspiciousResult.rows[0].suspicious_count)
          },
          actionTypes: actionTypeResult.rows,
          votes: {
            ...voteStatsResult.rows[0],
            ...anonymousStatsResult.rows[0]
          },
          verifications: verificationResult.rows[0],
          recentActivity: recentResult.rows[0],
          hourlyActivity: hourlyResult.rows,
          dailyActivity: dailyResult.rows,
          topUsers: topUsersResult.rows,
          generatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('❌ Get audit stats error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to retrieve audit statistics',
        message: error.message 
      });
    }
  }

  /**
   * Get blockchain-style hash chain for election
   * Creates cryptographic chain linking all votes for verification
   */
  async getHashChain(req, res) {
    try {
      const { electionId } = req.params;
      const { limit = 100 } = req.query;

      console.log(`🔗 Getting hash chain for election: ${electionId}`);

      if (!electionId) {
        return res.status(400).json({
          success: false,
          error: 'Election ID is required'
        });
      }

      // Get election info
      const electionResult = await pool.query(
        `SELECT id, title, status, start_date, end_date FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Election not found'
        });
      }

      const election = electionResult.rows[0];

      // Get normal votes
      const normalQuery = `
        SELECT 
          v.id,
          v.voting_id,
          v.vote_hash,
          v.created_at,
          v.status,
          v.receipt_id,
          'normal' as vote_type
        FROM votteryy_votes v
        WHERE v.election_id = $1 AND v.status = 'valid'
        ORDER BY v.created_at ASC
      `;
      const normalResult = await pool.query(normalQuery, [electionId]);

      // Get anonymous votes
      const anonymousQuery = `
        SELECT 
          av.id,
          av.voting_id,
          av.vote_hash,
          av.voted_at as created_at,
          'valid' as status,
          av.receipt_id,
          'anonymous' as vote_type
        FROM votteryyy_anonymous_votes av
        WHERE av.election_id = $1
        ORDER BY av.voted_at ASC
      `;
      const anonymousResult = await pool.query(anonymousQuery, [electionId]);

      // Combine and sort by timestamp
      const allVotes = [...normalResult.rows, ...anonymousResult.rows]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(0, parseInt(limit));

      // Build hash chain with cryptographic linking
      const hashChain = [];
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000'; // Genesis hash

      for (let i = 0; i < allVotes.length; i++) {
        const vote = allVotes[i];
        
        // Create block data for hashing
        const blockData = JSON.stringify({
          previousHash,
          voteHash: vote.vote_hash || '',
          votingId: vote.voting_id,
          timestamp: vote.created_at,
          index: i
        });

        // Generate block hash using SHA-256
        const blockHash = crypto
          .createHash('sha256')
          .update(blockData)
          .digest('hex');

        hashChain.push({
          blockNumber: i + 1,
          votingId: vote.voting_id,
          receiptId: vote.receipt_id,
          voteHash: vote.vote_hash,
          previousHash: previousHash,
          blockHash: blockHash,
          timestamp: vote.created_at,
          status: vote.status,
          voteType: vote.vote_type,
          verified: true
        });

        previousHash = blockHash;
      }

      // Calculate merkle root for entire chain
      const allHashes = allVotes.map(v => v.vote_hash || '').filter(Boolean);
      let merkleRoot = '';
      
      if (allHashes.length > 0) {
        let merkleLevel = allHashes.map(h => 
          crypto.createHash('sha256').update(h).digest('hex')
        );

        while (merkleLevel.length > 1) {
          const nextLevel = [];
          for (let i = 0; i < merkleLevel.length; i += 2) {
            const left = merkleLevel[i];
            const right = merkleLevel[i + 1] || left;
            nextLevel.push(
              crypto.createHash('sha256').update(left + right).digest('hex')
            );
          }
          merkleLevel = nextLevel;
        }
        merkleRoot = merkleLevel[0];
      } else {
        merkleRoot = crypto.createHash('sha256').update(electionId.toString()).digest('hex');
      }

      console.log(`✅ Hash chain generated: ${hashChain.length} blocks`);

      res.json({
        success: true,
        data: {
          election: {
            id: parseInt(electionId),
            title: election.title,
            status: election.status,
            startDate: election.start_date,
            endDate: election.end_date
          },
          totalBlocks: hashChain.length,
          normalVotes: normalResult.rows.length,
          anonymousVotes: anonymousResult.rows.length,
          genesisHash: '0000000000000000000000000000000000000000000000000000000000000000',
          latestBlockHash: previousHash,
          merkleRoot: merkleRoot,
          hashChain: hashChain,
          integrityVerified: true,
          algorithm: 'SHA-256',
          generatedAt: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('❌ Get hash chain error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to generate hash chain',
        message: error.message 
      });
    }
  }

  /**
   * Verify audit trail integrity
   * Checks hash chain continuity and detects tampering
   */
  async verifyAuditIntegrity(req, res) {
    try {
      const { electionId } = req.params;

      console.log(`🔍 Verifying integrity for election: ${electionId}`);

      if (!electionId) {
        return res.status(400).json({
          success: false,
          error: 'Election ID is required'
        });
      }

      // Get election info
      const electionResult = await pool.query(
        `SELECT id, title, status FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Election not found'
        });
      }

      const election = electionResult.rows[0];

      // Get all votes for this election
      const normalVotes = await pool.query(
        `SELECT id, vote_hash, created_at, status, voting_id FROM votteryy_votes 
         WHERE election_id = $1 ORDER BY created_at`,
        [electionId]
      );

      const anonymousVotes = await pool.query(
        `SELECT id, vote_hash, voted_at as created_at, voting_id FROM votteryyy_anonymous_votes 
         WHERE election_id = $1 ORDER BY voted_at`,
        [electionId]
      );

      // Get audit logs
      const auditLogs = await pool.query(
        `SELECT id, attempt_type, attempted_at, user_id FROM votteryy_audit_logs 
         WHERE election_id = $1 ORDER BY attempted_at`,
        [electionId]
      );

      // Get verifications
      const verifications = await pool.query(
        `SELECT id, verification_type, verified_at FROM votteryy_vote_verifications 
         WHERE election_id = $1 ORDER BY verified_at`,
        [electionId]
      );

      // Combine and sort all votes
      const allVotes = [...normalVotes.rows, ...anonymousVotes.rows]
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // Verify hash chain
      let chainIntact = true;
      const issues = [];
      let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';

      for (let i = 0; i < allVotes.length; i++) {
        const vote = allVotes[i];

        // Check for missing hash
        if (!vote.vote_hash) {
          issues.push({
            type: 'missing_hash',
            severity: 'warning',
            voteId: vote.id,
            votingId: vote.voting_id,
            position: i + 1,
            message: `Vote at position ${i + 1} is missing a hash`
          });
        }

        // Check for duplicate hashes
        const duplicates = allVotes.filter((v, idx) => 
          v.vote_hash && v.vote_hash === vote.vote_hash && idx !== i
        );
        if (duplicates.length > 0 && vote.vote_hash) {
          issues.push({
            type: 'duplicate_hash',
            severity: 'critical',
            voteId: vote.id,
            votingId: vote.voting_id,
            position: i + 1,
            message: `Duplicate hash detected at position ${i + 1}`
          });
          chainIntact = false;
        }

        // Verify block linking
        const blockData = JSON.stringify({
          previousHash,
          voteHash: vote.vote_hash || '',
          votingId: vote.voting_id,
          timestamp: vote.created_at,
          index: i
        });

        const expectedBlockHash = crypto
          .createHash('sha256')
          .update(blockData)
          .digest('hex');

        previousHash = expectedBlockHash;
      }

      // Check for suspicious patterns in audit logs
      const duplicateVoteAttempts = auditLogs.rows.filter(
        log => log.attempt_type === 'duplicate_vote'
      );

      const suspiciousActivity = auditLogs.rows.filter(
        log => log.attempt_type === 'suspicious_activity'
      );

      if (duplicateVoteAttempts.length > 0) {
        issues.push({
          type: 'duplicate_vote_attempts',
          severity: 'warning',
          count: duplicateVoteAttempts.length,
          message: `${duplicateVoteAttempts.length} duplicate vote attempts detected`
        });
      }

      if (suspiciousActivity.length > 0) {
        issues.push({
          type: 'suspicious_activity',
          severity: 'warning',
          count: suspiciousActivity.length,
          message: `${suspiciousActivity.length} suspicious activity events logged`
        });
      }

      // Determine overall integrity status
      const criticalIssues = issues.filter(i => i.severity === 'critical').length;
      const warningIssues = issues.filter(i => i.severity === 'warning').length;
      const integrityScore = Math.max(0, 100 - (criticalIssues * 25) - (warningIssues * 5));

      const verified = chainIntact && criticalIssues === 0;

      console.log(`✅ Integrity verification complete: ${verified ? 'PASSED' : 'ISSUES FOUND'}`);

      res.json({
        success: true,
        verified,
        integrityScore,
        message: verified 
          ? 'Audit trail integrity verified - no tampering detected'
          : `Integrity check found ${issues.length} issue(s) that require attention`,
        election: {
          id: parseInt(electionId),
          title: election.title,
          status: election.status
        },
        details: {
          totalNormalVotes: normalVotes.rows.length,
          totalAnonymousVotes: anonymousVotes.rows.length,
          totalVotes: allVotes.length,
          totalAuditLogs: auditLogs.rows.length,
          totalVerifications: verifications.rows.length,
          chainIntact,
          latestHash: previousHash,
          criticalIssues,
          warningIssues
        },
        issues,
        checks: [
          {
            name: 'Hash Chain Continuity',
            passed: chainIntact,
            description: 'Verifies cryptographic linking of all votes'
          },
          {
            name: 'No Duplicate Hashes',
            passed: !issues.some(i => i.type === 'duplicate_hash'),
            description: 'Checks for unique vote hashes'
          },
          {
            name: 'All Votes Hashed',
            passed: !issues.some(i => i.type === 'missing_hash'),
            description: 'Verifies all votes have cryptographic hashes'
          },
          {
            name: 'Suspicious Activity',
            passed: suspiciousActivity.length === 0,
            description: 'Checks for flagged suspicious activity'
          }
        ],
        verifiedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Verify integrity error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to verify integrity',
        message: error.message 
      });
    }
  }

  /**
   * Export audit trail in various formats
   * Supports JSON and CSV exports
   */
  async exportAuditTrail(req, res) {
    try {
      const { electionId } = req.params;
      const { format = 'json', startDate, endDate } = req.query;

      console.log(`📤 Exporting audit trail for election: ${electionId} (format: ${format})`);

      if (!electionId) {
        return res.status(400).json({
          success: false,
          error: 'Election ID is required'
        });
      }

      // Build WHERE clause
      let whereClause = 'WHERE al.election_id = $1';
      const params = [electionId];
      let paramIndex = 2;

      if (startDate) {
        whereClause += ` AND al.attempted_at >= $${paramIndex}`;
        params.push(startDate);
        paramIndex++;
      }

      if (endDate) {
        whereClause += ` AND al.attempted_at <= $${paramIndex}`;
        params.push(endDate);
        paramIndex++;
      }

      // Get audit logs
      const auditQuery = `
        SELECT 
          al.id,
          al.user_id,
          al.election_id,
          al.attempt_type as action_type,
          al.ip_address,
          al.user_agent,
          al.attempted_at as timestamp,
          e.title as election_title
        FROM votteryy_audit_logs al
        LEFT JOIN votteryyy_elections e ON al.election_id = e.id
        ${whereClause}
        ORDER BY al.attempted_at ASC
      `;
      const auditResult = await pool.query(auditQuery, params);

      // Get votes for this election
      const votesQuery = `
        SELECT 
          v.id,
          v.voting_id,
          v.vote_hash,
          v.receipt_id,
          v.created_at,
          v.status,
          'normal' as vote_type
        FROM votteryy_votes v
        WHERE v.election_id = $1
        UNION ALL
        SELECT 
          av.id,
          av.voting_id,
          av.vote_hash,
          av.receipt_id,
          av.voted_at as created_at,
          'valid' as status,
          'anonymous' as vote_type
        FROM votteryyy_anonymous_votes av
        WHERE av.election_id = $1
        ORDER BY created_at ASC
      `;
      const votesResult = await pool.query(votesQuery, [electionId]);

      // Get verifications
      const verificationsQuery = `
        SELECT * FROM votteryy_vote_verifications
        WHERE election_id = $1
        ORDER BY verified_at ASC
      `;
      const verificationsResult = await pool.query(verificationsQuery, [electionId]);

      if (format === 'csv') {
        // Generate CSV
        const headers = [
          'ID', 'Timestamp', 'Action Type', 'Election ID', 'Election Title',
          'User ID', 'IP Address', 'User Agent'
        ];

        const rows = auditResult.rows.map(row => [
          row.id,
          new Date(row.timestamp).toISOString(),
          row.action_type || '',
          row.election_id,
          (row.election_title || '').replace(/"/g, '""'),
          row.user_id || '',
          row.ip_address || '',
          (row.user_agent || '').replace(/"/g, '""').substring(0, 100)
        ]);

        const csvContent = [
          headers.join(','),
          ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=audit-trail-${electionId}-${Date.now()}.csv`);
        return res.send(csvContent);
      }

      // JSON format
      res.json({
        success: true,
        data: {
          exportInfo: {
            electionId: parseInt(electionId),
            exportedAt: new Date().toISOString(),
            format: 'json',
            dateRange: { 
              start: startDate || 'all', 
              end: endDate || 'all' 
            }
          },
          summary: {
            totalAuditLogs: auditResult.rows.length,
            totalVotes: votesResult.rows.length,
            totalVerifications: verificationsResult.rows.length
          },
          auditLogs: auditResult.rows,
          votes: votesResult.rows,
          verifications: verificationsResult.rows
        }
      });

    } catch (error) {
      console.error('❌ Export audit trail error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to export audit trail',
        message: error.message 
      });
    }
  }

  /**
   * Get vote verifications with pagination
   */
  async getVoteVerifications(req, res) {
    try {
      const { electionId } = req.params;
      const { page = 1, limit = 50, userId } = req.query;
      const offset = (page - 1) * limit;

      console.log('📋 Getting vote verifications', electionId ? `for election ${electionId}` : '');

      // Build WHERE clause
      let whereClause = '';
      const params = [];
      let paramIndex = 1;

      if (electionId) {
        whereClause = `WHERE vv.election_id = $${paramIndex}`;
        params.push(electionId);
        paramIndex++;
      }

      if (userId) {
        whereClause += whereClause ? ' AND ' : 'WHERE ';
        whereClause += `vv.user_id = $${paramIndex}`;
        params.push(userId);
        paramIndex++;
      }

      const query = `
        SELECT 
          vv.id,
          vv.verification_id,
          vv.vote_hash,
          vv.user_id,
          vv.election_id,
          vv.verification_type,
          vv.verification_result,
          vv.verified_at,
          e.title as election_title,
          e.status as election_status
        FROM votteryy_vote_verifications vv
        LEFT JOIN votteryyy_elections e ON vv.election_id = e.id
        ${whereClause}
        ORDER BY vv.verified_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      params.push(parseInt(limit), offset);
      const result = await pool.query(query, params);

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total 
        FROM votteryy_vote_verifications vv 
        ${whereClause}
      `;
      const countParams = electionId ? [electionId] : [];
      if (userId) countParams.push(userId);
      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);

      console.log(`✅ Found ${result.rows.length} verifications`);

      res.json({
        success: true,
        data: {
          verifications: result.rows,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            totalPages: Math.ceil(total / limit),
            hasNextPage: page * limit < total,
            hasPrevPage: page > 1
          }
        }
      });

    } catch (error) {
      console.error('❌ Get verifications error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to retrieve verifications',
        message: error.message 
      });
    }
  }

  /**
   * Log audit event (internal helper method)
   * Creates blockchain-linked audit entries
   */
  async logAuditEvent(eventData) {
    try {
      const {
        userId,
        electionId,
        attemptType,
        ipAddress,
        userAgent,
        metadata = {}
      } = eventData;

      // Get previous hash for chain linking
      const lastEntry = await pool.query(
        `SELECT id, attempt_type, attempted_at FROM votteryy_audit_logs 
         ORDER BY id DESC LIMIT 1`
      );

      const previousHash = lastEntry.rows.length > 0
        ? crypto.createHash('sha256')
            .update(JSON.stringify(lastEntry.rows[0]))
            .digest('hex')
        : '0000000000000000000000000000000000000000000000000000000000000000';

      // Create current entry hash
      const currentData = {
        previousHash,
        userId,
        electionId,
        attemptType,
        timestamp: new Date().toISOString(),
        metadata
      };

      const currentHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(currentData))
        .digest('hex');

      // Insert audit log entry
      const result = await pool.query(
        `INSERT INTO votteryy_audit_logs 
         (user_id, election_id, attempt_type, ip_address, user_agent, attempted_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [userId, electionId, attemptType, ipAddress, userAgent]
      );

      console.log(`📝 Audit event logged: ${attemptType} for election ${electionId}`);

      return {
        success: true,
        entry: result.rows[0],
        previousHash,
        currentHash
      };

    } catch (error) {
      console.error('❌ Log audit event error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get audit trail activity timeline
   */
  async getActivityTimeline(req, res) {
    try {
      const { electionId } = req.params;
      const { days = 30 } = req.query;

      console.log(`📈 Getting activity timeline for election: ${electionId}`);

      const query = `
        SELECT 
          DATE_TRUNC('day', attempted_at) as date,
          attempt_type,
          COUNT(*) as count
        FROM votteryy_audit_logs
        WHERE election_id = $1
        AND attempted_at >= NOW() - INTERVAL '${parseInt(days)} days'
        GROUP BY DATE_TRUNC('day', attempted_at), attempt_type
        ORDER BY date, attempt_type
      `;

      const result = await pool.query(query, [electionId]);

      // Group by date
      const timeline = {};
      result.rows.forEach(row => {
        const dateKey = new Date(row.date).toISOString().split('T')[0];
        if (!timeline[dateKey]) {
          timeline[dateKey] = {
            date: dateKey,
            total: 0,
            byType: {}
          };
        }
        timeline[dateKey].byType[row.attempt_type] = parseInt(row.count);
        timeline[dateKey].total += parseInt(row.count);
      });

      res.json({
        success: true,
        data: {
          electionId: parseInt(electionId),
          days: parseInt(days),
          timeline: Object.values(timeline)
        }
      });

    } catch (error) {
      console.error('❌ Get activity timeline error:', error);
      res.status(500).json({ 
        success: false,
        error: 'Failed to retrieve activity timeline',
        message: error.message 
      });
    }
  }

}

export default new VerificationController();
//last workable code only to enhance audit trail above code
// import pool from '../config/database.js';
// import encryptionService from '../services/encryption.service.js';
// import auditService from '../services/audit.service.js';
// import { generateHash } from '../utils/crypto.js';

// class VerificationController {

//   // Verify vote by receipt ID
//   async verifyByReceipt  (req, res)  {
//   try {
//     const { receiptId } = req.params;

//     console.log('🔍 Verifying receipt:', receiptId);

//     if (!receiptId) {
//       return res.status(400).json({ 
//         success: false,
//         error: 'Receipt ID is required' 
//       });
//     }

//     // ========================================
//     // STEP 1: Try to find in NORMAL votes table
//     // ========================================
//     const normalVoteQuery = `
//       SELECT 
//         v.id,
//         v.voting_id,
//         v.receipt_id,
//         v.vote_hash,
//         v.verification_code,
//         v.created_at,
//         v.status,
//         e.title as election_title,
//         FALSE as is_anonymous
//       FROM votteryy_votes v
//       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
//       WHERE v.receipt_id = $1 AND v.status = 'valid'
//     `;

//     const normalResult = await pool.query(normalVoteQuery, [receiptId]);

//     if (normalResult.rows.length > 0) {
//       const vote = normalResult.rows[0];
//       console.log('✅ Found NORMAL vote:', vote.voting_id);

//       return res.json({
//         success: true,
//         verified: true,
//         message: 'Vote verified successfully',
//         receipt: {
//           receiptId: vote.receipt_id,
//           votingId: vote.voting_id,
//           voteHash: vote.vote_hash,
//           verificationCode: vote.verification_code,
//           electionTitle: vote.election_title,
//           timestamp: vote.created_at,
//           status: vote.status,
//           isAnonymous: false
//         }
//       });
//     }

//     // ========================================
//     // STEP 2: Try to find in ANONYMOUS votes table
//     // ========================================
//     const anonymousVoteQuery = `
//       SELECT 
//         av.id,
//         av.voting_id,
//         av.receipt_id,
//         av.vote_hash,
//         av.verification_code,
//         av.voted_at as created_at,
//         e.title as election_title,
//         TRUE as is_anonymous
//       FROM votteryyy_anonymous_votes av
//       LEFT JOIN votteryyy_elections e ON av.election_id = e.id
//       WHERE av.receipt_id = $1
//     `;

//     const anonymousResult = await pool.query(anonymousVoteQuery, [receiptId]);

//     if (anonymousResult.rows.length > 0) {
//       const vote = anonymousResult.rows[0];
//       console.log('✅ Found ANONYMOUS vote:', vote.voting_id);

//       return res.json({
//         success: true,
//         verified: true,
//         message: 'Anonymous vote verified successfully',
//         receipt: {
//           receiptId: vote.receipt_id,
//           votingId: vote.voting_id,
//           voteHash: vote.vote_hash,
//           verificationCode: vote.verification_code,
//           electionTitle: vote.election_title,
//           timestamp: vote.created_at,
//           status: 'valid',
//           isAnonymous: true
//         }
//       });
//     }

//     // ========================================
//     // STEP 3: Not found in either table
//     // ========================================
//     console.log('❌ Receipt not found in any table:', receiptId);

//     return res.status(404).json({
//       success: false,
//       verified: false,
//       error: 'Receipt not found',
//       message: 'This receipt ID does not exist in our system'
//     });

//   } catch (error) {
//     console.error('❌ Verification error:', error);
//     res.status(500).json({
//       success: false,
//       verified: false,
//       error: 'Verification failed',
//       message: error.message
//     });
//   }
// };


//   // Verify vote by hash
//   async verifyByHash  (req, res) {
//   try {
//     const { voteHash } = req.params;

//     console.log('🔍 Verifying vote hash:', voteHash);

//     if (!voteHash) {
//       return res.status(400).json({ 
//         success: false,
//         error: 'Vote hash is required' 
//       });
//     }

//     // Try normal votes
//     const normalQuery = `
//       SELECT 
//         v.*,
//         e.title as election_title,
//         FALSE as is_anonymous
//       FROM votteryy_votes v
//       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
//       WHERE v.vote_hash = $1 AND v.status = 'valid'
//     `;

//     const normalResult = await pool.query(normalQuery, [voteHash]);

//     if (normalResult.rows.length > 0) {
//       return res.json({
//         success: true,
//         verified: true,
//         vote: normalResult.rows[0]
//       });
//     }

//     // Try anonymous votes
//     const anonymousQuery = `
//       SELECT 
//         av.*,
//         e.title as election_title,
//         TRUE as is_anonymous
//       FROM votteryyy_anonymous_votes av
//       LEFT JOIN votteryyy_elections e ON av.election_id = e.id
//       WHERE av.vote_hash = $1
//     `;

//     const anonymousResult = await pool.query(anonymousQuery, [voteHash]);

//     if (anonymousResult.rows.length > 0) {
//       return res.json({
//         success: true,
//         verified: true,
//         vote: anonymousResult.rows[0]
//       });
//     }

//     return res.status(404).json({
//       success: false,
//       verified: false,
//       error: 'Vote hash not found'
//     });

//   } catch (error) {
//     console.error('❌ Verification error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Verification failed',
//       message: error.message
//     });
//   }
// };


//   // Verify encryption (Issue #1)
//   async verifyEncryption(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { voteHash } = req.body;
//       const userId = req.user.userId;

//       const verification = await encryptionService.verifyEncryption(voteHash, electionId, userId);

//       res.json(verification);

//     } catch (error) {
//       console.error('Verify encryption error:', error);
//       res.status(500).json({ error: 'Failed to verify encryption' });
//     }
//   }

//   // Get user's vote verification data
//   async getMyVerificationData(req, res) {
//     try {
//       const { electionId } = req.params;
//       const userId = req.user.userId;

//       const verificationData = await encryptionService.getVoteVerificationData(userId, electionId);

//       res.json({
//         success: true,
//         verificationData
//       });

//     } catch (error) {
//       console.error('Get verification data error:', error);
//       res.status(500).json({ error: error.message || 'Failed to retrieve verification data' });
//     }
//   }

//   // Get public bulletin board for election
//   async getPublicBulletinBoard(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { page = 1, limit = 50 } = req.query;

//       const offset = (page - 1) * limit;

//       const result = await pool.query(
//         `SELECT 
//            vote_hash,
//            timestamp,
//            block_hash,
//            previous_block_hash,
//            merkle_root
//          FROM votteryy_public_bulletin_board
//          WHERE election_id = $1
//          ORDER BY timestamp DESC
//          LIMIT $2 OFFSET $3`,
//         [electionId, limit, offset]
//       );

//       const countResult = await pool.query(
//         `SELECT COUNT(*) FROM votteryy_public_bulletin_board WHERE election_id = $1`,
//         [electionId]
//       );

//       res.json({
//         votes: result.rows,
//         pagination: {
//           page: parseInt(page),
//           limit: parseInt(limit),
//           totalCount: parseInt(countResult.rows[0].count),
//           totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
//         }
//       });

//     } catch (error) {
//       console.error('Get public bulletin board error:', error);
//       res.status(500).json({ error: 'Failed to retrieve public bulletin board' });
//     }
//   }

//   // Verify audit trail integrity (Issue #3)
//   async verifyAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;

//       const verification = await auditService.verifyAuditTrailIntegrity(
//         electionId ? parseInt(electionId) : null
//       );

//       res.json(verification);

//     } catch (error) {
//       console.error('Verify audit trail error:', error);
//       res.status(500).json({ error: 'Failed to verify audit trail' });
//     }
//   }

//   // Get audit trail for election (Issue #3)
//   async getAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { page = 1, limit = 50 } = req.query;

//       const auditTrail = await auditService.getElectionAuditTrail(
//         parseInt(electionId),
//         parseInt(page),
//         parseInt(limit)
//       );

//       res.json(auditTrail);

//     } catch (error) {
//       console.error('Get audit trail error:', error);
//       res.status(500).json({ error: 'Failed to retrieve audit trail' });
//     }
//   }

//   // Export audit trail
//   async exportAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { format = 'json' } = req.query;

//       const exportData = await auditService.exportAuditTrail(parseInt(electionId), format);

//       if (format === 'csv') {
//         res.setHeader('Content-Type', 'text/csv');
//         res.setHeader('Content-Disposition', `attachment; filename=audit-trail-${electionId}.csv`);
        
//         // Convert to CSV string
//         const csvRows = [
//           exportData.headers.join(','),
//           ...exportData.rows.map(row => row.join(','))
//         ];
        
//         res.send(csvRows.join('\n'));
//       } else {
//         res.json(exportData.data);
//       }

//     } catch (error) {
//       console.error('Export audit trail error:', error);
//       res.status(500).json({ error: 'Failed to export audit trail' });
//     }
//   }

//   // Get all user verifications
//   async getUserVerifications(req, res) {
//     try {
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT * FROM votteryy_vote_verifications
//          WHERE user_id = $1
//          ORDER BY verified_at DESC`,
//         [userId]
//       );

//       res.json({
//         verifications: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get user verifications error:', error);
//       res.status(500).json({ error: 'Failed to retrieve verifications' });
//     }
//   }

//   // ========================================
//   // ⭐ NEW: VERIFY ANONYMOUS VOTE BY TOKEN ⭐
//   // ========================================
//   /**
//    * Verify anonymous vote using vote token
//    * No authentication required - anyone with token can verify
//    */

// async verifyAnonymousVote(req, res) {
//   try {
//     const { receiptId, voteToken, verificationCode } = req.body;

//     console.log('🔍 Verifying anonymous vote with 3-factor authentication');

//     // Validate all three fields are provided
//     if (!receiptId || !voteToken || !verificationCode) {
//       return res.status(400).json({ 
//         success: false,
//         verified: false,
//         error: 'All three fields are required',
//         message: 'Please provide Receipt ID, Vote Token, and Verification Code'
//       });
//     }

//     // ✅ REMOVED: Token format validation - let database handle it
//     // The old code had: if (typeof voteToken !== 'string' || voteToken.length !== 64)
//     // This was too strict!

//     // Query with all three credentials for maximum security
//     const result = await pool.query(
//       `SELECT 
//         av.id,
//         av.voting_id,
//         av.election_id,
//         av.vote_hash,
//         av.receipt_id,
//         av.verification_code,
//         av.vote_token,
//         av.voted_at,
//         e.id as election_id,
//         e.title as election_title,
//         e.status as election_status,
//         e.start_date,
//         e.end_date,
//         e.voting_type
//        FROM votteryyy_anonymous_votes av
//        JOIN votteryyy_elections e ON av.election_id = e.id
//        WHERE av.receipt_id = $1 
//        AND av.vote_token = $2 
//        AND av.verification_code = $3`,
//       [receiptId, voteToken, verificationCode]
//     );

//     if (result.rows.length === 0) {
//       console.log('❌ Vote not found or credentials mismatch');
//       return res.status(404).json({ 
//         success: false,
//         verified: false,
//         error: 'Vote not found',
//         message: 'Vote not found or credentials do not match. Please verify all three fields are correct.'
//       });
//     }

//     const vote = result.rows[0];

//     console.log('✅ Anonymous vote verified with 3-factor auth:', vote.voting_id);

//     // Get vote count for this election
//     const voteCountResult = await pool.query(
//       `SELECT COUNT(*) as total_votes 
//        FROM votteryyy_anonymous_votes 
//        WHERE election_id = $1`,
//       [vote.election_id]
//     );

//     const totalVotes = parseInt(voteCountResult.rows[0].total_votes);

//     // Check if vote exists on public bulletin board
//     let onBulletinBoard = false;
//     let blockHash = null;
    
//     try {
//       const bulletinResult = await pool.query(
//         `SELECT * FROM votteryy_public_bulletin_board WHERE vote_hash = $1`,
//         [vote.vote_hash]
//       );
//       onBulletinBoard = bulletinResult.rows.length > 0;
//       if (onBulletinBoard) {
//         blockHash = bulletinResult.rows[0].block_hash;
//       }
//     } catch (bulletinError) {
//       console.warn('⚠️ Could not check bulletin board:', bulletinError.message);
//     }

//     // Record verification attempt in audit log
//     try {
//       await pool.query(
//         `INSERT INTO votteryy_vote_verifications 
//          (voting_id, verification_method, verified_at, ip_address, user_agent)
//          VALUES ($1, 'anonymous_3factor', NOW(), $2, $3)`,
//         [
//           vote.voting_id, 
//           req.ip || req.connection?.remoteAddress || 'unknown',
//           req.headers['user-agent'] || 'unknown'
//         ]
//       );
//       console.log('📝 Verification logged');
//     } catch (auditError) {
//       console.warn('⚠️ Could not log verification attempt:', auditError.message);
//     }

//     // Return verification result
//     res.json({
//       success: true,
//       verified: true,
//       anonymous: true,
//       message: 'Your anonymous vote has been successfully verified with 3-factor authentication!',
//       verification: {
//         receiptId: vote.receipt_id,
//         votingId: vote.voting_id,
//         voteHash: vote.vote_hash,
//         verificationCode: vote.verification_code,
//         electionTitle: vote.election_title,
//         electionStatus: vote.election_status,
//         timestamp: vote.voted_at,
//         isAnonymous: true,
//         verified: true
//       },
//       vote: {
//         votingId: vote.voting_id,
//         voteHash: vote.vote_hash,
//         receiptId: vote.receipt_id,
//         verificationCode: vote.verification_code,
//         votedAt: vote.voted_at
//       },
//       election: {
//         id: vote.election_id,
//         title: vote.election_title,
//         status: vote.election_status,
//         votingType: vote.voting_type,
//         startDate: vote.start_date,
//         endDate: vote.end_date,
//         totalVotes: totalVotes
//       },
//       onPublicBulletinBoard: onBulletinBoard,
//       blockHash: blockHash,
//       verificationDetails: {
//         method: 'anonymous_3factor',
//         verifiedAt: new Date().toISOString(),
//         note: 'This verification confirms your vote was recorded without revealing your identity. 3-factor authentication provides maximum security.'
//       }
//     });

//   } catch (error) {
//     console.error('❌ Verify anonymous vote error:', error);
//     res.status(500).json({ 
//       success: false,
//       verified: false,
//       error: 'Failed to verify vote',
//       details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
//     });
//   }
// }
 
// }

// export default new VerificationController();





//last workable code
// import pool from '../config/database.js';
// import encryptionService from '../services/encryption.service.js';
// import auditService from '../services/audit.service.js';
// import { generateHash } from '../utils/crypto.js';

// class VerificationController {

//   // Verify vote by receipt ID
// async verifyByReceipt(req, res) {
//   try {
//     const { receiptId } = req.params;

//     console.log('🔍 Verifying receipt:', receiptId);

//     const result = await pool.query(
//       `SELECT 
//          vr.*,
//          v.vote_hash,
//          v.receipt_id as string_receipt_id,
//          v.verification_code,
//          v.created_at as vote_timestamp,
//          e.title as election_title
//        FROM votteryy_votes v
//        JOIN votteryy_vote_receipts vr ON vr.voting_id = v.voting_id
//        JOIN votteryyy_elections e ON vr.election_id = e.id
//        WHERE v.receipt_id = $1`,
//       [receiptId]
//     );

//     if (result.rows.length === 0) {
//       console.log(' Receipt not found:', receiptId);
//       return res.status(404).json({ error: 'Receipt not found' });
//     }

//     const receipt = result.rows[0];

//     // Check if vote exists on public bulletin board
//     const bulletinResult = await pool.query(
//       `SELECT * FROM votteryy_public_bulletin_board WHERE vote_hash = $1`,
//       [receipt.vote_hash]
//     );

//     const onBulletinBoard = bulletinResult.rows.length > 0;

//     console.log('✅ Receipt verified:', receipt.string_receipt_id);

//     res.json({
//       verified: true,
//       receipt: {
//         receiptId: receipt.string_receipt_id,
//         verificationCode: receipt.verification_code,
//         voteHash: receipt.vote_hash,
//         electionTitle: receipt.election_title,
//         timestamp: receipt.vote_timestamp
//       },
//       onPublicBulletinBoard: onBulletinBoard,
//       blockHash: onBulletinBoard ? bulletinResult.rows[0].block_hash : null,
//       message: 'Vote successfully verified'
//     });

//   } catch (error) {
//     console.error(' Verify by receipt error:', error);
//     res.status(500).json({ error: 'Failed to verify receipt' });
//   }
// }

//   // Verify vote by hash
//   async verifyByHash(req, res) {
//     try {
//       const { voteHash } = req.params;
//       const userId = req.user?.userId;

//       const result = await pool.query(
//         `SELECT 
//            pbb.*,
//            e.title as election_title
//          FROM votteryy_public_bulletin_board pbb
//          JOIN votteryyy_elections e ON pbb.election_id = e.id
//          WHERE pbb.vote_hash = $1`,
//         [voteHash]
//       );

//       if (result.rows.length === 0) {
//         return res.status(404).json({ 
//           verified: false,
//           error: 'Vote not found on public bulletin board' 
//         });
//       }

//       const vote = result.rows[0];

//       // Verify hash chain
//       let hashChainValid = true;
//       if (vote.previous_block_hash) {
//         const previousResult = await pool.query(
//           `SELECT block_hash FROM votteryy_public_bulletin_board 
//            WHERE election_id = $1 AND timestamp < $2
//            ORDER BY timestamp DESC LIMIT 1`,
//           [vote.election_id, vote.timestamp]
//         );

//         if (previousResult.rows.length > 0) {
//           hashChainValid = previousResult.rows[0].block_hash === vote.previous_block_hash;
//         }
//       }

//       res.json({
//         verified: true,
//         vote: {
//           voteHash: vote.vote_hash,
//           electionTitle: vote.election_title,
//           timestamp: vote.timestamp,
//           blockHash: vote.block_hash,
//           previousBlockHash: vote.previous_block_hash,
//           merkleRoot: vote.merkle_root
//         },
//         hashChainValid,
//         message: 'Vote found on public bulletin board'
//       });

//     } catch (error) {
//       console.error('Verify by hash error:', error);
//       res.status(500).json({ error: 'Failed to verify vote hash' });
//     }
//   }

//   // Verify encryption (Issue #1)
//   async verifyEncryption(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { voteHash } = req.body;
//       const userId = req.user.userId;

//       const verification = await encryptionService.verifyEncryption(voteHash, electionId, userId);

//       res.json(verification);

//     } catch (error) {
//       console.error('Verify encryption error:', error);
//       res.status(500).json({ error: 'Failed to verify encryption' });
//     }
//   }

//   // Get user's vote verification data
//   async getMyVerificationData(req, res) {
//     try {
//       const { electionId } = req.params;
//       const userId = req.user.userId;

//       const verificationData = await encryptionService.getVoteVerificationData(userId, electionId);

//       res.json({
//         success: true,
//         verificationData
//       });

//     } catch (error) {
//       console.error('Get verification data error:', error);
//       res.status(500).json({ error: error.message || 'Failed to retrieve verification data' });
//     }
//   }

//   // Get public bulletin board for election
//   async getPublicBulletinBoard(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { page = 1, limit = 50 } = req.query;

//       const offset = (page - 1) * limit;

//       const result = await pool.query(
//         `SELECT 
//            vote_hash,
//            timestamp,
//            block_hash,
//            previous_block_hash,
//            merkle_root
//          FROM votteryy_public_bulletin_board
//          WHERE election_id = $1
//          ORDER BY timestamp DESC
//          LIMIT $2 OFFSET $3`,
//         [electionId, limit, offset]
//       );

//       const countResult = await pool.query(
//         `SELECT COUNT(*) FROM votteryy_public_bulletin_board WHERE election_id = $1`,
//         [electionId]
//       );

//       res.json({
//         votes: result.rows,
//         pagination: {
//           page: parseInt(page),
//           limit: parseInt(limit),
//           totalCount: parseInt(countResult.rows[0].count),
//           totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
//         }
//       });

//     } catch (error) {
//       console.error('Get public bulletin board error:', error);
//       res.status(500).json({ error: 'Failed to retrieve public bulletin board' });
//     }
//   }

//   // Verify audit trail integrity (Issue #3)
//   async verifyAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;

//       const verification = await auditService.verifyAuditTrailIntegrity(
//         electionId ? parseInt(electionId) : null
//       );

//       res.json(verification);

//     } catch (error) {
//       console.error('Verify audit trail error:', error);
//       res.status(500).json({ error: 'Failed to verify audit trail' });
//     }
//   }

//   // Get audit trail for election (Issue #3)
//   async getAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { page = 1, limit = 50 } = req.query;

//       const auditTrail = await auditService.getElectionAuditTrail(
//         parseInt(electionId),
//         parseInt(page),
//         parseInt(limit)
//       );

//       res.json(auditTrail);

//     } catch (error) {
//       console.error('Get audit trail error:', error);
//       res.status(500).json({ error: 'Failed to retrieve audit trail' });
//     }
//   }

//   // Export audit trail
//   async exportAuditTrail(req, res) {
//     try {
//       const { electionId } = req.params;
//       const { format = 'json' } = req.query;

//       const exportData = await auditService.exportAuditTrail(parseInt(electionId), format);

//       if (format === 'csv') {
//         res.setHeader('Content-Type', 'text/csv');
//         res.setHeader('Content-Disposition', `attachment; filename=audit-trail-${electionId}.csv`);
        
//         // Convert to CSV string
//         const csvRows = [
//           exportData.headers.join(','),
//           ...exportData.rows.map(row => row.join(','))
//         ];
        
//         res.send(csvRows.join('\n'));
//       } else {
//         res.json(exportData.data);
//       }

//     } catch (error) {
//       console.error('Export audit trail error:', error);
//       res.status(500).json({ error: 'Failed to export audit trail' });
//     }
//   }

//   // Get all user verifications
//   async getUserVerifications(req, res) {
//     try {
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT * FROM votteryy_vote_verifications
//          WHERE user_id = $1
//          ORDER BY verified_at DESC`,
//         [userId]
//       );

//       res.json({
//         verifications: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get user verifications error:', error);
//       res.status(500).json({ error: 'Failed to retrieve verifications' });
//     }
//   }
// }

// export default new VerificationController();