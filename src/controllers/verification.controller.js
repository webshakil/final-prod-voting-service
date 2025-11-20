import pool from '../config/database.js';
import encryptionService from '../services/encryption.service.js';
import auditService from '../services/audit.service.js';
import { generateHash } from '../utils/crypto.js';

class VerificationController {

  // Verify vote by receipt ID
  async verifyByReceipt  (req, res)  {
  try {
    const { receiptId } = req.params;

    console.log('🔍 Verifying receipt:', receiptId);

    if (!receiptId) {
      return res.status(400).json({ 
        success: false,
        error: 'Receipt ID is required' 
      });
    }

    // ========================================
    // STEP 1: Try to find in NORMAL votes table
    // ========================================
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

    // ========================================
    // STEP 2: Try to find in ANONYMOUS votes table
    // ========================================
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

    // ========================================
    // STEP 3: Not found in either table
    // ========================================
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
};
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
  //       console.log('❌ Receipt not found:', receiptId);
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
  //     console.error('❌ Verify by receipt error:', error);
  //     res.status(500).json({ error: 'Failed to verify receipt' });
  //   }
  // }

  // Verify vote by hash
  async verifyByHash  (req, res) {
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
};
  // async verifyByHash(req, res) {
  //   try {
  //     const { voteHash } = req.params;
  //     const userId = req.user?.userId;

  //     const result = await pool.query(
  //       `SELECT 
  //          pbb.*,
  //          e.title as election_title
  //        FROM votteryy_public_bulletin_board pbb
  //        JOIN votteryyy_elections e ON pbb.election_id = e.id
  //        WHERE pbb.vote_hash = $1`,
  //       [voteHash]
  //     );

  //     if (result.rows.length === 0) {
  //       return res.status(404).json({ 
  //         verified: false,
  //         error: 'Vote not found on public bulletin board' 
  //       });
  //     }

  //     const vote = result.rows[0];

  //     // Verify hash chain
  //     let hashChainValid = true;
  //     if (vote.previous_block_hash) {
  //       const previousResult = await pool.query(
  //         `SELECT block_hash FROM votteryy_public_bulletin_board 
  //          WHERE election_id = $1 AND timestamp < $2
  //          ORDER BY timestamp DESC LIMIT 1`,
  //         [vote.election_id, vote.timestamp]
  //       );

  //       if (previousResult.rows.length > 0) {
  //         hashChainValid = previousResult.rows[0].block_hash === vote.previous_block_hash;
  //       }
  //     }

  //     res.json({
  //       verified: true,
  //       vote: {
  //         voteHash: vote.vote_hash,
  //         electionTitle: vote.election_title,
  //         timestamp: vote.timestamp,
  //         blockHash: vote.block_hash,
  //         previousBlockHash: vote.previous_block_hash,
  //         merkleRoot: vote.merkle_root
  //       },
  //       hashChainValid,
  //       message: 'Vote found on public bulletin board'
  //     });

  //   } catch (error) {
  //     console.error('Verify by hash error:', error);
  //     res.status(500).json({ error: 'Failed to verify vote hash' });
  //   }
  // }

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

  // ========================================
  // ⭐ NEW: VERIFY ANONYMOUS VOTE BY TOKEN ⭐
  // ========================================
  /**
   * Verify anonymous vote using vote token
   * No authentication required - anyone with token can verify
   */

async verifyAnonymousVote(req, res) {
  try {
    const { receiptId, voteToken, verificationCode } = req.body;

    console.log('🔍 Verifying anonymous vote with 3-factor authentication');

    // Validate all three fields are provided
    if (!receiptId || !voteToken || !verificationCode) {
      return res.status(400).json({ 
        success: false,
        verified: false,
        error: 'All three fields are required',
        message: 'Please provide Receipt ID, Vote Token, and Verification Code'
      });
    }

    // ✅ REMOVED: Token format validation - let database handle it
    // The old code had: if (typeof voteToken !== 'string' || voteToken.length !== 64)
    // This was too strict!

    // Query with all three credentials for maximum security
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

    // Get vote count for this election
    const voteCountResult = await pool.query(
      `SELECT COUNT(*) as total_votes 
       FROM votteryyy_anonymous_votes 
       WHERE election_id = $1`,
      [vote.election_id]
    );

    const totalVotes = parseInt(voteCountResult.rows[0].total_votes);

    // Check if vote exists on public bulletin board
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

    // Record verification attempt in audit log
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

    // Return verification result
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
  // async verifyAnonymousVote(req, res) {
  //   try {
  //     const { voteToken } = req.body;

  //     console.log('🔍 Verifying anonymous vote with token:', voteToken?.substring(0, 16) + '...');

  //     // Validate input
  //     if (!voteToken || typeof voteToken !== 'string' || voteToken.length !== 64) {
  //       console.log('❌ Invalid token format');
  //       return res.status(400).json({ 
  //         verified: false,
  //         error: 'Invalid vote token format. Token must be a 64-character hexadecimal string.' 
  //       });
  //     }

  //     // Query anonymous votes table
  //     const result = await pool.query(
  //       `SELECT 
  //         av.id,
  //         av.voting_id,
  //         av.election_id,
  //         av.vote_hash,
  //         av.receipt_id,
  //         av.verification_code,
  //         av.voted_at,
  //         e.id as election_id,
  //         e.title as election_title,
  //         e.status as election_status,
  //         e.start_date,
  //         e.end_date,
  //         e.voting_type
  //        FROM votteryyy_anonymous_votes av
  //        JOIN votteryyy_elections e ON av.election_id = e.id
  //        WHERE av.vote_token = $1`,
  //       [voteToken]
  //     );

  //     if (result.rows.length === 0) {
  //       console.log('❌ Vote token not found');
  //       return res.status(404).json({ 
  //         verified: false,
  //         error: 'Vote not found. Invalid token or vote does not exist.',
  //         message: 'Please check your vote token and try again.'
  //       });
  //     }

  //     const vote = result.rows[0];

  //     console.log('✅ Anonymous vote verified:', vote.voting_id);

  //     // Get vote count for this election (for transparency)
  //     const voteCountResult = await pool.query(
  //       `SELECT COUNT(*) as total_votes 
  //        FROM votteryyy_anonymous_votes 
  //        WHERE election_id = $1`,
  //       [vote.election_id]
  //     );

  //     const totalVotes = parseInt(voteCountResult.rows[0].total_votes);

  //     // Check if vote exists on public bulletin board
  //     const bulletinResult = await pool.query(
  //       `SELECT * FROM votteryy_public_bulletin_board WHERE vote_hash = $1`,
  //       [vote.vote_hash]
  //     );

  //     const onBulletinBoard = bulletinResult.rows.length > 0;

  //     // Record verification attempt in audit log (optional)
  //     try {
  //       await pool.query(
  //         `INSERT INTO votteryy_vote_verifications 
  //          (voting_id, verification_method, verified_at, ip_address, user_agent)
  //          VALUES ($1, 'anonymous_token', NOW(), $2, $3)`,
  //         [
  //           vote.voting_id, 
  //           req.ip || req.connection?.remoteAddress || 'unknown',
  //           req.headers['user-agent'] || 'unknown'
  //         ]
  //       );
  //       console.log('📝 Verification logged');
  //     } catch (auditError) {
  //       console.warn('⚠️ Could not log verification attempt:', auditError.message);
  //       // Don't fail verification if audit logging fails
  //     }

  //     // Return verification result
  //     res.json({
  //       verified: true,
  //       anonymous: true,
  //       message: 'Your anonymous vote has been successfully verified!',
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
  //       blockHash: onBulletinBoard ? bulletinResult.rows[0].block_hash : null,
  //       verificationDetails: {
  //         method: 'anonymous_token',
  //         verifiedAt: new Date().toISOString(),
  //         note: 'This verification confirms your vote was recorded without revealing your identity.'
  //       }
  //     });

  //   } catch (error) {
  //     console.error('❌ Verify anonymous vote error:', error);
  //     res.status(500).json({ 
  //       verified: false,
  //       error: 'Failed to verify vote',
  //       details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
  //     });
  //   }
  // }
}

export default new VerificationController();
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