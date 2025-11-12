// src/controllers/voting.controller.js
// ✨ COMPLETE VERSION - All vote-related operations - FULLY FIXED
import pool from '../config/database.js';
import crypto from 'crypto';
import { 
  encryptVote, 
  generateVoteHash, 
  generateReceiptId, 
  generateVerificationCode 
} from '../services/encryption.service.js';
import AuditService from '../services/audit.service.js';
import NotificationService from '../services/notification.service.js';

// ========================================
// GET BALLOT
// ========================================
export const getBallot = async (req, res) => {
  try {
    const { electionId } = req.params;
    const userId = req.user?.userId || req.headers['x-user-id'];

    console.log('🗳️ Getting ballot for election:', electionId, 'user:', userId);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get election details
    const electionResult = await pool.query(
      `SELECT * FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];

    //  FIX: Debug election dates
    console.log('📅 Election dates raw:', {
      start_date: election.start_date,
      start_time: election.start_time,
      end_date: election.end_date,
      end_time: election.end_time,
      start_date_type: typeof election.start_date,
    });

    //  FIX: Handle date/time properly with PostgreSQL timestamp format
    const now = new Date();
    let startDateTime, endDateTime;
    
    try {
      // PostgreSQL returns Date objects, so we need to handle them properly
      if (election.start_date instanceof Date) {
        startDateTime = new Date(election.start_date);
        if (election.start_time) {
          const [hours, minutes, seconds] = election.start_time.split(':');
          startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
        }
      } else {
        // Fallback for string dates
        const startTime = election.start_time || '00:00:00';
        startDateTime = new Date(`${election.start_date}T${startTime}`);
      }

      if (election.end_date instanceof Date) {
        endDateTime = new Date(election.end_date);
        if (election.end_time) {
          const [hours, minutes, seconds] = election.end_time.split(':');
          endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
        }
      } else {
        // Fallback for string dates
        const endTime = election.end_time || '23:59:59';
        endDateTime = new Date(`${election.end_date}T${endTime}`);
      }
      
      // Validate dates
      if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (dateError) {
      console.error('❌ Date parsing error:', dateError);
      return res.status(500).json({ 
        error: 'Invalid election dates',
        details: 'The election has invalid date configuration'
      });
    }

    console.log('📅 Election timing:', {
      now: now.toISOString(),
      start: startDateTime.toISOString(),
      end: endDateTime.toISOString(),
      status: election.status,
    });

    // ✅ Check status is 'published' or 'active'
    const allowedStatuses = ['published', 'active'];
    
    if (!allowedStatuses.includes(election.status)) {
      return res.status(400).json({ 
        error: 'Election is not currently active',
        status: election.status,
        message: `Election status is "${election.status}". Must be "published" or "active".`
      });
    }

    // ✅ Check date range
    if (now < startDateTime) {
      return res.status(400).json({ 
        error: 'Election has not started yet',
        startDate: startDateTime.toISOString(),
        message: `Election starts on ${startDateTime.toLocaleString()}`
      });
    }

    if (now > endDateTime) {
      return res.status(400).json({ 
        error: 'Election has ended',
        endDate: endDateTime.toISOString(),
        message: `Election ended on ${endDateTime.toLocaleString()}`
      });
    }

    console.log('✅ Election is active and within date range');

    //  FIXED: Get questions from YOUR tables (votteryy_election_questions)
    const questionsResult = await pool.query(
      `SELECT 
        q.*,
        COALESCE(
          json_agg(
            json_build_object(
              'id', o.id,
              'option_text', o.option_text,
              'option_image_url', o.option_image_url,
              'option_order', o.option_order
            )
            ORDER BY o.option_order
          ) FILTER (WHERE o.id IS NOT NULL),
          '[]'
        ) as options
       FROM votteryy_election_questions q
       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
       WHERE q.election_id = $1
       GROUP BY q.id
       ORDER BY q.id`,
      [electionId]
    );

    if (questionsResult.rows.length === 0) {
      return res.status(400).json({ 
        error: 'No questions found for this election',
        message: 'The election ballot has not been configured yet.'
      });
    }

    // Check if user has already voted
    const voteCheck = await pool.query(
      `SELECT id, voting_id, vote_hash, receipt_id FROM votteryy_votes 
       WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
      [electionId, userId]
    );

    const hasVoted = voteCheck.rows.length > 0;

    // Get video watch progress if video is required
    let videoProgress = null;
    if (election.video_watch_required) {
      const videoResult = await pool.query(
        `SELECT completed, watch_percentage FROM votteryy_video_watch_progress
         WHERE user_id = $1 AND election_id = $2`,
        [userId, electionId]
      );
      videoProgress = videoResult.rows[0] || { completed: false, watch_percentage: 0 };
    }

    // Format dates for response
    const formatDate = (date) => {
      if (date instanceof Date) {
        return date.toISOString().split('T')[0];
      }
      return date;
    };

    const formatTime = (time) => {
      if (!time) return null;
      if (typeof time === 'string') return time;
      return time.toString();
    };

    // Prepare ballot response
    const ballot = {
      election: {
        id: election.id,
        title: election.title,
        description: election.description,
        startDate: formatDate(election.start_date),
        startTime: formatTime(election.start_time),
        endDate: formatDate(election.end_date),
        endTime: formatTime(election.end_time),
        status: election.status,
        videoUrl: election.topic_video_url || election.video_url,
      },
      votingType: election.voting_type || 'plurality',
      questions: questionsResult.rows,
      hasVoted,
      votingId: hasVoted ? voteCheck.rows[0].voting_id : null,
      voteHash: hasVoted ? voteCheck.rows[0].vote_hash : null,
      receiptId: hasVoted ? voteCheck.rows[0].receipt_id : null,
      voteEditingAllowed: election.vote_editing_allowed || false,
      anonymousVotingEnabled: election.anonymous_voting_enabled || false,
      liveResults: election.show_live_results || false,
      videoWatchRequired: election.video_watch_required || false,
      videoProgress: videoProgress,
      minimumWatchPercentage: parseFloat(election.minimum_watch_percentage) || 0,
      lotteryEnabled: election.lottery_enabled || false,
      paymentRequired: !election.is_free,
      participationFee: parseFloat(election.general_participation_fee) || 0,
    };

    console.log('✅ Ballot prepared:', {
      questionCount: ballot.questions.length,
      hasVoted,
      votingType: ballot.votingType,
    });

    res.json(ballot);

  } catch (error) {
    console.error('❌ Get ballot error:', error);
    res.status(500).json({ 
      error: 'Failed to get ballot',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ========================================
// CAST VOTE
// ========================================
export const castVote = async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { electionId } = req.params;
    const { answers, anonymous = false } = req.body;
    const userId = req.user?.userId || req.headers['x-user-id'];

    console.log('🗳️ Casting vote:', { electionId, userId, anonymous, answersCount: Object.keys(answers || {}).length });

    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!answers || Object.keys(answers).length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No answers provided' });
    }

    // Get election
    const electionResult = await client.query(
      `SELECT * FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];

    // Check if election is active
    const now = new Date();
    let startDateTime, endDateTime;
    
    try {
      if (election.start_date instanceof Date) {
        startDateTime = new Date(election.start_date);
        if (election.start_time) {
          const [hours, minutes, seconds] = election.start_time.split(':');
          startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
        }
      } else {
        const startTime = election.start_time || '00:00:00';
        startDateTime = new Date(`${election.start_date}T${startTime}`);
      }

      if (election.end_date instanceof Date) {
        endDateTime = new Date(election.end_date);
        if (election.end_time) {
          const [hours, minutes, seconds] = election.end_time.split(':');
          endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
        }
      } else {
        const endTime = election.end_time || '23:59:59';
        endDateTime = new Date(`${election.end_date}T${endTime}`);
      }
    } catch (dateError) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Invalid election dates' });
    }

    const allowedStatuses = ['published', 'active'];

    if (!allowedStatuses.includes(election.status) || now < startDateTime || now > endDateTime) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Election is not currently active' });
    }

    // Check if already voted
    const existingVote = await client.query(
      `SELECT id, voting_id FROM votteryy_votes WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
      [electionId, userId]
    );

    if (existingVote.rows.length > 0 && !election.vote_editing_allowed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You have already voted in this election' });
    }

    // Prepare vote data
    const voteData = {
      electionId,
      userId,
      answers,
      timestamp: new Date().toISOString(),
    };

    const encryptedVote = encryptVote(JSON.stringify(voteData));
    const voteHash = generateVoteHash(encryptedVote);
    const receiptId = generateReceiptId();
    const verificationCode = generateVerificationCode();

    // Insert or update vote
    let voteId, votingUuid;
    
    if (existingVote.rows.length > 0) {
      // Update existing vote
      const updateResult = await client.query(
        `UPDATE votteryy_votes 
         SET 
           answers = $1,
           encrypted_vote = $2, 
           vote_hash = $3,
           is_edited = true,
           updated_at = NOW()
         WHERE id = $4
         RETURNING id, voting_id`,
        [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
      );
      voteId = updateResult.rows[0].id;
      votingUuid = updateResult.rows[0].voting_id;
      console.log('✅ Vote updated:', voteId, 'UUID:', votingUuid);
    } else {
      // Insert new vote
      const voteResult = await client.query(
        `INSERT INTO votteryy_votes 
         (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
         RETURNING id, voting_id`,
        [
          electionId,
          String(userId),
          JSON.stringify(answers),
          encryptedVote,
          voteHash,
          receiptId,
          verificationCode,
          anonymous,
          req.ip || req.connection.remoteAddress,
          req.headers['user-agent'],
        ]
      );
      voteId = voteResult.rows[0].id;
      votingUuid = voteResult.rows[0].voting_id;
      console.log('✅ Vote inserted:', voteId, 'UUID:', votingUuid);

      // ✅ INSERT INTO votteryy_vote_receipts
      await client.query(
        `INSERT INTO votteryy_vote_receipts 
         (voting_id, election_id, user_id, verification_code, vote_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [votingUuid, electionId, String(userId), verificationCode, voteHash]
      );
      console.log('✅ Receipt created for voting_id:', votingUuid);
    }

    // Create lottery ticket if lottery is enabled
    if (election.lottery_enabled) {
      const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
      const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

      await client.query(
        `INSERT INTO votteryy_lottery_tickets 
         (user_id, election_id, voting_id, ball_number, ticket_number)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, election_id) DO NOTHING`,
        [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
      );
      console.log('🎰 Lottery ticket created:', ticketNumber, 'for voting UUID:', votingUuid);
    }

    // Record audit event
    try {
      await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
      console.log('📝 Audit event logged');
    } catch (auditError) {
      console.warn('⚠️ Failed to log audit event:', auditError.message);
    }

    // Commit transaction
    await client.query('COMMIT');
    console.log('✅ Transaction committed');

    // Send notification email (after commit)
    setImmediate(async () => {
      try {
        const userResult = await pool.query(
          `SELECT u.email, ud.full_name 
           FROM votteryy_users u
           LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
           WHERE u.id = $1`,
          [userId]
        );
        
        if (userResult.rows.length > 0 && userResult.rows[0].email) {
          await NotificationService.sendVoteConfirmation(
            userResult.rows[0].email,
            election.title,
            receiptId,
            voteHash
          );
          console.log('📧 Confirmation email sent to:', userResult.rows[0].email);
        }
      } catch (notifError) {
        console.warn('⚠️ Failed to send notification:', notifError.message);
      }
    });

    console.log('✅ Vote cast successfully:', { votingId: voteId, votingUuid, receiptId, verificationCode });

    // Return success response
    res.json({
      success: true,
      votingId: votingUuid,
      voteHash,
      receiptId,
      verificationCode,
      message: 'Vote cast successfully',
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Cast vote error:', error);
    res.status(500).json({ 
      error: 'Failed to cast vote',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
};

// ========================================
//  NEW: GET VIDEO WATCH PROGRESS
// ========================================
export const getVideoProgress = async (req, res) => {
  try {
    const { electionId } = req.params;
    const userId = String(req.user?.userId || req.headers['x-user-id']); //  Convert to string

    console.log('📹 GET VIDEO PROGRESS:', { userId, electionId });

    if (!userId || userId === 'undefined') {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const result = await pool.query(
      `SELECT * FROM votteryy_video_watch_progress 
       WHERE user_id = $1 AND election_id = $2`,
      [userId, electionId]
    );

    console.log('📹 Found video progress:', result.rows[0] || 'NONE');

    if (result.rows.length === 0) {
      return res.json({
        completed: false,
        watch_percentage: 0,
        last_position: 0,
        total_duration: 0,
      });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error('Get video progress error:', error);
    res.status(500).json({ error: 'Failed to get video progress' });
  }
};


// ========================================
// UPDATE VIDEO WATCH PROGRESS
// ========================================
export const updateVideoProgress = async (req, res) => {
  try {
    const { electionId } = req.params;
    const { watchPercentage, lastPosition, totalDuration, completed } = req.body;
    const userId = String(req.user?.userId || req.headers['x-user-id']); //  Convert to string

    console.log('📹 UPDATE VIDEO PROGRESS:', {
      userId,
      electionId,
      watchPercentage,
      lastPosition,
      totalDuration,
      completed,
    });

    if (!userId || userId === 'undefined') {
      console.log('❌ No userId found');
      return res.status(401).json({ error: 'Authentication required' });
    }

    const watchPercentageInt = Math.round(watchPercentage);
    const lastPositionInt = Math.round(lastPosition);
    const totalDurationInt = Math.round(totalDuration);

    console.log('💾 Saving to database:', {
      userId,
      electionId,
      watchPercentageInt,
      lastPositionInt,
      totalDurationInt,
      completed: completed || false,
    });

    const result = await pool.query(
      `INSERT INTO votteryy_video_watch_progress 
       (user_id, election_id, watch_percentage, last_position, total_duration, completed, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, election_id)
       DO UPDATE SET 
         watch_percentage = $3,
         last_position = $4,
         total_duration = $5,
         completed = $6,
         completed_at = CASE WHEN $6 = TRUE THEN NOW() ELSE votteryy_video_watch_progress.completed_at END,
         updated_at = NOW()
       RETURNING *`,
      [userId, electionId, watchPercentageInt, lastPositionInt, totalDurationInt, completed || false, completed ? new Date() : null]
    );

    console.log('✅ Saved to database:', result.rows[0]);

    res.json({ 
      success: true,
      watchPercentage: watchPercentageInt,
      completed: completed || false,
      data: result.rows[0],
    });

  } catch (error) {
    console.error('❌ Update video progress error:', error);
    res.status(500).json({ error: 'Failed to update video progress', details: error.message });
  }
};


// ========================================
// RECORD ABSTENTION
// ========================================
export const recordAbstention = async (req, res) => {
  try {
    const { electionId } = req.params;
    const { questionId, reason } = req.body;
    const userId = req.user?.userId || req.headers['x-user-id'];

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!questionId || !reason) {
      return res.status(400).json({ error: 'Question ID and reason are required' });
    }

    await pool.query(
      `INSERT INTO votteryy_abstentions (user_id, election_id, question_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [userId, electionId, questionId, reason]
    );

    res.json({ 
      success: true,
      message: 'Abstention recorded',
    });

  } catch (error) {
    console.error('Record abstention error:', error);
    res.status(500).json({ error: 'Failed to record abstention' });
  }
};

// ========================================
// GET USER'S VOTE
// ========================================
export const getUserVote = async (req, res) => {
  try {
    const { electionId } = req.params;
    const userId = req.user?.userId || req.headers['x-user-id'];

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const voteResult = await pool.query(
      `SELECT * FROM votteryy_votes
       WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
      [electionId, userId]
    );

    if (voteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Vote not found' });
    }

    res.json(voteResult.rows[0]);

  } catch (error) {
    console.error('Get user vote error:', error);
    res.status(500).json({ error: 'Failed to get vote' });
  }
};

// ========================================
// GET VOTING HISTORY
// ========================================
export const getVotingHistory = async (req, res) => {
  try {
    const userId = req.user?.userId || req.headers['x-user-id'];
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    console.log('📜 Getting voting history for user:', userId);

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM votteryy_votes
      WHERE user_id = $1 AND status = 'valid'
    `;
    const countResult = await pool.query(countQuery, [String(userId)]);
    const total = parseInt(countResult.rows[0].total);

    // Get votes with election details and lottery info
    const query = `
      SELECT 
        v.id,
        v.voting_id,
        v.election_id,
        v.user_id,
        v.receipt_id,
        v.vote_hash,
        v.status,
        v.created_at,
        v.anonymous,
        e.title as election_title,
        e.status as election_status,
        e.is_free,
        e.general_participation_fee,
        e.lottery_enabled,
        lt.ball_number,
        lt.ticket_number as lottery_ticket_number,
        lt.ticket_id,
        CASE 
          WHEN e.status = 'completed' THEN 'Draw Completed'
          WHEN e.status = 'active' OR e.status = 'published' THEN 'Pending Draw'
          ELSE 'Pending Draw'
        END as lottery_status,
        CASE 
          WHEN e.is_free = false THEN e.general_participation_fee
          ELSE 0
        END as payment_amount,
        'USD' as payment_currency
      FROM votteryy_votes v
      LEFT JOIN votteryyy_elections e ON v.election_id = e.id
      LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
      WHERE v.user_id = $1 AND v.status = 'valid'
      ORDER BY v.created_at DESC
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [String(userId), limit, offset]);

    console.log('✅ Found', result.rows.length, 'votes for user');

    res.status(200).json({
      success: true,
      data: {
        votes: result.rows,
        pagination: {
          currentPage: page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('❌ Error fetching voting history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch voting history',
      error: error.message
    });
  }
};

export default {
  getBallot,
  castVote,
  getVideoProgress, 
  updateVideoProgress,
  recordAbstention,
  getUserVote,
  getVotingHistory
};
//last working code
// // src/controllers/voting.controller.js
// // ✨ COMPLETE VERSION - All vote-related operations - FULLY FIXED
// import pool from '../config/database.js';
// import crypto from 'crypto';
// import { 
//   encryptVote, 
//   generateVoteHash, 
//   generateReceiptId, 
//   generateVerificationCode 
// } from '../services/encryption.service.js';
// import AuditService from '../services/audit.service.js';
// import NotificationService from '../services/notification.service.js';

// // ========================================
// // GET BALLOT
// // ========================================
// export const getBallot = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     console.log('🗳️ Getting ballot for election:', electionId, 'user:', userId);

//     if (!userId) {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     // Get election details
//     const electionResult = await pool.query(
//       `SELECT * FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];

//     //  FIX: Debug election dates
//     console.log(' Election dates raw:', {
//       start_date: election.start_date,
//       start_time: election.start_time,
//       end_date: election.end_date,
//       end_time: election.end_time,
//       start_date_type: typeof election.start_date,
//     });

//     //  FIX: Handle date/time properly with PostgreSQL timestamp format
//     const now = new Date();
//     let startDateTime, endDateTime;
    
//     try {
//       // PostgreSQL returns Date objects, so we need to handle them properly
//       if (election.start_date instanceof Date) {
//         startDateTime = new Date(election.start_date);
//         if (election.start_time) {
//           const [hours, minutes, seconds] = election.start_time.split(':');
//           startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
//         }
//       } else {
//         // Fallback for string dates
//         const startTime = election.start_time || '00:00:00';
//         startDateTime = new Date(`${election.start_date}T${startTime}`);
//       }

//       if (election.end_date instanceof Date) {
//         endDateTime = new Date(election.end_date);
//         if (election.end_time) {
//           const [hours, minutes, seconds] = election.end_time.split(':');
//           endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
//         }
//       } else {
//         // Fallback for string dates
//         const endTime = election.end_time || '23:59:59';
//         endDateTime = new Date(`${election.end_date}T${endTime}`);
//       }
      
//       // Validate dates
//       if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
//         throw new Error('Invalid date format');
//       }
//     } catch (dateError) {
//       console.error('❌ Date parsing error:', dateError);
//       return res.status(500).json({ 
//         error: 'Invalid election dates',
//         details: 'The election has invalid date configuration'
//       });
//     }

//     console.log('📅 Election timing:', {
//       now: now.toISOString(),
//       start: startDateTime.toISOString(),
//       end: endDateTime.toISOString(),
//       status: election.status,
//     });

//     // ✅ Check status is 'published' or 'active'
//     const allowedStatuses = ['published', 'active'];
    
//     if (!allowedStatuses.includes(election.status)) {
//       return res.status(400).json({ 
//         error: 'Election is not currently active',
//         status: election.status,
//         message: `Election status is "${election.status}". Must be "published" or "active".`
//       });
//     }

//     // ✅ Check date range
//     if (now < startDateTime) {
//       return res.status(400).json({ 
//         error: 'Election has not started yet',
//         startDate: startDateTime.toISOString(),
//         message: `Election starts on ${startDateTime.toLocaleString()}`
//       });
//     }

//     if (now > endDateTime) {
//       return res.status(400).json({ 
//         error: 'Election has ended',
//         endDate: endDateTime.toISOString(),
//         message: `Election ended on ${endDateTime.toLocaleString()}`
//       });
//     }

//     console.log(' Election is active and within date range');

//     //  FIXED: Get questions from YOUR tables (votteryy_election_questions)
//     const questionsResult = await pool.query(
//       `SELECT 
//         q.*,
//         COALESCE(
//           json_agg(
//             json_build_object(
//               'id', o.id,
//               'option_text', o.option_text,
//               'option_image_url', o.option_image_url,
//               'option_order', o.option_order
//             )
//             ORDER BY o.option_order
//           ) FILTER (WHERE o.id IS NOT NULL),
//           '[]'
//         ) as options
//        FROM votteryy_election_questions q
//        LEFT JOIN votteryy_election_options o ON q.id = o.question_id
//        WHERE q.election_id = $1
//        GROUP BY q.id
//        ORDER BY q.id`,
//       [electionId]
//     );

//     if (questionsResult.rows.length === 0) {
//       return res.status(400).json({ 
//         error: 'No questions found for this election',
//         message: 'The election ballot has not been configured yet.'
//       });
//     }

//     // Check if user has already voted
//     const voteCheck = await pool.query(
//       `SELECT id, voting_id, vote_hash, receipt_id FROM votteryy_votes 
//        WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
//       [electionId, userId]
//     );

//     const hasVoted = voteCheck.rows.length > 0;

//     // Get video watch progress if video is required
//     let videoProgress = null;
//     if (election.video_watch_required) {
//       const videoResult = await pool.query(
//         `SELECT completed, watch_percentage FROM votteryy_video_watch_progress
//          WHERE user_id = $1 AND election_id = $2`,
//         [userId, electionId]
//       );
//       videoProgress = videoResult.rows[0] || { completed: false, watch_percentage: 0 };
//     }

//     // Format dates for response
//     const formatDate = (date) => {
//       if (date instanceof Date) {
//         return date.toISOString().split('T')[0];
//       }
//       return date;
//     };

//     const formatTime = (time) => {
//       if (!time) return null;
//       if (typeof time === 'string') return time;
//       return time.toString();
//     };

//     // Prepare ballot response
//     const ballot = {
//       election: {
//         id: election.id,
//         title: election.title,
//         description: election.description,
//         startDate: formatDate(election.start_date),
//         startTime: formatTime(election.start_time),
//         endDate: formatDate(election.end_date),
//         endTime: formatTime(election.end_time),
//         status: election.status,
//         videoUrl: election.topic_video_url || election.video_url,
//       },
//       votingType: election.voting_type || 'plurality',
//       questions: questionsResult.rows,
//       hasVoted,
//       votingId: hasVoted ? voteCheck.rows[0].voting_id : null,
//       voteHash: hasVoted ? voteCheck.rows[0].vote_hash : null,
//       receiptId: hasVoted ? voteCheck.rows[0].receipt_id : null,
//       voteEditingAllowed: election.vote_editing_allowed || false,
//       anonymousVotingEnabled: election.anonymous_voting_enabled || false,
//       liveResults: election.show_live_results || false,
//       videoWatchRequired: election.video_watch_required || false,
//       videoProgress: videoProgress,
//       minimumWatchPercentage: parseFloat(election.minimum_watch_percentage) || 0,
//       lotteryEnabled: election.lottery_enabled || false,
//       paymentRequired: !election.is_free,
//       participationFee: parseFloat(election.general_participation_fee) || 0,
//     };

//     console.log('✅ Ballot prepared:', {
//       questionCount: ballot.questions.length,
//       hasVoted,
//       votingType: ballot.votingType,
//     });

//     res.json(ballot);

//   } catch (error) {
//     console.error('❌ Get ballot error:', error);
//     res.status(500).json({ 
//       error: 'Failed to get ballot',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// };

// // ========================================
// // CAST VOTE
// // ========================================
// export const castVote = async (req, res) => {
//   const client = await pool.connect();
  
//   try {
//     await client.query('BEGIN');

//     const { electionId } = req.params;
//     const { answers, anonymous = false } = req.body;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     console.log(' Casting vote:', { electionId, userId, anonymous, answersCount: Object.keys(answers || {}).length });

//     if (!userId) {
//       await client.query('ROLLBACK');
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     if (!answers || Object.keys(answers).length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ error: 'No answers provided' });
//     }

//     // Get election
//     const electionResult = await client.query(
//       `SELECT * FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];

//     // Check if election is active
//     const now = new Date();
//     let startDateTime, endDateTime;
    
//     try {
//       if (election.start_date instanceof Date) {
//         startDateTime = new Date(election.start_date);
//         if (election.start_time) {
//           const [hours, minutes, seconds] = election.start_time.split(':');
//           startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
//         }
//       } else {
//         const startTime = election.start_time || '00:00:00';
//         startDateTime = new Date(`${election.start_date}T${startTime}`);
//       }

//       if (election.end_date instanceof Date) {
//         endDateTime = new Date(election.end_date);
//         if (election.end_time) {
//           const [hours, minutes, seconds] = election.end_time.split(':');
//           endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
//         }
//       } else {
//         const endTime = election.end_time || '23:59:59';
//         endDateTime = new Date(`${election.end_date}T${endTime}`);
//       }
//     } catch (dateError) {
//       await client.query('ROLLBACK');
//       return res.status(500).json({ error: 'Invalid election dates' });
//     }

//     const allowedStatuses = ['published', 'active'];

//     if (!allowedStatuses.includes(election.status) || now < startDateTime || now > endDateTime) {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ error: 'Election is not currently active' });
//     }

//     // Check if already voted
//     const existingVote = await client.query(
//       `SELECT id, voting_id FROM votteryy_votes WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
//       [electionId, userId]
//     );

//     if (existingVote.rows.length > 0 && !election.vote_editing_allowed) {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ error: 'You have already voted in this election' });
//     }

//     // Prepare vote data
//     const voteData = {
//       electionId,
//       userId,
//       answers,
//       timestamp: new Date().toISOString(),
//     };

//     const encryptedVote = encryptVote(JSON.stringify(voteData));
//     const voteHash = generateVoteHash(encryptedVote);
//     const receiptId = generateReceiptId();
//     const verificationCode = generateVerificationCode();

//     // Insert or update vote
//     let voteId, votingUuid;
    
//     if (existingVote.rows.length > 0) {
//       // Update existing vote
//       const updateResult = await client.query(
//         `UPDATE votteryy_votes 
//          SET 
//            answers = $1,
//            encrypted_vote = $2, 
//            vote_hash = $3,
//            is_edited = true,
//            updated_at = NOW()
//          WHERE id = $4
//          RETURNING id, voting_id`,
//         [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
//       );
//       voteId = updateResult.rows[0].id;
//       votingUuid = updateResult.rows[0].voting_id;
//       console.log('✅ Vote updated:', voteId, 'UUID:', votingUuid);
//     } else {
//       // Insert new vote
//       const voteResult = await client.query(
//         `INSERT INTO votteryy_votes 
//          (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
//          RETURNING id, voting_id`,
//         [
//           electionId,
//           String(userId),
//           JSON.stringify(answers),
//           encryptedVote,
//           voteHash,
//           receiptId,
//           verificationCode,
//           anonymous,
//           req.ip || req.connection.remoteAddress,
//           req.headers['user-agent'],
//         ]
//       );
//       voteId = voteResult.rows[0].id;
//       votingUuid = voteResult.rows[0].voting_id;
//       console.log('✅ Vote inserted:', voteId, 'UUID:', votingUuid);
//     }

//     // Create lottery ticket if lottery is enabled
//     if (election.lottery_enabled) {
//       const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
//       const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

//       await client.query(
//         `INSERT INTO votteryy_lottery_tickets 
//          (user_id, election_id, voting_id, ball_number, ticket_number)
//          VALUES ($1, $2, $3, $4, $5)
//          ON CONFLICT (user_id, election_id) DO NOTHING`,
//         [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
//       );
//       console.log(' Lottery ticket created:', ticketNumber, 'for voting UUID:', votingUuid);
//     }

//     // Record audit event
//     try {
//       await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
//       console.log(' Audit event logged');
//     } catch (auditError) {
//       console.warn(' Failed to log audit event:', auditError.message);
//     }

//     // Commit transaction
//     await client.query('COMMIT');
//     console.log(' Transaction committed');

//     // Send notification email (after commit)
//     setImmediate(async () => {
//       try {
//         const userResult = await pool.query(
//           `SELECT u.email, ud.full_name 
//            FROM votteryy_users u
//            LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
//            WHERE u.id = $1`,
//           [userId]
//         );
        
//         if (userResult.rows.length > 0 && userResult.rows[0].email) {
//           await NotificationService.sendVoteConfirmation(
//             userResult.rows[0].email,
//             election.title,
//             receiptId,
//             voteHash
//           );
//           console.log(' Confirmation email sent to:', userResult.rows[0].email);
//         }
//       } catch (notifError) {
//         console.warn(' Failed to send notification:', notifError.message);
//       }
//     });

//     console.log(' Vote cast successfully:', { votingId: voteId, votingUuid, receiptId, verificationCode });

//     // Return success response
//     res.json({
//       success: true,
//       votingId: votingUuid,
//       voteHash,
//       receiptId,
//       verificationCode,
//       message: 'Vote cast successfully',
//     });

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error(' Cast vote error:', error);
//     res.status(500).json({ 
//       error: 'Failed to cast vote',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   } finally {
//     client.release();
//   }
// };

// // ========================================
// //  NEW: GET VIDEO WATCH PROGRESS
// // ========================================
// export const getVideoProgress = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const userId = String(req.user?.userId || req.headers['x-user-id']); //  Convert to string

//     console.log(' GET VIDEO PROGRESS:', { userId, electionId });

//     if (!userId || userId === 'undefined') {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     const result = await pool.query(
//       `SELECT * FROM votteryy_video_watch_progress 
//        WHERE user_id = $1 AND election_id = $2`,
//       [userId, electionId]
//     );

//     console.log(' Found video progress:', result.rows[0] || 'NONE');

//     if (result.rows.length === 0) {
//       return res.json({
//         completed: false,
//         watch_percentage: 0,
//         last_position: 0,
//         total_duration: 0,
//       });
//     }

//     res.json(result.rows[0]);

//   } catch (error) {
//     console.error('Get video progress error:', error);
//     res.status(500).json({ error: 'Failed to get video progress' });
//   }
// };


// // ========================================
// // UPDATE VIDEO WATCH PROGRESS
// // ========================================
// export const updateVideoProgress = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const { watchPercentage, lastPosition, totalDuration, completed } = req.body;
//     const userId = String(req.user?.userId || req.headers['x-user-id']); //  Convert to string

//     console.log(' UPDATE VIDEO PROGRESS:', {
//       userId,
//       electionId,
//       watchPercentage,
//       lastPosition,
//       totalDuration,
//       completed,
//     });

//     if (!userId || userId === 'undefined') {
//       console.log(' No userId found');
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     const watchPercentageInt = Math.round(watchPercentage);
//     const lastPositionInt = Math.round(lastPosition);
//     const totalDurationInt = Math.round(totalDuration);

//     console.log(' Saving to database:', {
//       userId,
//       electionId,
//       watchPercentageInt,
//       lastPositionInt,
//       totalDurationInt,
//       completed: completed || false,
//     });

//     const result = await pool.query(
//       `INSERT INTO votteryy_video_watch_progress 
//        (user_id, election_id, watch_percentage, last_position, total_duration, completed, completed_at)
//        VALUES ($1, $2, $3, $4, $5, $6, $7)
//        ON CONFLICT (user_id, election_id)
//        DO UPDATE SET 
//          watch_percentage = $3,
//          last_position = $4,
//          total_duration = $5,
//          completed = $6,
//          completed_at = CASE WHEN $6 = TRUE THEN NOW() ELSE votteryy_video_watch_progress.completed_at END,
//          updated_at = NOW()
//        RETURNING *`,
//       [userId, electionId, watchPercentageInt, lastPositionInt, totalDurationInt, completed || false, completed ? new Date() : null]
//     );

//     console.log(' Saved to database:', result.rows[0]);

//     res.json({ 
//       success: true,
//       watchPercentage: watchPercentageInt,
//       completed: completed || false,
//       data: result.rows[0],
//     });

//   } catch (error) {
//     console.error(' Update video progress error:', error);
//     res.status(500).json({ error: 'Failed to update video progress', details: error.message });
//   }
// };


// // ========================================
// // RECORD ABSTENTION
// // ========================================
// export const recordAbstention = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const { questionId, reason } = req.body;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     if (!userId) {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     if (!questionId || !reason) {
//       return res.status(400).json({ error: 'Question ID and reason are required' });
//     }

//     await pool.query(
//       `INSERT INTO votteryy_abstentions (user_id, election_id, question_id, reason)
//        VALUES ($1, $2, $3, $4)`,
//       [userId, electionId, questionId, reason]
//     );

//     res.json({ 
//       success: true,
//       message: 'Abstention recorded',
//     });

//   } catch (error) {
//     console.error('Record abstention error:', error);
//     res.status(500).json({ error: 'Failed to record abstention' });
//   }
// };

// // ========================================
// // GET USER'S VOTE
// // ========================================
// export const getUserVote = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     if (!userId) {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     const voteResult = await pool.query(
//       `SELECT * FROM votteryy_votes
//        WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
//       [electionId, userId]
//     );

//     if (voteResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Vote not found' });
//     }

//     res.json(voteResult.rows[0]);

//   } catch (error) {
//     console.error('Get user vote error:', error);
//     res.status(500).json({ error: 'Failed to get vote' });
//   }

  
// };

// // ========================================
// // GET VOTING HISTORY
// // ========================================
// // ========================================
// // GET VOTING HISTORY
// // ========================================
// // ========================================
// // GET VOTING HISTORY
// // ========================================
// export const getVotingHistory = async (req, res) => {
//   try {
//     const userId = req.user?.userId || req.headers['x-user-id'];
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 10;
//     const offset = (page - 1) * limit;

//     console.log('📜 Getting voting history for user:', userId);

//     if (!userId) {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     // Get total count
//     const countQuery = `
//       SELECT COUNT(*) as total
//       FROM votteryy_votes
//       WHERE user_id = $1 AND status = 'valid'
//     `;
//     const countResult = await pool.query(countQuery, [String(userId)]);
//     const total = parseInt(countResult.rows[0].total);

//     // Get votes with election details and lottery info
//     const query = `
//       SELECT 
//         v.id,
//         v.voting_id,
//         v.election_id,
//         v.user_id,
//         v.receipt_id,
//         v.vote_hash,
//         v.status,
//         v.created_at,
//         v.anonymous,
//         e.title as election_title,
//         e.status as election_status,
//         e.is_free,
//         e.general_participation_fee,
//         e.lottery_enabled,
//         lt.ball_number,
//         lt.ticket_number as lottery_ticket_number,
//         lt.ticket_id,
//         CASE 
//           WHEN e.status = 'completed' THEN 'Draw Completed'
//           WHEN e.status = 'active' OR e.status = 'published' THEN 'Pending Draw'
//           ELSE 'Pending Draw'
//         END as lottery_status,
//         CASE 
//           WHEN e.is_free = false THEN e.general_participation_fee
//           ELSE 0
//         END as payment_amount,
//         'USD' as payment_currency
//       FROM votteryy_votes v
//       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
//       LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
//       WHERE v.user_id = $1 AND v.status = 'valid'
//       ORDER BY v.created_at DESC
//       LIMIT $2 OFFSET $3
//     `;

//     const result = await pool.query(query, [String(userId), limit, offset]);

//     console.log('✅ Found', result.rows.length, 'votes for user');

//     res.status(200).json({
//       success: true,
//       data: {
//         votes: result.rows,
//         pagination: {
//           currentPage: page,
//           limit,
//           total,
//           totalPages: Math.ceil(total / limit)
//         }
//       }
//     });
//   } catch (error) {
//     console.error('❌ Error fetching voting history:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to fetch voting history',
//       error: error.message
//     });
//   }
// };
// export default {
//   getBallot,
//   castVote,
//   getVideoProgress, 
//   updateVideoProgress,
//   recordAbstention,
//   getUserVote,
//   getVotingHistory
// };
// //last workable codes
// // // src/controllers/voting.controller.js
// // //  COMPLETE VERSION - All vote-related operations - FULLY FIXED
// // import pool from '../config/database.js';
// // import crypto from 'crypto';
// // import { 
// //   encryptVote, 
// //   generateVoteHash, 
// //   generateReceiptId, 
// //   generateVerificationCode 
// // } from '../services/encryption.service.js';
// // import AuditService from '../services/audit.service.js';
// // import NotificationService from '../services/notification.service.js';

// // // ========================================
// // // GET BALLOT
// // // ========================================
// // export const getBallot = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     console.log('🗳️ Getting ballot for election:', electionId, 'user:', userId);

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get election details
// //     const electionResult = await pool.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       return res.status(404).json({ error: 'Election not found' });
// //     }

// //     const election = electionResult.rows[0];

// //     // ✅ FIX: Debug election dates
// //     console.log('🔍 Election dates raw:', {
// //       start_date: election.start_date,
// //       start_time: election.start_time,
// //       end_date: election.end_date,
// //       end_time: election.end_time,
// //       start_date_type: typeof election.start_date,
// //     });

// //     // ✅ FIX: Handle date/time properly with PostgreSQL timestamp format
// //     const now = new Date();
// //     let startDateTime, endDateTime;
    
// //     try {
// //       // PostgreSQL returns Date objects, so we need to handle them properly
// //       if (election.start_date instanceof Date) {
// //         startDateTime = new Date(election.start_date);
// //         if (election.start_time) {
// //           const [hours, minutes, seconds] = election.start_time.split(':');
// //           startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
// //         }
// //       } else {
// //         // Fallback for string dates
// //         const startTime = election.start_time || '00:00:00';
// //         startDateTime = new Date(`${election.start_date}T${startTime}`);
// //       }

// //       if (election.end_date instanceof Date) {
// //         endDateTime = new Date(election.end_date);
// //         if (election.end_time) {
// //           const [hours, minutes, seconds] = election.end_time.split(':');
// //           endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
// //         }
// //       } else {
// //         // Fallback for string dates
// //         const endTime = election.end_time || '23:59:59';
// //         endDateTime = new Date(`${election.end_date}T${endTime}`);
// //       }
      
// //       // Validate dates
// //       if (isNaN(startDateTime.getTime()) || isNaN(endDateTime.getTime())) {
// //         throw new Error('Invalid date format');
// //       }
// //     } catch (dateError) {
// //       console.error('❌ Date parsing error:', dateError);
// //       return res.status(500).json({ 
// //         error: 'Invalid election dates',
// //         details: 'The election has invalid date configuration'
// //       });
// //     }

// //     console.log('📅 Election timing:', {
// //       now: now.toISOString(),
// //       start: startDateTime.toISOString(),
// //       end: endDateTime.toISOString(),
// //       status: election.status,
// //     });

// //     // ✅ Check status is 'published' or 'active'
// //     const allowedStatuses = ['published', 'active'];
    
// //     if (!allowedStatuses.includes(election.status)) {
// //       return res.status(400).json({ 
// //         error: 'Election is not currently active',
// //         status: election.status,
// //         message: `Election status is "${election.status}". Must be "published" or "active".`
// //       });
// //     }

// //     // ✅ Check date range
// //     if (now < startDateTime) {
// //       return res.status(400).json({ 
// //         error: 'Election has not started yet',
// //         startDate: startDateTime.toISOString(),
// //         message: `Election starts on ${startDateTime.toLocaleString()}`
// //       });
// //     }

// //     if (now > endDateTime) {
// //       return res.status(400).json({ 
// //         error: 'Election has ended',
// //         endDate: endDateTime.toISOString(),
// //         message: `Election ended on ${endDateTime.toLocaleString()}`
// //       });
// //     }

// //     console.log('✅ Election is active and within date range');

// //     // ✅ FIXED: Get questions from YOUR tables (votteryy_election_questions)
// //     const questionsResult = await pool.query(
// //       `SELECT 
// //         q.*,
// //         COALESCE(
// //           json_agg(
// //             json_build_object(
// //               'id', o.id,
// //               'option_text', o.option_text,
// //               'option_image_url', o.option_image_url,
// //               'option_order', o.option_order
// //             )
// //             ORDER BY o.option_order
// //           ) FILTER (WHERE o.id IS NOT NULL),
// //           '[]'
// //         ) as options
// //        FROM votteryy_election_questions q
// //        LEFT JOIN votteryy_election_options o ON q.id = o.question_id
// //        WHERE q.election_id = $1
// //        GROUP BY q.id
// //        ORDER BY q.id`,
// //       [electionId]
// //     );

// //     if (questionsResult.rows.length === 0) {
// //       return res.status(400).json({ 
// //         error: 'No questions found for this election',
// //         message: 'The election ballot has not been configured yet.'
// //       });
// //     }

// //     // Check if user has already voted
// //     const voteCheck = await pool.query(
// //       `SELECT id, voting_id, vote_hash, receipt_id FROM votteryy_votes 
// //        WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //       [electionId, userId]
// //     );

// //     const hasVoted = voteCheck.rows.length > 0;

// //     // Get video watch progress if video is required
// //     let videoProgress = null;
// //     if (election.video_watch_required) {
// //       const videoResult = await pool.query(
// //         `SELECT completed, watch_percentage FROM votteryy_video_watch_progress
// //          WHERE user_id = $1 AND election_id = $2`,
// //         [userId, electionId]
// //       );
// //       videoProgress = videoResult.rows[0] || { completed: false, watch_percentage: 0 };
// //     }

// //     // Format dates for response
// //     const formatDate = (date) => {
// //       if (date instanceof Date) {
// //         return date.toISOString().split('T')[0];
// //       }
// //       return date;
// //     };

// //     const formatTime = (time) => {
// //       if (!time) return null;
// //       if (typeof time === 'string') return time;
// //       return time.toString();
// //     };

// //     // Prepare ballot response
// //     const ballot = {
// //       election: {
// //         id: election.id,
// //         title: election.title,
// //         description: election.description,
// //         startDate: formatDate(election.start_date),
// //         startTime: formatTime(election.start_time),
// //         endDate: formatDate(election.end_date),
// //         endTime: formatTime(election.end_time),
// //         status: election.status,
// //         videoUrl: election.topic_video_url || election.video_url,
// //       },
// //       votingType: election.voting_type || 'plurality',
// //       questions: questionsResult.rows,
// //       hasVoted,
// //       votingId: hasVoted ? voteCheck.rows[0].voting_id : null,
// //       voteHash: hasVoted ? voteCheck.rows[0].vote_hash : null,
// //       receiptId: hasVoted ? voteCheck.rows[0].receipt_id : null,
// //       voteEditingAllowed: election.vote_editing_allowed || false,
// //       anonymousVotingEnabled: election.anonymous_voting_enabled || false,
// //       liveResults: election.show_live_results || false,
// //       videoWatchRequired: election.video_watch_required || false,
// //       videoProgress: videoProgress,
// //       minimumWatchPercentage: parseFloat(election.minimum_watch_percentage) || 0,
// //       lotteryEnabled: election.lottery_enabled || false,
// //       paymentRequired: !election.is_free,
// //       participationFee: parseFloat(election.general_participation_fee) || 0,
// //     };

// //     console.log('✅ Ballot prepared:', {
// //       questionCount: ballot.questions.length,
// //       hasVoted,
// //       votingType: ballot.votingType,
// //     });

// //     res.json(ballot);

// //   } catch (error) {
// //     console.error('❌ Get ballot error:', error);
// //     res.status(500).json({ 
// //       error: 'Failed to get ballot',
// //       details: process.env.NODE_ENV === 'development' ? error.message : undefined
// //     });
// //   }
// // };

// // // ========================================
// // // CAST VOTE
// // // ========================================
// // export const castVote = async (req, res) => {
// //   const client = await pool.connect();
  
// //   try {
// //     await client.query('BEGIN');

// //     const { electionId } = req.params;
// //     const { answers, anonymous = false } = req.body;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     console.log('🗳️ Casting vote:', { electionId, userId, anonymous, answersCount: Object.keys(answers || {}).length });

// //     if (!userId) {
// //       await client.query('ROLLBACK');
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     if (!answers || Object.keys(answers).length === 0) {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ error: 'No answers provided' });
// //     }

// //     // Get election
// //     const electionResult = await client.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       await client.query('ROLLBACK');
// //       return res.status(404).json({ error: 'Election not found' });
// //     }

// //     const election = electionResult.rows[0];

// //     // Check if election is active
// //     const now = new Date();
// //     let startDateTime, endDateTime;
    
// //     try {
// //       if (election.start_date instanceof Date) {
// //         startDateTime = new Date(election.start_date);
// //         if (election.start_time) {
// //           const [hours, minutes, seconds] = election.start_time.split(':');
// //           startDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
// //         }
// //       } else {
// //         const startTime = election.start_time || '00:00:00';
// //         startDateTime = new Date(`${election.start_date}T${startTime}`);
// //       }

// //       if (election.end_date instanceof Date) {
// //         endDateTime = new Date(election.end_date);
// //         if (election.end_time) {
// //           const [hours, minutes, seconds] = election.end_time.split(':');
// //           endDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
// //         }
// //       } else {
// //         const endTime = election.end_time || '23:59:59';
// //         endDateTime = new Date(`${election.end_date}T${endTime}`);
// //       }
// //     } catch (dateError) {
// //       await client.query('ROLLBACK');
// //       return res.status(500).json({ error: 'Invalid election dates' });
// //     }

// //     const allowedStatuses = ['published', 'active'];

// //     if (!allowedStatuses.includes(election.status) || now < startDateTime || now > endDateTime) {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ error: 'Election is not currently active' });
// //     }

// //     // Check if already voted
// //     const existingVote = await client.query(
// //       `SELECT id, voting_id FROM votteryy_votes WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //       [electionId, userId]
// //     );

// //     if (existingVote.rows.length > 0 && !election.vote_editing_allowed) {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ error: 'You have already voted in this election' });
// //     }

// //     // Prepare vote data
// //     const voteData = {
// //       electionId,
// //       userId,
// //       answers,
// //       timestamp: new Date().toISOString(),
// //     };

// //     const encryptedVote = encryptVote(JSON.stringify(voteData));
// //     const voteHash = generateVoteHash(encryptedVote);
// //     const receiptId = generateReceiptId();
// //     const verificationCode = generateVerificationCode();

// //     // Insert or update vote
// //     let voteId, votingUuid;
    
// //     if (existingVote.rows.length > 0) {
// //       // Update existing vote
// //       const updateResult = await client.query(
// //         `UPDATE votteryy_votes 
// //          SET 
// //            answers = $1,
// //            encrypted_vote = $2, 
// //            vote_hash = $3,
// //            is_edited = true,
// //            updated_at = NOW()
// //          WHERE id = $4
// //          RETURNING id, voting_id`,
// //         [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
// //       );
// //       voteId = updateResult.rows[0].id;
// //       votingUuid = updateResult.rows[0].voting_id;
// //       console.log('✅ Vote updated:', voteId, 'UUID:', votingUuid);
// //     } else {
// //       // Insert new vote
// //       const voteResult = await client.query(
// //         `INSERT INTO votteryy_votes 
// //          (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
// //          RETURNING id, voting_id`,
// //         [
// //           electionId,
// //           String(userId),
// //           JSON.stringify(answers),
// //           encryptedVote,
// //           voteHash,
// //           receiptId,
// //           verificationCode,
// //           anonymous,
// //           req.ip || req.connection.remoteAddress,
// //           req.headers['user-agent'],
// //         ]
// //       );
// //       voteId = voteResult.rows[0].id;
// //       votingUuid = voteResult.rows[0].voting_id;
// //       console.log('✅ Vote inserted:', voteId, 'UUID:', votingUuid);
// //     }

// //     // Create lottery ticket if lottery is enabled
// //     if (election.lottery_enabled) {
// //       const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
// //       const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

// //       await client.query(
// //         `INSERT INTO votteryy_lottery_tickets 
// //          (user_id, election_id, voting_id, ball_number, ticket_number)
// //          VALUES ($1, $2, $3, $4, $5)
// //          ON CONFLICT (user_id, election_id) DO NOTHING`,
// //         [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
// //       );
// //       console.log('🎰 Lottery ticket created:', ticketNumber, 'for voting UUID:', votingUuid);
// //     }

// //     // Record audit event
// //     try {
// //       await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
// //       console.log('📝 Audit event logged');
// //     } catch (auditError) {
// //       console.warn('⚠️ Failed to log audit event:', auditError.message);
// //     }

// //     // Commit transaction
// //     await client.query('COMMIT');
// //     console.log('✅ Transaction committed');

// //     // Send notification email (after commit)
// //     setImmediate(async () => {
// //       try {
// //         const userResult = await pool.query(
// //           `SELECT u.email, ud.full_name 
// //            FROM votteryy_users u
// //            LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
// //            WHERE u.id = $1`,
// //           [userId]
// //         );
        
// //         if (userResult.rows.length > 0 && userResult.rows[0].email) {
// //           await NotificationService.sendVoteConfirmation(
// //             userResult.rows[0].email,
// //             election.title,
// //             receiptId,
// //             voteHash
// //           );
// //           console.log('📧 Confirmation email sent to:', userResult.rows[0].email);
// //         }
// //       } catch (notifError) {
// //         console.warn('⚠️ Failed to send notification:', notifError.message);
// //       }
// //     });

// //     console.log('✅ Vote cast successfully:', { votingId: voteId, votingUuid, receiptId, verificationCode });

// //     // Return success response
// //     res.json({
// //       success: true,
// //       votingId: votingUuid,
// //       voteHash,
// //       receiptId,
// //       verificationCode,
// //       message: 'Vote cast successfully',
// //     });

// //   } catch (error) {
// //     await client.query('ROLLBACK');
// //     console.error('❌ Cast vote error:', error);
// //     res.status(500).json({ 
// //       error: 'Failed to cast vote',
// //       details: process.env.NODE_ENV === 'development' ? error.message : undefined
// //     });
// //   } finally {
// //     client.release();
// //   }
// // };

// // // ========================================
// // // UPDATE VIDEO WATCH PROGRESS
// // // ========================================
// // export const updateVideoProgress = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const { watchPercentage, lastPosition, totalDuration } = req.body;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const completed = watchPercentage >= 80;

// //     await pool.query(
// //       `INSERT INTO votteryy_video_watch_progress 
// //        (user_id, election_id, watch_percentage, last_position, total_duration, completed)
// //        VALUES ($1, $2, $3, $4, $5, $6)
// //        ON CONFLICT (user_id, election_id)
// //        DO UPDATE SET 
// //          watch_percentage = $3,
// //          last_position = $4,
// //          total_duration = $5,
// //          completed = $6,
// //          updated_at = NOW()`,
// //       [userId, electionId, watchPercentage, lastPosition, totalDuration, completed]
// //     );

// //     res.json({ 
// //       success: true,
// //       watchPercentage,
// //       completed,
// //     });

// //   } catch (error) {
// //     console.error('Update video progress error:', error);
// //     res.status(500).json({ error: 'Failed to update video progress' });
// //   }
// // };

// // // ========================================
// // // RECORD ABSTENTION
// // // ========================================
// // export const recordAbstention = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const { questionId, reason } = req.body;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     if (!questionId || !reason) {
// //       return res.status(400).json({ error: 'Question ID and reason are required' });
// //     }

// //     await pool.query(
// //       `INSERT INTO votteryy_abstentions (user_id, election_id, question_id, reason)
// //        VALUES ($1, $2, $3, $4)`,
// //       [userId, electionId, questionId, reason]
// //     );

// //     res.json({ 
// //       success: true,
// //       message: 'Abstention recorded',
// //     });

// //   } catch (error) {
// //     console.error('Record abstention error:', error);
// //     res.status(500).json({ error: 'Failed to record abstention' });
// //   }
// // };

// // // ========================================
// // // GET USER'S VOTE
// // // ========================================
// // export const getUserVote = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const voteResult = await pool.query(
// //       `SELECT * FROM votteryy_votes
// //        WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //       [electionId, userId]
// //     );

// //     if (voteResult.rows.length === 0) {
// //       return res.status(404).json({ error: 'Vote not found' });
// //     }

// //     res.json(voteResult.rows[0]);

// //   } catch (error) {
// //     console.error('Get user vote error:', error);
// //     res.status(500).json({ error: 'Failed to get vote' });
// //   }
// // };

// // export default {
// //   getBallot,
// //   castVote,
// //   updateVideoProgress,
// //   recordAbstention,
// //   getUserVote,
// // };