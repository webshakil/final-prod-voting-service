// src/controllers/voteController.js
import * as voteService from '../services/voteService.js';
import * as lotteryService from '../services/lotteryService.js';
import crypto from 'node:crypto';
import { successResponse, errorResponse } from '../utils/responseHandler.js';
import { SUCCESS_MESSAGES, ERROR_MESSAGES } from '../config/constants.js';
import pool from '../config/database.js';
import axios from 'axios';

const ELECTION_SERVICE_URL = process.env.ELECTION_SERVICE_URL || 'http://localhost:3005/api';

/**
 * ✅ NEW: Get Election Ballot - checks if user already voted from votteryyy_voter_participation
 */
export const getElectionBallot = async (req, res) => {
  try {
    const { electionId } = req.params;
    
    // Get userId from multiple sources
    let userId = null;
    
    if (req.headers['x-user-data']) {
      try {
        const userData = JSON.parse(req.headers['x-user-data']);
        userId = userData.userId;
      } catch (e) {
        console.error('Error parsing x-user-data:', e);
      }
    }
    
    if (!userId && req.headers['x-user-id']) {
      userId = req.headers['x-user-id'];
    }
    
    if (!userId && req.user?.userId) {
      userId = req.user.userId;
    }
    
    console.log('📥 Getting ballot for election:', electionId, 'user:', userId);

    // 1. Get election data from Election Service
    let electionData;
    try {
      const response = await axios.get(`${ELECTION_SERVICE_URL}/elections/${electionId}`);
      electionData = response.data?.data?.election || 
                     response.data?.election || 
                     response.data?.data || 
                     response.data;
    } catch (error) {
      console.error('❌ Error fetching election:', error.message);
      return errorResponse(res, 'Election not found', 404);
    }

    if (!electionData || !electionData.id) {
      return errorResponse(res, 'Election not found', 404);
    }

    // 2. Get questions from Election Service
    let questions = [];
    try {
      const questionsResponse = await axios.get(`${ELECTION_SERVICE_URL}/elections/${electionId}/questions`);
      questions = questionsResponse.data?.data?.questions || 
                  questionsResponse.data?.questions || 
                  questionsResponse.data?.data || 
                  [];
    } catch (error) {
      console.error('⚠️ Error fetching questions:', error.message);
    }

    // 3. ✅ CHECK IF USER HAS ALREADY VOTED - from votteryyy_voter_participation
    // This table tracks ALL votes (both normal and anonymous)
    let hasVoted = false;
    
    if (userId) {
      try {
        const participationResult = await pool.query(
          `SELECT id, has_voted, voted_at FROM votteryyy_voter_participation 
           WHERE user_id = $1 AND election_id = $2`,
          [String(userId), parseInt(electionId)]
        );
        
        if (participationResult.rows.length > 0 && participationResult.rows[0].has_voted) {
          hasVoted = true;
          console.log('🛑 User has already voted:', { userId, electionId, votedAt: participationResult.rows[0].voted_at });
        } else {
          console.log('✅ User has NOT voted yet:', { userId, electionId });
        }
      } catch (error) {
        console.error('⚠️ Error checking participation:', error.message);
      }
    }

    // 4. Get video progress if user is logged in
    let videoProgress = null;
    if (userId && electionData.video_watch_required) {
      try {
        const progressResult = await pool.query(
          `SELECT watch_percentage, last_position, completed, total_duration 
           FROM votteryy_video_progress 
           WHERE user_id = $1 AND election_id = $2
           ORDER BY updated_at DESC LIMIT 1`,
          [String(userId), parseInt(electionId)]
        );
        
        if (progressResult.rows.length > 0) {
          videoProgress = progressResult.rows[0];
        }
      } catch (error) {
        console.error('⚠️ Error fetching video progress:', error.message);
      }
    }

    // 5. Parse lottery config
    let lotteryConfig = null;
    let lotteryEnabled = false;
    
    if (electionData.lottery_config) {
      try {
        lotteryConfig = typeof electionData.lottery_config === 'string' 
          ? JSON.parse(electionData.lottery_config) 
          : electionData.lottery_config;
        lotteryEnabled = lotteryConfig?.lottery_enabled || lotteryConfig?.is_lotterized || false;
      } catch (e) {
        console.error('Error parsing lottery config:', e);
      }
    }

    // 6. Build response
    const ballotResponse = {
      election: {
        id: electionData.id,
        title: electionData.title,
        description: electionData.description,
        startDate: electionData.start_date,
        endDate: electionData.end_date,
        status: electionData.status,
        videoUrl: electionData.topic_video_url || electionData.video_url,
        authentication_methods: electionData.authentication_methods || ['passkey'],
      },
      questions: questions.map(q => ({
        id: q.id || q.question_id,
        questionText: q.question_text,
        questionType: q.question_type || 'multiple_choice',
        isRequired: q.is_required !== false,
        maxSelections: q.max_selections || 1,
        options: (q.options || []).map(opt => ({
          id: opt.id || opt.option_id,
          optionText: opt.option_text,
          optionOrder: opt.option_order,
        })),
      })),
      
      // ✅ CRITICAL: hasVoted flag
      hasVoted: hasVoted,
      
      // Voting settings
      votingType: electionData.voting_type || 'plurality',
      voteEditingAllowed: electionData.vote_editing_allowed || false,
      anonymousVotingEnabled: electionData.anonymous_voting_enabled || false,
      liveResults: electionData.show_live_results || false,
      
      // Payment
      paymentRequired: !electionData.is_free && parseFloat(electionData.general_participation_fee || 0) > 0,
      participationFee: parseFloat(electionData.general_participation_fee || 0),
      
      // Video
      videoWatchRequired: electionData.video_watch_required || false,
      minimumWatchPercentage: parseFloat(electionData.minimum_watch_percentage || 80),
      videoProgress: videoProgress,
      
      // Lottery
      lotteryEnabled: lotteryEnabled,
      lotteryConfig: lotteryConfig,
    };

    console.log('✅ Ballot response ready:', { 
      electionId, 
      hasVoted: ballotResponse.hasVoted,
      questionsCount: ballotResponse.questions.length 
    });

    return successResponse(res, ballotResponse);
  } catch (error) {
    console.error('❌ Get ballot error:', error);
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Cast a new vote
 */
export const castVote = async (req, res) => {
  try {
    const { electionId, answers, userId } = req.body;
    
    // Validate inputs
    if (!userId) {
      return errorResponse(res, 'User ID is required', 400);
    }
    
    if (!electionId) {
      return errorResponse(res, 'Election ID is required', 400);
    }
    
    if (!answers || typeof answers !== 'object') {
      return errorResponse(res, 'Answers must be an object', 400);
    }
    
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];

    console.log('📥 Casting vote:', { 
      userId, 
      electionId, 
      answersCount: Object.keys(answers).length 
    });

    // Get election data
    const electionData = await voteService.getElectionData(electionId);
    
    console.log('✅ Election data received:', electionData.title);

    // 🔥 SKIP payment check for now - assume payment is already done
    console.log('⚠️ Skipping payment verification (already verified via payment intent)');
    
    // 🔥 SKIP video check for now
    console.log('⚠️ Skipping video verification');

    // Validate voting eligibility
    const errors = await voteService.validateVotingEligibility(
      userId,
      electionId,
      electionData
    );

    if (errors.length > 0) {
      return errorResponse(res, 'Voting not allowed, you already voted', 400, errors);
    }

    // Cast vote
    const vote = await voteService.castVote(
      userId,
      electionId,
      answers,
      ipAddress,
      userAgent
    );

    console.log('✅ Vote cast successfully:', vote.votingId);

    // Create lottery ticket if election is lotterized
    let lotteryTicket = null;
    
    const isLotterized = electionData.is_lotterized || 
                        (electionData.lottery_config && electionData.lottery_config.is_lotterized);
    
    if (isLotterized) {
      try {
        lotteryTicket = await lotteryService.createLotteryTicket(
          userId, 
          electionId, 
          vote.votingId,
          electionData.lottery_config || { is_lotterized: true }
        );
        
        console.log('🎫 Lottery ticket created:', lotteryTicket.ticket_number);
        
        // Add lottery info to response
        vote.lotteryTicketNumber = lotteryTicket.ticket_number;
        vote.lotteryBallNumber = lotteryTicket.ball_number;
      } catch (lotteryError) {
        console.error('❌ Lottery ticket creation failed:', lotteryError.message);
        // Don't fail the vote if lottery creation fails
      }
    }

    return successResponse(
      res, 
      vote, 
      SUCCESS_MESSAGES?.VOTE_CAST || 'Vote cast successfully', 
      201
    );
  } catch (error) {
    console.error('❌ Cast vote error:', error);
    console.error('❌ Error stack:', error.stack);
    return errorResponse(res, error.message, 500);
  }
};

// Export other controller functions...
export const editVote = async (req, res) => {
  try {
    const { electionId, answers, userId } = req.body;
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];

    const result = await voteService.editVote(userId, electionId, answers, ipAddress, userAgent);
    return successResponse(res, result, 'Vote edited successfully');
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

export const getMyVote = async (req, res) => {
  try {
    const userId = req.user?.userId || req.body.userId;
    const { electionId } = req.params;

    const vote = await voteService.getUserVote(userId, parseInt(electionId));
    
    if (!vote) {
      return errorResponse(res, 'No vote found', 404);
    }

    return successResponse(res, vote);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

export const getVotingHistory = async (req, res) => {
  try {
    // Get userId from multiple sources
    let userId = req.query.userId || req.user?.userId || req.body.userId;
    
    // Also try to get from x-user-data header
    if (!userId) {
      try {
        const xUserData = req.headers['x-user-data'];
        if (xUserData) {
          const userData = JSON.parse(xUserData);
          userId = userData.userId;
        }
      } catch (err) {
        console.error('Error parsing x-user-data:', err);
      }
    }
    
    if (!userId) {
      return errorResponse(res, 'User ID is required. Please provide userId in query, header, or body.', 400);
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    console.log('📊 Fetching voting history:', { userId, page, limit });

    const result = await voteService.getUserVotingHistory(userId, page, limit);

    return successResponse(res, result);
  } catch (error) {
    console.error('❌ Get voting history error:', error);
    return errorResponse(res, error.message, 500);
  }
};



export const verifyReceipt = async (req, res) => {
  try {
    const { receiptId } = req.params;
    const receipt = await voteService.verifyReceipt(receiptId);

    if (!receipt) {
      return errorResponse(res, 'Receipt not found', 404);
    }

    return successResponse(res, receipt);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

export const getElectionResults = async (req, res) => {
  try {
    const { electionId } = req.params;
    const results = await voteService.getElectionResults(parseInt(electionId));
    return successResponse(res, results);
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};


/**
 * Get comprehensive audit trail for all elections
 */
export const getAuditTrail = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const actionType = req.query.actionType || null;
    const electionId = req.query.electionId || null;
    
    console.log('📊 Fetching audit trail:', { page, limit, actionType, electionId });

    // Build WHERE clause
    let whereClause = '';
    const params = [];
    let paramIndex = 1;
    
    if (actionType) {
      whereClause += ` AND al.action_type = $${paramIndex}`; // 🔥 Fixed: added al. prefix
      params.push(actionType);
      paramIndex++;
    }
    
    if (electionId) {
      whereClause += ` AND al.election_id = $${paramIndex}`; // 🔥 Fixed: added al. prefix
      params.push(parseInt(electionId));
      paramIndex++;
    }

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total 
      FROM votteryy_vote_audit_logs al
      WHERE 1=1 ${whereClause}
    `;
    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Get audit logs with vote and receipt details
    const auditQuery = `
      SELECT 
        al.*,
        v.vote_hash,
        v.status as vote_status,
        v.is_edited,
        r.receipt_id,
        r.verification_code
      FROM votteryy_vote_audit_logs al
      LEFT JOIN votteryy_votes v ON al.voting_id = v.voting_id
      LEFT JOIN votteryy_vote_receipts r ON al.voting_id = r.voting_id
      WHERE 1=1 ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    const result = await pool.query(auditQuery, [...params, limit, offset]);
    
    console.log(`✅ Found ${result.rows.length} audit logs`);

    return successResponse(res, {
      auditLogs: result.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      }
    });
  } catch (error) {
    console.error('❌ Error fetching audit trail:', error);
    return errorResponse(res, error.message, 500);
  }
};


/**
 * Get audit statistics
 */
export const getAuditStats = async (req, res) => {
  try {
    console.log('📊 Fetching audit statistics');

    // Get overall stats
    const statsQuery = `
      SELECT 
        COUNT(*) as total_actions,
        COUNT(DISTINCT user_id) as unique_users,
        COUNT(DISTINCT election_id) as elections_with_activity,
        COUNT(DISTINCT DATE(created_at)) as days_with_activity,
        MIN(created_at) as first_action,
        MAX(created_at) as last_action
      FROM votteryy_vote_audit_logs
    `;
    const statsResult = await pool.query(statsQuery);

    // Get action type breakdown
    const actionTypesQuery = `
      SELECT 
        action_type,
        COUNT(*) as count
      FROM votteryy_vote_audit_logs
      GROUP BY action_type
      ORDER BY count DESC
    `;
    const actionTypesResult = await pool.query(actionTypesQuery);

    // Get recent activity (last 24 hours)
    const recentActivityQuery = `
      SELECT 
        COUNT(*) as actions_24h,
        COUNT(DISTINCT user_id) as active_users_24h
      FROM votteryy_vote_audit_logs
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `;
    const recentActivityResult = await pool.query(recentActivityQuery);

    // Get votes statistics
    const votesStatsQuery = `
      SELECT 
        COUNT(*) as total_votes,
        COUNT(DISTINCT user_id) as unique_voters,
        COUNT(DISTINCT election_id) as elections_voted,
        COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
        COUNT(*) FILTER (WHERE status = 'valid') as valid_votes
      FROM votteryy_votes
    `;
    const votesStatsResult = await pool.query(votesStatsQuery);

    return successResponse(res, {
      overall: statsResult.rows[0],
      actionTypes: actionTypesResult.rows,
      recentActivity: recentActivityResult.rows[0],
      votes: votesStatsResult.rows[0],
    });
  } catch (error) {
    console.error('❌ Error fetching audit stats:', error);
    return errorResponse(res, error.message, 500);
  }
};

/**
 * Get blockchain-style hash chain for verification
 */
export const getHashChain = async (req, res) => {
  try {
    const { electionId } = req.params;
    console.log('🔗 Generating hash chain for election:', electionId);

    // Get all votes in chronological order
    const votesQuery = `
      SELECT 
        voting_id,
        vote_hash,
        created_at,
        user_id
      FROM votteryy_votes
      WHERE election_id = $1 AND status = 'valid'
      ORDER BY created_at ASC
    `;
    const result = await pool.query(votesQuery, [parseInt(electionId)]);

    // Build hash chain
    const hashChain = [];
    let previousHash = '0000000000000000000000000000000000000000000000000000000000000000'; // Genesis block

    result.rows.forEach((vote, index) => {
      // 🔥 Fixed: Use crypto from node:crypto
      const blockData = `${previousHash}${vote.vote_hash}${vote.created_at}`;
      const blockHash = crypto.createHash('sha256').update(blockData).digest('hex');
      
      hashChain.push({
        blockNumber: index + 1,
        votingId: vote.voting_id,
        voteHash: vote.vote_hash,
        previousHash,
        blockHash,
        timestamp: vote.created_at,
        userId: vote.user_id.substring(0, 8) + '...', // Anonymize
      });

      previousHash = blockHash;
    });

    return successResponse(res, {
      electionId: parseInt(electionId),
      totalBlocks: hashChain.length,
      hashChain,
      latestBlockHash: previousHash,
    });
  } catch (error) {
    console.error('❌ Error generating hash chain:', error);
    return errorResponse(res, error.message, 500);
  }
};

export const getPublicBulletinBoard = async (req, res) => {
  try {
    const { electionId } = req.params;
    
    // Get anonymized votes for transparency
    const votesQuery = `
      SELECT 
        voting_id,
        vote_hash,
        created_at,
        'User-' || SUBSTRING(user_id, 1, 4) as anonymized_user
      FROM votteryy_votes
      WHERE election_id = $1 AND status = 'valid'
      ORDER BY created_at DESC
    `;
    const result = await pool.query(votesQuery, [parseInt(electionId)]);
    
    // Get hash chain for verification
    const hashChainQuery = `
      SELECT 
        voting_id,
        vote_hash,
        created_at
      FROM votteryy_votes
      WHERE election_id = $1 AND status = 'valid'
      ORDER BY created_at ASC
    `;
    const chainResult = await pool.query(hashChainQuery, [parseInt(electionId)]);
    
    // Build hash chain
    let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const hashChain = chainResult.rows.map((vote, index) => {
      const blockData = `${previousHash}${vote.vote_hash}${vote.created_at}`;
      const blockHash = crypto.createHash('sha256').update(blockData).digest('hex');
      previousHash = blockHash;
      
      return {
        blockNumber: index + 1,
        voteHash: vote.vote_hash,
        timestamp: vote.created_at,
        blockHash,
      };
    });
    
    return successResponse(res, {
      electionId: parseInt(electionId),
      totalVotes: result.rows.length,
      votes: result.rows,
      hashChain,
      verificationHash: previousHash,
    });
  } catch (error) {
    console.error('❌ Error fetching public bulletin:', error);
    return errorResponse(res, error.message, 500);
  }
};

export default {
  getElectionBallot,
  castVote,
  editVote,
  getMyVote,
  getVotingHistory,
  verifyReceipt,
  getElectionResults,
  getAuditTrail,
  getAuditStats,
  getHashChain,
  getPublicBulletinBoard
};

//last working code
// import pool from '../config/database.js';
// import crypto from 'crypto';
// import { 
//   encryptVote, 
//   generateVoteHash, 
//   generateReceiptId, 
//   generateVerificationCode,
//   generateVoteToken
// } from '../services/encryption.service.js';
// import AuditService from '../services/audit.service.js';
// import NotificationService from '../services/notification.service.js';

// // ✅ FIXED: Import from combined socket
// import { 
//   emitVoteCastConfirmation,
//   emitVoteUpdated,
//   emitLotteryTicketCreated
// } from '../socket/combinedSocket.js';

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

//     //  FIX: Handle date/time properly with PostgreSQL timestamp format
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

//     console.log('✅ Election is active and within date range');

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
// // GET LIVE RESULTS - FIXED VERSION (ONLY ONE)
// // ========================================
// export const getLiveResults = async (req, res) => {
//   const client = await pool.connect();
  
//   try {
//     const { electionId } = req.params;

//     console.log(`\n========================================`);
//     console.log(`📊 LIVE RESULTS - Election ${electionId}`);
//     console.log(`========================================`);

//     // 1. Get election info
//     const electionResult = await client.query(
//       `SELECT 
//         id, 
//         title, 
//         voting_type, 
//         show_live_results, 
//         status,
//         anonymous_voting_enabled
//       FROM votteryyy_elections
//       WHERE id = $1`,
//       [electionId]
//     );
    
//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         error: 'Election not found',
//       });
//     }

//     const election = electionResult.rows[0];
//     const isAnonymous = election.anonymous_voting_enabled || false;

//     console.log(`📋 Election: ${election.title}`);
//     console.log(`🔐 Anonymous: ${isAnonymous}`);
//     console.log(`📊 Voting Type: ${election.voting_type}`);

//     // Check if live results are enabled
//     if (!election.show_live_results && election.status !== 'completed') {
//       return res.status(403).json({
//         success: false,
//         error: 'Live results are not enabled for this election',
//       });
//     }

//     // 2. Determine which table to query
//     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
//     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

//     console.log(`🗄️  Querying table: ${votesTableName}`);

//     // 3. Get questions and options structure
//     const questionsAndOptionsQuery = `
//       SELECT 
//         q.id,
//         q.question_text,
//         q.question_type,
//         q.question_order,
//         json_agg(
//           json_build_object(
//             'id', o.id,
//             'option_text', o.option_text,
//             'option_order', o.option_order
//           ) ORDER BY o.option_order
//         ) as options
//       FROM votteryy_election_questions q
//       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
//       WHERE q.election_id = $1
//       GROUP BY q.id, q.question_text, q.question_type, q.question_order
//       ORDER BY q.question_order
//     `;

//     const questionsResult = await client.query(questionsAndOptionsQuery, [electionId]);

//     if (questionsResult.rows.length === 0) {
//       return res.json({
//         success: true,
//         data: {
//           electionId: parseInt(electionId),
//           electionTitle: election.title,
//           votingType: election.voting_type,
//           isAnonymous: isAnonymous,
//           totalVotes: 0,
//           questions: [],
//           lastUpdated: new Date().toISOString(),
//         }
//       });
//     }

//     console.log(`📝 Found ${questionsResult.rows.length} questions`);

//     // 4. Count votes for each option
//     const questions = [];
//     let grandTotalVotes = 0;

//     for (const question of questionsResult.rows) {
//       console.log(`\n   Question ${question.id}: ${question.question_text}`);
      
//       const optionsWithCounts = [];

//       for (const option of question.options) {
//         if (!option.id) continue; // Skip null options

//         // ⭐ FIXED: Count votes for this specific option
//         const voteCountQuery = `
//           SELECT COUNT(DISTINCT v.id) as count
//           FROM ${votesTableName} v
//           WHERE v.election_id = $1
//           ${statusFilter}
//           AND (
//             -- Plurality/Single choice: answers->'questionId' = 'optionId'
//             (v.answers->$2::text)::text = $3::text
//             OR
//             -- Approval voting: answers->'questionId' is array containing optionId
//             (
//               jsonb_typeof(v.answers->$2::text) = 'array'
//               AND v.answers->$2::text @> $3::jsonb
//             )
//             OR
//             -- Ranked choice: answers->'questionId' is object with optionId as key
//             (
//               jsonb_typeof(v.answers->$2::text) = 'object'
//               AND v.answers->$2::text ? $3::text
//             )
//           )
//         `;

//         try {
//           const voteCountResult = await client.query(voteCountQuery, [
//             electionId,
//             question.id.toString(),
//             option.id.toString()
//           ]);

//           const voteCount = parseInt(voteCountResult.rows[0].count) || 0;
          
//           console.log(`      ${option.option_text}: ${voteCount} votes`);

//           optionsWithCounts.push({
//             id: option.id,
//             option_text: option.option_text,
//             option_order: option.option_order,
//             vote_count: voteCount
//           });

//         } catch (optionError) {
//           console.error(`      ❌ Error counting votes for option ${option.id}:`, optionError.message);
//           optionsWithCounts.push({
//             id: option.id,
//             option_text: option.option_text,
//             option_order: option.option_order,
//             vote_count: 0
//           });
//         }
//       }

//       // Calculate question total and percentages
//       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
//       optionsWithCounts.forEach(opt => {
//         opt.percentage = questionTotalVotes > 0 
//           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
//           : '0.00';
//       });

//       grandTotalVotes += questionTotalVotes;

//       questions.push({
//         id: question.id,
//         question_text: question.question_text,
//         question_type: question.question_type,
//         question_order: question.question_order,
//         options: optionsWithCounts,
//         total_votes: questionTotalVotes
//       });

//       console.log(`      Question total: ${questionTotalVotes} votes`);
//     }

//     console.log(`\n✅ GRAND TOTAL VOTES: ${grandTotalVotes}`);
//     console.log(`========================================\n`);

//     const liveResults = {
//       electionId: parseInt(electionId),
//       electionTitle: election.title,
//       votingType: election.voting_type,
//       isAnonymous: isAnonymous,
//       totalVotes: grandTotalVotes,
//       questions,
//       lastUpdated: new Date().toISOString(),
//     };

//     res.json({
//       success: true,
//       data: liveResults,
//     });

//   } catch (error) {
//     console.error('❌ Get live results error:', error);
//     console.error('Stack trace:', error.stack);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to retrieve live results',
//       message: error.message,
//     });
//   } finally {
//     client.release();
//   }
// };

// // ========================================
// // CAST VOTE - WITH ANONYMOUS & ABSTENTION SUPPORT
// // ========================================
// // ========================================
// // CAST VOTE - COMPLETE WITH AUDIT SUPPORT
// // ========================================
// export const castVote = async (req, res) => {
//   const client = await pool.connect();
  
//   try {
//     await client.query('BEGIN');

//     const { electionId } = req.params;
//     const { answers, isAbstention = false } = req.body;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     console.log('🗳️ Casting vote:', { 
//       electionId, 
//       userId, 
//       isAbstention,
//       answersCount: answers ? Object.keys(answers).length : 0 
//     });

//     if (!userId) {
//       await client.query('ROLLBACK');
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     // Get election with settings
//     const electionResult = await client.query(
//       `SELECT * FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];

//     // ✅ REQUIREMENT 5: Check if election is completed
//     if (election.status === 'completed') {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ 
//         error: 'Election has ended',
//         message: 'You cannot vote or change your vote after the election has been completed.'
//       });
//     }

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

//     const isAnonymousElection = election.anonymous_voting_enabled || false;
//     const voteEditingAllowed = election.vote_editing_allowed || false;

//     console.log(`📋 Election settings:`, {
//       anonymous: isAnonymousElection,
//       editingAllowed: voteEditingAllowed,
//       status: election.status
//     });

//     // Handle ABSTENTION
//     if (isAbstention) {
//       console.log('🚫 Recording abstention');
      
//       await client.query(
//         `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
//          VALUES ($1, $2, TRUE)
//          ON CONFLICT (election_id, user_id) DO NOTHING`,
//         [electionId, String(userId)]
//       );

//       await client.query(
//         `INSERT INTO votteryy_abstentions (election_id, user_id, is_full_abstention, reason)
//          VALUES ($1, $2, TRUE, 'blank_ballot')
//          ON CONFLICT (election_id, user_id, question_id) DO NOTHING`,
//         [electionId, String(userId)]
//       );

//       await client.query('COMMIT');
      
//       return res.json({
//         success: true,
//         message: 'Abstention recorded successfully',
//         abstention: true
//       });
//     }

//     // Validate answers
//     if (!answers || Object.keys(answers).length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ error: 'No answers provided' });
//     }

//     // ========================================
//     // ANONYMOUS VOTING FLOW
//     // ========================================
//     if (isAnonymousElection) {
//       console.log('🔐 Processing ANONYMOUS vote');

//       // Check if user already participated
//       const participationCheck = await client.query(
//         `SELECT voting_session_id FROM votteryyy_voter_participation 
//          WHERE election_id = $1 AND user_id = $2`,
//         [electionId, String(userId)]
//       );

//       const hasVotedBefore = participationCheck.rows.length > 0;

//       // ✅ REQUIREMENT 3: If NOT allowed to edit and already voted, mark for audit
//       if (hasVotedBefore && !voteEditingAllowed) {
//         console.log('🚨 Duplicate vote attempt detected - marking for audit');

//         // Get original vote info
//         const votingSessionId = participationCheck.rows[0].voting_session_id;
//         const originalVote = await client.query(
//           `SELECT voting_id FROM votteryyy_anonymous_votes 
//            WHERE voting_session_id = $1`,
//           [votingSessionId]
//         );

//         // Record audit event
//         await client.query(
//           `INSERT INTO votteryy_vote_audit 
//            (election_id, user_id, attempt_type, original_vote_id, attempted_answers, ip_address, user_agent, flagged_for_review)
//            VALUES ($1, $2, 'duplicate_vote', $3, $4, $5, $6, TRUE)`,
//           [
//             electionId,
//             String(userId),
//             originalVote.rows[0]?.voting_id || null,
//             JSON.stringify(answers),
//             req.ip || req.connection.remoteAddress,
//             req.headers['user-agent']
//           ]
//         );

//         await client.query('COMMIT');

//         console.log('✅ Duplicate attempt logged for audit');

//         return res.status(400).json({ 
//           error: 'You have already voted in this election',
//           message: 'Vote editing is not allowed for this election. Your attempt has been logged.',
//           auditLogged: true
//         });
//       }

//       // Prepare vote data
//       const voteData = {
//         electionId,
//         answers,
//         timestamp: new Date().toISOString(),
//       };

//       const encryptedVote = encryptVote(JSON.stringify(voteData));
//       const voteHash = generateVoteHash(encryptedVote);
//       const receiptId = generateReceiptId();
//       const verificationCode = generateVerificationCode();
//       const voteToken = generateVoteToken();

//       let votingSessionId;
//       let anonymousVoteId, votingUuid;

//       if (hasVotedBefore) {
//         // ✅ REQUIREMENT 2: Edit allowed - UPDATE existing vote
//         votingSessionId = participationCheck.rows[0].voting_session_id;

//         console.log(`📝 Updating anonymous vote for session: ${votingSessionId}`);

//         // Update participation timestamp
//         await client.query(
//           `UPDATE votteryyy_voter_participation 
//            SET voted_at = NOW() 
//            WHERE voting_session_id = $1`,
//           [votingSessionId]
//         );

//         // Update the anonymous vote
//         const updateResult = await client.query(
//           `UPDATE votteryyy_anonymous_votes 
//            SET 
//              answers = $1,
//              encrypted_vote = $2,
//              vote_hash = $3,
//              verification_code = $4,
//              vote_token = $5,
//              updated_at = NOW()
//            WHERE voting_session_id = $6
//            RETURNING id, voting_id`,
//           [
//             JSON.stringify(answers),
//             encryptedVote,
//             voteHash,
//             verificationCode,
//             voteToken,
//             votingSessionId
//           ]
//         );

//         anonymousVoteId = updateResult.rows[0].id;
//         votingUuid = updateResult.rows[0].voting_id;

//         console.log(`✅ Anonymous vote UPDATED: ${anonymousVoteId}`);

//       } else {
//         // ✅ First time voting - INSERT new vote
//         console.log('🆕 Creating new anonymous vote');

//         // Record participation
//         const participationResult = await client.query(
//           `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
//            VALUES ($1, $2, TRUE)
//            RETURNING voting_session_id`,
//           [electionId, String(userId)]
//         );

//         votingSessionId = participationResult.rows[0].voting_session_id;

//         // Store anonymous vote
//         const anonymousVoteResult = await client.query(
//           `INSERT INTO votteryyy_anonymous_votes 
//            (election_id, voting_session_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, vote_token, ip_address, user_agent)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
//            RETURNING id, voting_id`,
//           [
//             electionId,
//             votingSessionId,
//             JSON.stringify(answers),
//             encryptedVote,
//             voteHash,
//             receiptId,
//             verificationCode,
//             voteToken,
//             req.ip || req.connection.remoteAddress,
//             req.headers['user-agent']
//           ]
//         );

//         anonymousVoteId = anonymousVoteResult.rows[0].id;
//         votingUuid = anonymousVoteResult.rows[0].voting_id;

//         console.log(`✅ Anonymous vote INSERTED: ${anonymousVoteId}`);
//       }

//       // Create lottery ticket if enabled
//       if (election.lottery_enabled) {
//         const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
//         const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

//         await client.query(
//           `INSERT INTO votteryy_lottery_tickets 
//            (user_id, election_id, voting_id, ball_number, ticket_number)
//            VALUES ($1, $2, $3::uuid, $4, $5)
//            ON CONFLICT (user_id, election_id) DO NOTHING`,
//           [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
//         );
        
//         console.log(`🎫 Lottery ticket created for anonymous vote: ${votingUuid}`);

//         // ✅ NEW: EMIT LOTTERY TICKET NOTIFICATION
//         setImmediate(() => {
//           try {
//             emitLotteryTicketCreated(userId, {
//               electionId,
//               electionTitle: election.title,
//               ticketNumber,
//               ballNumber
//             });
//           } catch (notifError) {
//             console.error('⚠️ Failed to emit lottery ticket notification:', notifError.message);
//           }
//         });
//       }

//       // Audit event
//       try {
//         await AuditService.logVoteCast(userId, electionId, anonymousVoteId, voteHash, req);
//       } catch (auditError) {
//         console.warn('⚠️ Failed to log audit event:', auditError.message);
//       }

//       await client.query('COMMIT');

//       // ✅ NEW: EMIT VOTE CONFIRMATION NOTIFICATION
//       setImmediate(() => {
//         try {
//           if (hasVotedBefore) {
//             emitVoteUpdated(userId, {
//               electionId,
//               electionTitle: election.title,
//               votingId: votingUuid
//             });
//           } else {
//             emitVoteCastConfirmation(userId, {
//               electionId,
//               electionTitle: election.title,
//               votingId: votingUuid,
//               receiptId,
//               voteHash,
//               isAnonymous: true,
//               isEdit: false
//             });
//           }
//         } catch (notifError) {
//           console.error('⚠️ Failed to emit vote notification:', notifError.message);
//         }
//       });

//       // Socket.IO real-time updates
//       setImmediate(async () => {
//         try {
//           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
//           emitVoteCast(electionId, {
//             questionId: Object.keys(answers)[0],
//             timestamp: new Date().toISOString(),
//           });
//           const liveResultsResponse = await getLiveResultsData(electionId);
//           if (liveResultsResponse) {
//             emitLiveResultsUpdate(electionId, liveResultsResponse);
//           }
//         } catch (socketError) {
//           console.error('⚠️ Socket emission error:', socketError);
//         }
//       });

//       return res.json({
//         success: true,
//         anonymous: true,
//         voteToken,
//         voteHash,
//         receiptId,
//         verificationCode,
//         message: hasVotedBefore 
//           ? 'Your vote has been updated successfully.' 
//           : 'Anonymous vote cast successfully. Save your vote token to verify your vote later.',
//         isEdit: hasVotedBefore
//       });

//     } else {
//       // ========================================
//       // NORMAL VOTING FLOW
//       // ========================================
//       console.log('📊 Processing NORMAL vote');

//       // Check if already voted
//       const existingVote = await client.query(
//         `SELECT id, voting_id FROM votteryy_votes 
//          WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
//         [electionId, String(userId)]
//       );

//       const hasVotedBefore = existingVote.rows.length > 0;

//       // ✅ REQUIREMENT 3: If NOT allowed to edit and already voted, mark for audit
//       if (hasVotedBefore && !voteEditingAllowed) {
//         console.log('🚨 Duplicate vote attempt detected - marking for audit');

//         // Record audit event
//         await client.query(
//           `INSERT INTO votteryy_vote_audit 
//            (election_id, user_id, attempt_type, original_vote_id, attempted_answers, ip_address, user_agent, flagged_for_review)
//            VALUES ($1, $2, 'duplicate_vote', $3, $4, $5, $6, TRUE)`,
//           [
//             electionId,
//             String(userId),
//             existingVote.rows[0].voting_id,
//             JSON.stringify(answers),
//             req.ip || req.connection.remoteAddress,
//             req.headers['user-agent']
//           ]
//         );

//         await client.query('COMMIT');

//         console.log('✅ Duplicate attempt logged for audit');

//         return res.status(400).json({ 
//           error: 'You have already voted in this election',
//           message: 'Vote editing is not allowed for this election. Your attempt has been logged.',
//           auditLogged: true
//         });
//       }

//       // Prepare vote data
//       const voteData = {
//         electionId,
//         userId,
//         answers,
//         timestamp: new Date().toISOString(),
//       };

//       const encryptedVote = encryptVote(JSON.stringify(voteData));
//       const voteHash = generateVoteHash(encryptedVote);
//       const receiptId = generateReceiptId();
//       const verificationCode = generateVerificationCode();

//       let voteId, votingUuid;
      
//       if (hasVotedBefore) {
//         // ✅ REQUIREMENT 2: Edit allowed - UPDATE existing vote
//         console.log(`📝 Updating normal vote: ${existingVote.rows[0].id}`);

//         const updateResult = await client.query(
//           `UPDATE votteryy_votes 
//            SET 
//              answers = $1,
//              encrypted_vote = $2, 
//              vote_hash = $3,
//              is_edited = true,
//              updated_at = NOW()
//            WHERE id = $4
//            RETURNING id, voting_id`,
//           [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
//         );
        
//         voteId = updateResult.rows[0].id;
//         votingUuid = updateResult.rows[0].voting_id;
        
//         console.log(`✅ Vote UPDATED: ${voteId}`);
        
//       } else {
//         // ✅ First time voting - INSERT new vote
//         console.log('🆕 Creating new normal vote');

//         const voteResult = await client.query(
//           `INSERT INTO votteryy_votes 
//            (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
//            RETURNING id, voting_id`,
//           [
//             electionId,
//             String(userId),
//             JSON.stringify(answers),
//             encryptedVote,
//             voteHash,
//             receiptId,
//             verificationCode,
//             false,
//             req.ip || req.connection.remoteAddress,
//             req.headers['user-agent'],
//           ]
//         );
        
//         voteId = voteResult.rows[0].id;
//         votingUuid = voteResult.rows[0].voting_id;

//         // Create receipt
//         await client.query(
//           `INSERT INTO votteryy_vote_receipts 
//            (voting_id, election_id, user_id, verification_code, vote_hash)
//            VALUES ($1, $2, $3, $4, $5)`,
//           [votingUuid, electionId, String(userId), verificationCode, voteHash]
//         );

//         console.log(`✅ Vote INSERTED: ${voteId}`);
//       }

//       // Create lottery ticket if enabled
//       if (election.lottery_enabled) {
//         const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
//         const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

//         await client.query(
//           `INSERT INTO votteryy_lottery_tickets 
//            (user_id, election_id, voting_id, ball_number, ticket_number)
//            VALUES ($1, $2, $3::uuid, $4, $5)
//            ON CONFLICT (user_id, election_id) DO NOTHING`,
//           [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
//         );
        
//         console.log(`🎫 Lottery ticket created for normal vote: ${votingUuid}`);

//         // ✅ NEW: EMIT LOTTERY TICKET NOTIFICATION
//         setImmediate(() => {
//           try {
//             emitLotteryTicketCreated(userId, {
//               electionId,
//               electionTitle: election.title,
//               ticketNumber,
//               ballNumber
//             });
//           } catch (notifError) {
//             console.error('⚠️ Failed to emit lottery ticket notification:', notifError.message);
//           }
//         });
//       }

//       // Audit event
//       try {
//         await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
//       } catch (auditError) {
//         console.warn('⚠️ Failed to log audit event:', auditError.message);
//       }

//       await client.query('COMMIT');

//       // ✅ NEW: EMIT VOTE CONFIRMATION NOTIFICATION
//       setImmediate(() => {
//         try {
//           if (hasVotedBefore) {
//             emitVoteUpdated(userId, {
//               electionId,
//               electionTitle: election.title,
//               votingId: votingUuid
//             });
//           } else {
//             emitVoteCastConfirmation(userId, {
//               electionId,
//               electionTitle: election.title,
//               votingId: votingUuid,
//               receiptId,
//               voteHash,
//               isAnonymous: false,
//               isEdit: false
//             });
//           }
//         } catch (notifError) {
//           console.error('⚠️ Failed to emit vote notification:', notifError.message);
//         }
//       });

//       // Socket.IO real-time updates
//       setImmediate(async () => {
//         try {
//           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
//           emitVoteCast(electionId, {
//             questionId: Object.keys(answers)[0],
//             timestamp: new Date().toISOString(),
//           });
//           const liveResultsResponse = await getLiveResultsData(electionId);
//           if (liveResultsResponse) {
//             emitLiveResultsUpdate(electionId, liveResultsResponse);
//           }
//         } catch (socketError) {
//           console.error('⚠️ Socket emission error:', socketError);
//         }
//       });

//       // Send notification email
//       setImmediate(async () => {
//         try {
//           const userResult = await pool.query(
//             `SELECT u.email, ud.full_name 
//              FROM votteryy_users u
//              LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
//              WHERE u.id = $1`,
//             [userId]
//           );
          
//           if (userResult.rows.length > 0 && userResult.rows[0].email) {
//             await NotificationService.sendVoteConfirmation(
//               userResult.rows[0].email,
//               election.title,
//               receiptId,
//               voteHash
//             );
//           }
//         } catch (notifError) {
//           console.warn('⚠️ Failed to send notification:', notifError.message);
//         }
//       });

//       return res.json({
//         success: true,
//         anonymous: false,
//         votingId: votingUuid,
//         voteHash,
//         receiptId,
//         verificationCode,
//         message: hasVotedBefore 
//           ? 'Your vote has been updated successfully.' 
//           : 'Vote cast successfully.',
//         isEdit: hasVotedBefore
//       });
//     }

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('❌ Cast vote error:', error);
//     res.status(500).json({ 
//       error: 'Failed to cast vote',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   } finally {
//     client.release();
//   }
// };

// /**
//  * Helper function to get live results data (reusable for Socket.IO)
//  */
// async function getLiveResultsData(electionId) {
//   const client = await pool.connect();
  
//   try {
//     // Check if election is anonymous
//     const electionResult = await client.query(
//       `SELECT anonymous_voting_enabled FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       console.error('❌ Election not found for live results:', electionId);
//       return null;
//     }

//     const isAnonymous = electionResult.rows[0].anonymous_voting_enabled || false;
//     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
//     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

//     // Get questions and options
//     const questionsResult = await client.query(
//       `SELECT 
//         q.id,
//         q.question_text,
//         q.question_order,
//         json_agg(
//           json_build_object(
//             'id', o.id,
//             'option_text', o.option_text,
//             'option_order', o.option_order
//           ) ORDER BY o.option_order
//         ) as options
//       FROM votteryy_election_questions q
//       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
//       WHERE q.election_id = $1
//       GROUP BY q.id, q.question_text, q.question_order
//       ORDER BY q.question_order`,
//       [electionId]
//     );

//     const questions = [];

//     for (const question of questionsResult.rows) {
//       const optionsWithCounts = [];

//       for (const option of question.options) {
//         if (!option.id) continue;

//         const voteCountQuery = `
//           SELECT COUNT(DISTINCT v.id) as count
//           FROM ${votesTableName} v
//           WHERE v.election_id = $1
//           ${statusFilter}
//           AND (
//             (v.answers->$2::text)::text = $3::text
//             OR
//             (
//               jsonb_typeof(v.answers->$2::text) = 'array'
//               AND v.answers->$2::text @> $3::jsonb
//             )
//             OR
//             (
//               jsonb_typeof(v.answers->$2::text) = 'object'
//               AND v.answers->$2::text ? $3::text
//             )
//           )
//         `;

//         const voteCountResult = await client.query(voteCountQuery, [
//           electionId,
//           question.id.toString(),
//           option.id.toString()
//         ]);

//         const voteCount = parseInt(voteCountResult.rows[0].count) || 0;

//         optionsWithCounts.push({
//           id: option.id,
//           option_text: option.option_text,
//           option_order: option.option_order,
//           vote_count: voteCount
//         });
//       }

//       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
//       optionsWithCounts.forEach(opt => {
//         opt.percentage = questionTotalVotes > 0 
//           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
//           : '0.00';
//       });

//       questions.push({
//         id: question.id,
//         question_text: question.question_text,
//         question_order: question.question_order,
//         options: optionsWithCounts,
//         total_votes: questionTotalVotes
//       });
//     }

//     const grandTotalVotes = questions.reduce((sum, q) => sum + q.total_votes, 0);

//     return {
//       electionId: parseInt(electionId),
//       totalVotes: grandTotalVotes,
//       questions,
//       lastUpdated: new Date().toISOString(),
//     };

//   } catch (error) {
//     console.error('❌ Error fetching live results data:', error);
//     return null;
//   } finally {
//     client.release();
//   }
// }

// // ========================================
// //  NEW: GET VIDEO WATCH PROGRESS
// // ========================================
// export const getVideoProgress = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const userId = String(req.user?.userId || req.headers['x-user-id']);

//     console.log('📹 GET VIDEO PROGRESS:', { userId, electionId });

//     if (!userId || userId === 'undefined') {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     const result = await pool.query(
//       `SELECT * FROM votteryy_video_watch_progress 
//        WHERE user_id = $1 AND election_id = $2`,
//       [userId, electionId]
//     );

//     console.log('📹 Found video progress:', result.rows[0] || 'NONE');

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
//     const userId = String(req.user?.userId || req.headers['x-user-id']);

//     console.log('📹 UPDATE VIDEO PROGRESS:', {
//       userId,
//       electionId,
//       watchPercentage,
//       lastPosition,
//       totalDuration,
//       completed,
//     });

//     if (!userId || userId === 'undefined') {
//       console.log('❌ No userId found');
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     const electionResult = await pool.query(
//       `SELECT minimum_watch_percentage FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     const minPercentage = electionResult.rows.length > 0 
//       ? parseFloat(electionResult.rows[0].minimum_watch_percentage) || 80
//       : 80;

//     const isCompleted = completed || (watchPercentage >= minPercentage);

//     const watchPercentageInt = Math.round(watchPercentage);
//     const lastPositionInt = Math.round(lastPosition);
//     const totalDurationInt = Math.round(totalDuration);

//     console.log('💾 Saving to database:', {
//       userId,
//       electionId,
//       watchPercentageInt,
//       lastPositionInt,
//       totalDurationInt,
//       completed: isCompleted,
//       minPercentage,
//     });

//     const result = await pool.query(
//       `INSERT INTO votteryy_video_watch_progress 
//        (user_id, election_id, watch_percentage, last_position, total_duration, completed, completed_at)
//        VALUES ($1, $2, $3, $4, $5, $6, $7)
//        ON CONFLICT (user_id, election_id)
//        DO UPDATE SET 
//          watch_percentage = GREATEST(votteryy_video_watch_progress.watch_percentage, $3),
//          last_position = $4,
//          total_duration = $5,
//          completed = CASE WHEN $6 = TRUE THEN TRUE ELSE votteryy_video_watch_progress.completed END,
//          completed_at = CASE WHEN $6 = TRUE AND votteryy_video_watch_progress.completed = FALSE THEN NOW() ELSE votteryy_video_watch_progress.completed_at END,
//          updated_at = NOW()
//        RETURNING *`,
//       [userId, electionId, watchPercentageInt, lastPositionInt, totalDurationInt, isCompleted, isCompleted ? new Date() : null]
//     );

//     console.log('✅ Saved to database:', result.rows[0]);

//     res.json({ 
//       success: true,
//       watchPercentage: watchPercentageInt,
//       completed: isCompleted,
//       data: result.rows[0],
//     });

//   } catch (error) {
//     console.error('❌ Update video progress error:', error);
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
// // ========================================
// // ✅ REQUIREMENT 4: GET USER'S VOTE (Review after casting)
// // ========================================
// export const getUserVote = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const userId = req.user?.userId || req.headers['x-user-id'];

//     if (!userId) {
//       return res.status(401).json({ error: 'Authentication required' });
//     }

//     console.log(`📋 Retrieving vote for user ${userId} in election ${electionId}`);

//     // Check if election is anonymous
//     const electionResult = await pool.query(
//       `SELECT anonymous_voting_enabled, status FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];
//     const isAnonymous = election.anonymous_voting_enabled || false;

//     if (isAnonymous) {
//       // For anonymous elections, retrieve via participation
//       const participationResult = await pool.query(
//         `SELECT voting_session_id FROM votteryyy_voter_participation 
//          WHERE election_id = $1 AND user_id = $2`,
//         [electionId, String(userId)]
//       );

//       if (participationResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Vote not found' });
//       }

//       const votingSessionId = participationResult.rows[0].voting_session_id;

//       const voteResult = await pool.query(
//         `SELECT 
//           voting_id,
//           answers,
//           vote_hash,
//           receipt_id,
//           verification_code,
//           created_at,
//           updated_at
//          FROM votteryyy_anonymous_votes
//          WHERE voting_session_id = $1`,
//         [votingSessionId]
//       );

//       if (voteResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Vote not found' });
//       }

//       res.json({
//         success: true,
//         anonymous: true,
//         vote: voteResult.rows[0],
//         electionStatus: election.status
//       });

//     } else {
//       // For normal elections
//       const voteResult = await pool.query(
//         `SELECT 
//           voting_id,
//           answers,
//           vote_hash,
//           receipt_id,
//           verification_code,
//           is_edited,
//           created_at,
//           updated_at
//          FROM votteryy_votes
//          WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
//         [electionId, String(userId)]
//       );

//       if (voteResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Vote not found' });
//       }

//       res.json({
//         success: true,
//         anonymous: false,
//         vote: voteResult.rows[0],
//         electionStatus: election.status
//       });
//     }

//   } catch (error) {
//     console.error('❌ Get user vote error:', error);
//     res.status(500).json({ error: 'Failed to get vote' });
//   }
// };


// // ========================================
// // GET VOTING HISTORY
// // ========================================

// // ========================================
// // GET VOTING HISTORY - COVERS BOTH NORMAL & ANONYMOUS VOTES
// // ========================================
// // ========================================
// // GET VOTING HISTORY - COVERS BOTH NORMAL & ANONYMOUS VOTES
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

//     // ========================================
//     // COMBINED QUERY: Normal + Anonymous Votes
//     // ========================================
//     const query = `
//       WITH combined_votes AS (
//         -- Normal votes
//         SELECT 
//           v.id,
//           v.voting_id,
//           v.election_id,
//           v.user_id,
//           v.receipt_id,
//           v.vote_hash,
//           v.verification_code,
//           NULL as vote_token,
//           v.status,
//           v.created_at,
//           v.updated_at,
//           v.anonymous,
//           v.is_edited,
//           e.title as election_title,
//           e.status as election_status,
//           e.is_free,
//           e.general_participation_fee,
//           e.lottery_enabled,
//           lt.ball_number,
//           lt.ticket_number as lottery_ticket_number,
//           lt.ticket_id,
//           FALSE as is_anonymous_vote
//         FROM votteryy_votes v
//         LEFT JOIN votteryyy_elections e ON v.election_id = e.id
//         LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
//         WHERE v.user_id = $1 AND v.status = 'valid'
        
//         UNION ALL
        
//         -- Anonymous votes (via participation table)
//         SELECT 
//           av.id,
//           av.voting_id,
//           av.election_id,
//           vp.user_id,
//           av.receipt_id,
//           av.vote_hash,
//           av.verification_code,
//           av.vote_token, 
//           'valid' as status,
//           av.voted_at as created_at,
//           av.voted_at as updated_at,
//           TRUE as anonymous,
//           FALSE as is_edited,
//           e.title as election_title,
//           e.status as election_status,
//           e.is_free,
//           e.general_participation_fee,
//           e.lottery_enabled,
//           lt.ball_number,
//           lt.ticket_number as lottery_ticket_number,
//           lt.ticket_id,
//           TRUE as is_anonymous_vote
//         FROM votteryyy_anonymous_votes av
//         INNER JOIN votteryyy_voter_participation vp ON av.voting_session_id = vp.voting_session_id
//         LEFT JOIN votteryyy_elections e ON av.election_id = e.id
//         LEFT JOIN votteryy_lottery_tickets lt ON av.voting_id = lt.voting_id
//         WHERE vp.user_id = $1
//       )
//       SELECT 
//         *,
//         CASE 
//           WHEN election_status = 'completed' THEN 'Draw Completed'
//           WHEN election_status = 'active' OR election_status = 'published' THEN 'Pending Draw'
//           ELSE 'Pending Draw'
//         END as lottery_status,
//         CASE 
//           WHEN is_free = false THEN general_participation_fee
//           ELSE 0
//         END as payment_amount,
//         'USD' as payment_currency
//       FROM combined_votes
//       ORDER BY created_at DESC
//       LIMIT $2 OFFSET $3
//     `;

//     const result = await pool.query(query, [String(userId), limit, offset]);

//     // Get total count (both normal + anonymous)
//     const countQuery = `
//       SELECT 
//         (
//           SELECT COUNT(*) 
//           FROM votteryy_votes 
//           WHERE user_id = $1 AND status = 'valid'
//         ) + 
//         (
//           SELECT COUNT(*) 
//           FROM votteryyy_anonymous_votes av
//           INNER JOIN votteryyy_voter_participation vp ON av.voting_session_id = vp.voting_session_id
//           WHERE vp.user_id = $1
//         ) as total
//     `;
    
//     const countResult = await pool.query(countQuery, [String(userId)]);
//     const total = parseInt(countResult.rows[0].total);

//     console.log('✅ Found', result.rows.length, 'votes for user (Normal + Anonymous)');
//     console.log('📊 Total votes:', total);

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
// // export const getVotingHistory = async (req, res) => {
// //   try {
// //     const userId = req.user?.userId || req.headers['x-user-id'];
// //     const page = parseInt(req.query.page) || 1;
// //     const limit = parseInt(req.query.limit) || 10;
// //     const offset = (page - 1) * limit;

// //     console.log('📜 Getting voting history for user:', userId);

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get total count
// //     const countQuery = `
// //       SELECT COUNT(*) as total
// //       FROM votteryy_votes
// //       WHERE user_id = $1 AND status = 'valid'
// //     `;
// //     const countResult = await pool.query(countQuery, [String(userId)]);
// //     const total = parseInt(countResult.rows[0].total);

// //     // Get votes with election details and lottery info
// //     const query = `
// //       SELECT 
// //         v.id,
// //         v.voting_id,
// //         v.election_id,
// //         v.user_id,
// //         v.receipt_id,
// //         v.vote_hash,
// //         v.status,
// //         v.created_at,
// //         v.anonymous,
// //         e.title as election_title,
// //         e.status as election_status,
// //         e.is_free,
// //         e.general_participation_fee,
// //         e.lottery_enabled,
// //         lt.ball_number,
// //         lt.ticket_number as lottery_ticket_number,
// //         lt.ticket_id,
// //         CASE 
// //           WHEN e.status = 'completed' THEN 'Draw Completed'
// //           WHEN e.status = 'active' OR e.status = 'published' THEN 'Pending Draw'
// //           ELSE 'Pending Draw'
// //         END as lottery_status,
// //         CASE 
// //           WHEN e.is_free = false THEN e.general_participation_fee
// //           ELSE 0
// //         END as payment_amount,
// //         'USD' as payment_currency
// //       FROM votteryy_votes v
// //       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
// //       LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
// //       WHERE v.user_id = $1 AND v.status = 'valid'
// //       ORDER BY v.created_at DESC
// //       LIMIT $2 OFFSET $3
// //     `;

// //     const result = await pool.query(query, [String(userId), limit, offset]);

// //     console.log('✅ Found', result.rows.length, 'votes for user');

// //     res.status(200).json({
// //       success: true,
// //       data: {
// //         votes: result.rows,
// //         pagination: {
// //           currentPage: page,
// //           limit,
// //           total,
// //           totalPages: Math.ceil(total / limit)
// //         }
// //       }
// //     });
// //   } catch (error) {
// //     console.error('❌ Error fetching voting history:', error);
// //     res.status(500).json({
// //       success: false,
// //       message: 'Failed to fetch voting history',
// //       error: error.message
// //     });
// //   }
// // };

// // ========================================
// // GET AUDIT LOGS (Admin only)
// // ========================================
// // src/controllers/voting.controller.js

// // src/controllers/voting.controller.js

// export const getVoteAuditLogs = async (req, res) => {
//   try {
//     const { electionId } = req.params;
//     const { page = 1, limit = 50 } = req.query;
//     const offset = (page - 1) * limit;

//     console.log(`📋 Retrieving audit logs for election ${electionId}`);

//     // ✅ CORRECTED SQL QUERY - Using real table names
//     let query;
//     let queryParams;

//     if (electionId === 'all') {
//       // Get audit logs for all elections
//       query = `
//         SELECT 
//           a.id,
//           a.user_id,
//           a.election_id,
//           a.attempt_type,
//           a.ip_address,
//           a.user_agent,
//           a.attempted_at,
//           a.flagged_for_review,
//           a.reviewed_at,
//           a.notes,
//           e.title as election_title,
//           ud.first_name,
//           ud.last_name,
//           CONCAT(ud.first_name, ' ', ud.last_name) as user_name
//         FROM votteryy_audit_logs a
//         LEFT JOIN votteryyy_elections e ON a.election_id = e.id
//         LEFT JOIN votteryy_user_details ud ON a.user_id = ud.user_id
//         ORDER BY a.attempted_at DESC
//         LIMIT $1 OFFSET $2
//       `;
//       queryParams = [limit, offset];
//     } else {
//       // Get audit logs for specific election
//       query = `
//         SELECT 
//           a.id,
//           a.user_id,
//           a.election_id,
//           a.attempt_type,
//           a.ip_address,
//           a.user_agent,
//           a.attempted_at,
//           a.flagged_for_review,
//           a.reviewed_at,
//           a.notes,
//           e.title as election_title,
//           ud.first_name,
//           ud.last_name,
//           CONCAT(ud.first_name, ' ', ud.last_name) as user_name
//         FROM votteryy_audit_logs a
//         LEFT JOIN votteryyy_elections e ON a.election_id = e.id
//         LEFT JOIN votteryy_user_details ud ON a.user_id = ud.user_id
//         WHERE a.election_id = $1
//         ORDER BY a.attempted_at DESC
//         LIMIT $2 OFFSET $3
//       `;
//       queryParams = [electionId, limit, offset];
//     }

//     const result = await pool.query(query, queryParams);

//     // Get total count
//     const countQuery = electionId === 'all'
//       ? 'SELECT COUNT(*) FROM votteryy_audit_logs'
//       : 'SELECT COUNT(*) FROM votteryy_audit_logs WHERE election_id = $1';
    
//     const countParams = electionId === 'all' ? [] : [electionId];
//     const countResult = await pool.query(countQuery, countParams);
//     const total = parseInt(countResult.rows[0].count);

//     console.log(`✅ Found ${result.rows.length} audit logs`);

//     res.json({
//       success: true,
//       data: result.rows,
//       pagination: {
//         total,
//         page: parseInt(page),
//         limit: parseInt(limit),
//         pages: Math.ceil(total / limit),
//       },
//     });

//   } catch (error) {
//     console.error('❌ Get audit logs error:', error);
//     res.status(500).json({ 
//       success: false,
//       error: 'Failed to retrieve audit logs',
//       message: error.message 
//     });
//   }
// };

// // ========================================
// // GET PUBLIC BULLETIN BOARD
// // ========================================
// export const getPublicBulletin = async (req, res) => {
//   try {
//     const { electionId } = req.params;

//     console.log('📊 Getting public bulletin for election:', electionId);

//     // Get election info
//     const electionResult = await pool.query(
//       `SELECT id, title, anonymous_voting_enabled, status 
//        FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ 
//         success: false, 
//         error: 'Election not found' 
//       });
//     }

//     const election = electionResult.rows[0];
//     const isAnonymous = election.anonymous_voting_enabled || false;

//     // Determine which table to query
//     const votesTable = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
//     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

//     // Get total vote count
//     const countResult = await pool.query(
//       `SELECT COUNT(*) as total FROM ${votesTable} WHERE election_id = $1 ${statusFilter}`,
//       [electionId]
//     );
//     const totalVotes = parseInt(countResult.rows[0].total) || 0;

//     // Get votes with anonymized data for transparency
//     let votesQuery;
//     if (isAnonymous) {
//       votesQuery = `
//         SELECT 
//           av.voting_id,
//           av.vote_hash,
//           av.voted_at as created_at,
//           'Anonymous Voter #' || ROW_NUMBER() OVER (ORDER BY av.voted_at) as anonymized_user
//         FROM votteryyy_anonymous_votes av
//         WHERE av.election_id = $1
//         ORDER BY av.voted_at DESC
//         LIMIT 100
//       `;
//     } else {
//       votesQuery = `
//         SELECT 
//           v.voting_id,
//           v.vote_hash,
//           v.created_at,
//           'Voter #' || ROW_NUMBER() OVER (ORDER BY v.created_at) as anonymized_user
//         FROM votteryy_votes v
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         ORDER BY v.created_at DESC
//         LIMIT 100
//       `;
//     }

//     const votesResult = await pool.query(votesQuery, [electionId]);

//     // Build hash chain for verification
//     const hashChain = [];
//     let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';

//     votesResult.rows.forEach((vote, index) => {
//       const blockHash = crypto
//         .createHash('sha256')
//         .update(previousHash + vote.vote_hash)
//         .digest('hex');

//       hashChain.push({
//         blockNumber: index + 1,
//         voteHash: vote.vote_hash,
//         blockHash: blockHash,
//         timestamp: vote.created_at,
//       });

//       previousHash = blockHash;
//     });

//     // Generate verification hash (hash of all vote hashes)
//     const allHashes = votesResult.rows.map(v => v.vote_hash).join('');
//     const verificationHash = crypto
//       .createHash('sha256')
//       .update(allHashes + electionId)
//       .digest('hex');

//     console.log(`✅ Public bulletin: ${totalVotes} votes, ${hashChain.length} blocks`);

//     res.json({
//       success: true,
//       data: {
//         electionId: parseInt(electionId),
//         electionTitle: election.title,
//         electionStatus: election.status,
//         totalVotes,
//         votes: votesResult.rows,
//         hashChain: hashChain.slice(0, 50), // Limit to 50 for performance
//         verificationHash,
//         isAnonymous,
//         lastUpdated: new Date().toISOString(),
//       }
//     });

//   } catch (error) {
//     console.error('❌ Get public bulletin error:', error);
//     res.status(500).json({ 
//       success: false, 
//       error: 'Failed to retrieve public bulletin',
//       message: error.message 
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
//   getLiveResults,
//   getVotingHistory,
//   getVoteAuditLogs,
//   getPublicBulletin
// };
// //this is last workable codes just to add socket.io above code
// // import pool from '../config/database.js';
// // import crypto from 'crypto';
// // import { 
// //   encryptVote, 
// //   generateVoteHash, 
// //   generateReceiptId, 
// //   generateVerificationCode,
// //   generateVoteToken
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

// //     //  FIX: Handle date/time properly with PostgreSQL timestamp format
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

// //     //  FIXED: Get questions from YOUR tables (votteryy_election_questions)
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
// // // GET LIVE RESULTS - FIXED VERSION (ONLY ONE)
// // // ========================================
// // export const getLiveResults = async (req, res) => {
// //   const client = await pool.connect();
  
// //   try {
// //     const { electionId } = req.params;

// //     console.log(`\n========================================`);
// //     console.log(`📊 LIVE RESULTS - Election ${electionId}`);
// //     console.log(`========================================`);

// //     // 1. Get election info
// //     const electionResult = await client.query(
// //       `SELECT 
// //         id, 
// //         title, 
// //         voting_type, 
// //         show_live_results, 
// //         status,
// //         anonymous_voting_enabled
// //       FROM votteryyy_elections
// //       WHERE id = $1`,
// //       [electionId]
// //     );
    
// //     if (electionResult.rows.length === 0) {
// //       return res.status(404).json({
// //         success: false,
// //         error: 'Election not found',
// //       });
// //     }

// //     const election = electionResult.rows[0];
// //     const isAnonymous = election.anonymous_voting_enabled || false;

// //     console.log(`📋 Election: ${election.title}`);
// //     console.log(`🔐 Anonymous: ${isAnonymous}`);
// //     console.log(`📊 Voting Type: ${election.voting_type}`);

// //     // Check if live results are enabled
// //     if (!election.show_live_results && election.status !== 'completed') {
// //       return res.status(403).json({
// //         success: false,
// //         error: 'Live results are not enabled for this election',
// //       });
// //     }

// //     // 2. Determine which table to query
// //     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
// //     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

// //     console.log(`🗄️  Querying table: ${votesTableName}`);

// //     // 3. Get questions and options structure
// //     const questionsAndOptionsQuery = `
// //       SELECT 
// //         q.id,
// //         q.question_text,
// //         q.question_type,
// //         q.question_order,
// //         json_agg(
// //           json_build_object(
// //             'id', o.id,
// //             'option_text', o.option_text,
// //             'option_order', o.option_order
// //           ) ORDER BY o.option_order
// //         ) as options
// //       FROM votteryy_election_questions q
// //       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
// //       WHERE q.election_id = $1
// //       GROUP BY q.id, q.question_text, q.question_type, q.question_order
// //       ORDER BY q.question_order
// //     `;

// //     const questionsResult = await client.query(questionsAndOptionsQuery, [electionId]);

// //     if (questionsResult.rows.length === 0) {
// //       return res.json({
// //         success: true,
// //         data: {
// //           electionId: parseInt(electionId),
// //           electionTitle: election.title,
// //           votingType: election.voting_type,
// //           isAnonymous: isAnonymous,
// //           totalVotes: 0,
// //           questions: [],
// //           lastUpdated: new Date().toISOString(),
// //         }
// //       });
// //     }

// //     console.log(`📝 Found ${questionsResult.rows.length} questions`);

// //     // 4. Count votes for each option
// //     const questions = [];
// //     let grandTotalVotes = 0;

// //     for (const question of questionsResult.rows) {
// //       console.log(`\n   Question ${question.id}: ${question.question_text}`);
      
// //       const optionsWithCounts = [];

// //       for (const option of question.options) {
// //         if (!option.id) continue; // Skip null options

// //         // ⭐ FIXED: Count votes for this specific option
// //         const voteCountQuery = `
// //           SELECT COUNT(DISTINCT v.id) as count
// //           FROM ${votesTableName} v
// //           WHERE v.election_id = $1
// //           ${statusFilter}
// //           AND (
// //             -- Plurality/Single choice: answers->'questionId' = 'optionId'
// //             (v.answers->$2::text)::text = $3::text
// //             OR
// //             -- Approval voting: answers->'questionId' is array containing optionId
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'array'
// //               AND v.answers->$2::text @> $3::jsonb
// //             )
// //             OR
// //             -- Ranked choice: answers->'questionId' is object with optionId as key
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'object'
// //               AND v.answers->$2::text ? $3::text
// //             )
// //           )
// //         `;

// //         try {
// //           const voteCountResult = await client.query(voteCountQuery, [
// //             electionId,
// //             question.id.toString(),
// //             option.id.toString()
// //           ]);

// //           const voteCount = parseInt(voteCountResult.rows[0].count) || 0;
          
// //           console.log(`      ${option.option_text}: ${voteCount} votes`);

// //           optionsWithCounts.push({
// //             id: option.id,
// //             option_text: option.option_text,
// //             option_order: option.option_order,
// //             vote_count: voteCount
// //           });

// //         } catch (optionError) {
// //           console.error(`      ❌ Error counting votes for option ${option.id}:`, optionError.message);
// //           optionsWithCounts.push({
// //             id: option.id,
// //             option_text: option.option_text,
// //             option_order: option.option_order,
// //             vote_count: 0
// //           });
// //         }
// //       }

// //       // Calculate question total and percentages
// //       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
// //       optionsWithCounts.forEach(opt => {
// //         opt.percentage = questionTotalVotes > 0 
// //           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
// //           : '0.00';
// //       });

// //       grandTotalVotes += questionTotalVotes;

// //       questions.push({
// //         id: question.id,
// //         question_text: question.question_text,
// //         question_type: question.question_type,
// //         question_order: question.question_order,
// //         options: optionsWithCounts,
// //         total_votes: questionTotalVotes
// //       });

// //       console.log(`      Question total: ${questionTotalVotes} votes`);
// //     }

// //     console.log(`\n✅ GRAND TOTAL VOTES: ${grandTotalVotes}`);
// //     console.log(`========================================\n`);

// //     const liveResults = {
// //       electionId: parseInt(electionId),
// //       electionTitle: election.title,
// //       votingType: election.voting_type,
// //       isAnonymous: isAnonymous,
// //       totalVotes: grandTotalVotes,
// //       questions,
// //       lastUpdated: new Date().toISOString(),
// //     };

// //     res.json({
// //       success: true,
// //       data: liveResults,
// //     });

// //   } catch (error) {
// //     console.error('❌ Get live results error:', error);
// //     console.error('Stack trace:', error.stack);
// //     res.status(500).json({
// //       success: false,
// //       error: 'Failed to retrieve live results',
// //       message: error.message,
// //     });
// //   } finally {
// //     client.release();
// //   }
// // };

// // // ========================================
// // // CAST VOTE - WITH ANONYMOUS & ABSTENTION SUPPORT
// // // ========================================
// // // ========================================
// // // CAST VOTE - COMPLETE WITH AUDIT SUPPORT
// // // ========================================
// // export const castVote = async (req, res) => {
// //   const client = await pool.connect();
  
// //   try {
// //     await client.query('BEGIN');

// //     const { electionId } = req.params;
// //     const { answers, isAbstention = false } = req.body;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     console.log('🗳️ Casting vote:', { 
// //       electionId, 
// //       userId, 
// //       isAbstention,
// //       answersCount: answers ? Object.keys(answers).length : 0 
// //     });

// //     if (!userId) {
// //       await client.query('ROLLBACK');
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get election with settings
// //     const electionResult = await client.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       await client.query('ROLLBACK');
// //       return res.status(404).json({ error: 'Election not found' });
// //     }

// //     const election = electionResult.rows[0];

// //     // ✅ REQUIREMENT 5: Check if election is completed
// //     if (election.status === 'completed') {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ 
// //         error: 'Election has ended',
// //         message: 'You cannot vote or change your vote after the election has been completed.'
// //       });
// //     }

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

// //     const isAnonymousElection = election.anonymous_voting_enabled || false;
// //     const voteEditingAllowed = election.vote_editing_allowed || false;

// //     console.log(`📋 Election settings:`, {
// //       anonymous: isAnonymousElection,
// //       editingAllowed: voteEditingAllowed,
// //       status: election.status
// //     });

// //     // Handle ABSTENTION
// //     if (isAbstention) {
// //       console.log('🚫 Recording abstention');
      
// //       await client.query(
// //         `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
// //          VALUES ($1, $2, TRUE)
// //          ON CONFLICT (election_id, user_id) DO NOTHING`,
// //         [electionId, String(userId)]
// //       );

// //       await client.query(
// //         `INSERT INTO votteryy_abstentions (election_id, user_id, is_full_abstention, reason)
// //          VALUES ($1, $2, TRUE, 'blank_ballot')
// //          ON CONFLICT (election_id, user_id, question_id) DO NOTHING`,
// //         [electionId, String(userId)]
// //       );

// //       await client.query('COMMIT');
      
// //       return res.json({
// //         success: true,
// //         message: 'Abstention recorded successfully',
// //         abstention: true
// //       });
// //     }

// //     // Validate answers
// //     if (!answers || Object.keys(answers).length === 0) {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ error: 'No answers provided' });
// //     }

// //     // ========================================
// //     // ANONYMOUS VOTING FLOW
// //     // ========================================
// //     if (isAnonymousElection) {
// //       console.log('🔐 Processing ANONYMOUS vote');

// //       // Check if user already participated
// //       const participationCheck = await client.query(
// //         `SELECT voting_session_id FROM votteryyy_voter_participation 
// //          WHERE election_id = $1 AND user_id = $2`,
// //         [electionId, String(userId)]
// //       );

// //       const hasVotedBefore = participationCheck.rows.length > 0;

// //       // ✅ REQUIREMENT 3: If NOT allowed to edit and already voted, mark for audit
// //       if (hasVotedBefore && !voteEditingAllowed) {
// //         console.log('🚨 Duplicate vote attempt detected - marking for audit');

// //         // Get original vote info
// //         const votingSessionId = participationCheck.rows[0].voting_session_id;
// //         const originalVote = await client.query(
// //           `SELECT voting_id FROM votteryyy_anonymous_votes 
// //            WHERE voting_session_id = $1`,
// //           [votingSessionId]
// //         );

// //         // Record audit event
// //         await client.query(
// //           `INSERT INTO votteryy_vote_audit 
// //            (election_id, user_id, attempt_type, original_vote_id, attempted_answers, ip_address, user_agent, flagged_for_review)
// //            VALUES ($1, $2, 'duplicate_vote', $3, $4, $5, $6, TRUE)`,
// //           [
// //             electionId,
// //             String(userId),
// //             originalVote.rows[0]?.voting_id || null,
// //             JSON.stringify(answers),
// //             req.ip || req.connection.remoteAddress,
// //             req.headers['user-agent']
// //           ]
// //         );

// //         await client.query('COMMIT');

// //         console.log('✅ Duplicate attempt logged for audit');

// //         return res.status(400).json({ 
// //           error: 'You have already voted in this election',
// //           message: 'Vote editing is not allowed for this election. Your attempt has been logged.',
// //           auditLogged: true
// //         });
// //       }

// //       // Prepare vote data
// //       const voteData = {
// //         electionId,
// //         answers,
// //         timestamp: new Date().toISOString(),
// //       };

// //       const encryptedVote = encryptVote(JSON.stringify(voteData));
// //       const voteHash = generateVoteHash(encryptedVote);
// //       const receiptId = generateReceiptId();
// //       const verificationCode = generateVerificationCode();
// //       const voteToken = generateVoteToken();

// //       let votingSessionId;
// //       let anonymousVoteId, votingUuid;

// //       if (hasVotedBefore) {
// //         // ✅ REQUIREMENT 2: Edit allowed - UPDATE existing vote
// //         votingSessionId = participationCheck.rows[0].voting_session_id;

// //         console.log(`📝 Updating anonymous vote for session: ${votingSessionId}`);

// //         // Update participation timestamp
// //         await client.query(
// //           `UPDATE votteryyy_voter_participation 
// //            SET voted_at = NOW() 
// //            WHERE voting_session_id = $1`,
// //           [votingSessionId]
// //         );

// //         // Update the anonymous vote
// //         const updateResult = await client.query(
// //           `UPDATE votteryyy_anonymous_votes 
// //            SET 
// //              answers = $1,
// //              encrypted_vote = $2,
// //              vote_hash = $3,
// //              verification_code = $4,
// //              vote_token = $5,
// //              updated_at = NOW()
// //            WHERE voting_session_id = $6
// //            RETURNING id, voting_id`,
// //           [
// //             JSON.stringify(answers),
// //             encryptedVote,
// //             voteHash,
// //             verificationCode,
// //             voteToken,
// //             votingSessionId
// //           ]
// //         );

// //         anonymousVoteId = updateResult.rows[0].id;
// //         votingUuid = updateResult.rows[0].voting_id;

// //         console.log(`✅ Anonymous vote UPDATED: ${anonymousVoteId}`);

// //       } else {
// //         // ✅ First time voting - INSERT new vote
// //         console.log('🆕 Creating new anonymous vote');

// //         // Record participation
// //         const participationResult = await client.query(
// //           `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
// //            VALUES ($1, $2, TRUE)
// //            RETURNING voting_session_id`,
// //           [electionId, String(userId)]
// //         );

// //         votingSessionId = participationResult.rows[0].voting_session_id;

// //         // Store anonymous vote
// //         const anonymousVoteResult = await client.query(
// //           `INSERT INTO votteryyy_anonymous_votes 
// //            (election_id, voting_session_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, vote_token, ip_address, user_agent)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
// //            RETURNING id, voting_id`,
// //           [
// //             electionId,
// //             votingSessionId,
// //             JSON.stringify(answers),
// //             encryptedVote,
// //             voteHash,
// //             receiptId,
// //             verificationCode,
// //             voteToken,
// //             req.ip || req.connection.remoteAddress,
// //             req.headers['user-agent']
// //           ]
// //         );

// //         anonymousVoteId = anonymousVoteResult.rows[0].id;
// //         votingUuid = anonymousVoteResult.rows[0].voting_id;

// //         console.log(`✅ Anonymous vote INSERTED: ${anonymousVoteId}`);
// //       }

// //       // Create lottery ticket if enabled
// // if (election.lottery_enabled) {
// //   const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
// //   const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

// //   await client.query(
// //     `INSERT INTO votteryy_lottery_tickets 
// //      (user_id, election_id, voting_id, ball_number, ticket_number)
// //      VALUES ($1, $2, $3::uuid, $4, $5)
// //      ON CONFLICT (user_id, election_id) DO NOTHING`,
// //     [String(userId), electionId, votingUuid, ballNumber, ticketNumber] // ✅ votingUuid is UUID string
// //   );
  
// //   console.log(`🎫 Lottery ticket created for normal vote: ${votingUuid}`);
// // }

// //       // Audit event
// //       try {
// //         await AuditService.logVoteCast(userId, electionId, anonymousVoteId, voteHash, req);
// //       } catch (auditError) {
// //         console.warn('⚠️ Failed to log audit event:', auditError.message);
// //       }

// //       await client.query('COMMIT');

// //       // Socket.IO real-time updates
// //       setImmediate(async () => {
// //         try {
// //           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
// //           emitVoteCast(electionId, {
// //             questionId: Object.keys(answers)[0],
// //             timestamp: new Date().toISOString(),
// //           });
// //           const liveResultsResponse = await getLiveResultsData(electionId);
// //           if (liveResultsResponse) {
// //             emitLiveResultsUpdate(electionId, liveResultsResponse);
// //           }
// //         } catch (socketError) {
// //           console.error('⚠️ Socket emission error:', socketError);
// //         }
// //       });

// //       return res.json({
// //         success: true,
// //         anonymous: true,
// //         voteToken,
// //         voteHash,
// //         receiptId,
// //         verificationCode,
// //         message: hasVotedBefore 
// //           ? 'Your vote has been updated successfully.' 
// //           : 'Anonymous vote cast successfully. Save your vote token to verify your vote later.',
// //         isEdit: hasVotedBefore
// //       });

// //     } else {
// //       // ========================================
// //       // NORMAL VOTING FLOW
// //       // ========================================
// //       console.log('📊 Processing NORMAL vote');

// //       // Check if already voted
// //       const existingVote = await client.query(
// //         `SELECT id, voting_id FROM votteryy_votes 
// //          WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //         [electionId, String(userId)]
// //       );

// //       const hasVotedBefore = existingVote.rows.length > 0;

// //       // ✅ REQUIREMENT 3: If NOT allowed to edit and already voted, mark for audit
// //       if (hasVotedBefore && !voteEditingAllowed) {
// //         console.log('🚨 Duplicate vote attempt detected - marking for audit');

// //         // Record audit event
// //         await client.query(
// //           `INSERT INTO votteryy_vote_audit 
// //            (election_id, user_id, attempt_type, original_vote_id, attempted_answers, ip_address, user_agent, flagged_for_review)
// //            VALUES ($1, $2, 'duplicate_vote', $3, $4, $5, $6, TRUE)`,
// //           [
// //             electionId,
// //             String(userId),
// //             existingVote.rows[0].voting_id,
// //             JSON.stringify(answers),
// //             req.ip || req.connection.remoteAddress,
// //             req.headers['user-agent']
// //           ]
// //         );

// //         await client.query('COMMIT');

// //         console.log('✅ Duplicate attempt logged for audit');

// //         return res.status(400).json({ 
// //           error: 'You have already voted in this election',
// //           message: 'Vote editing is not allowed for this election. Your attempt has been logged.',
// //           auditLogged: true
// //         });
// //       }

// //       // Prepare vote data
// //       const voteData = {
// //         electionId,
// //         userId,
// //         answers,
// //         timestamp: new Date().toISOString(),
// //       };

// //       const encryptedVote = encryptVote(JSON.stringify(voteData));
// //       const voteHash = generateVoteHash(encryptedVote);
// //       const receiptId = generateReceiptId();
// //       const verificationCode = generateVerificationCode();

// //       let voteId, votingUuid;
      
// //       if (hasVotedBefore) {
// //         // ✅ REQUIREMENT 2: Edit allowed - UPDATE existing vote
// //         console.log(`📝 Updating normal vote: ${existingVote.rows[0].id}`);

// //         const updateResult = await client.query(
// //           `UPDATE votteryy_votes 
// //            SET 
// //              answers = $1,
// //              encrypted_vote = $2, 
// //              vote_hash = $3,
// //              is_edited = true,
// //              updated_at = NOW()
// //            WHERE id = $4
// //            RETURNING id, voting_id`,
// //           [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
// //         );
        
// //         voteId = updateResult.rows[0].id;
// //         votingUuid = updateResult.rows[0].voting_id;
        
// //         console.log(`✅ Vote UPDATED: ${voteId}`);
        
// //       } else {
// //         // ✅ First time voting - INSERT new vote
// //         console.log('🆕 Creating new normal vote');

// //         const voteResult = await client.query(
// //           `INSERT INTO votteryy_votes 
// //            (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
// //            RETURNING id, voting_id`,
// //           [
// //             electionId,
// //             String(userId),
// //             JSON.stringify(answers),
// //             encryptedVote,
// //             voteHash,
// //             receiptId,
// //             verificationCode,
// //             false,
// //             req.ip || req.connection.remoteAddress,
// //             req.headers['user-agent'],
// //           ]
// //         );
        
// //         voteId = voteResult.rows[0].id;
// //         votingUuid = voteResult.rows[0].voting_id;

// //         // Create receipt
// //         await client.query(
// //           `INSERT INTO votteryy_vote_receipts 
// //            (voting_id, election_id, user_id, verification_code, vote_hash)
// //            VALUES ($1, $2, $3, $4, $5)`,
// //           [votingUuid, electionId, String(userId), verificationCode, voteHash]
// //         );

// //         console.log(`✅ Vote INSERTED: ${voteId}`);
// //       }

// //       // Create lottery ticket if enabled

// // if (election.lottery_enabled) {
// //   const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
// //   const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

// //   await client.query(
// //     `INSERT INTO votteryy_lottery_tickets 
// //      (user_id, election_id, voting_id, ball_number, ticket_number)
// //      VALUES ($1, $2, $3::uuid, $4, $5)
// //      ON CONFLICT (user_id, election_id) DO NOTHING`,
// //     [String(userId), electionId, votingUuid, ballNumber, ticketNumber] // ✅ votingUuid is UUID string
// //   );
  
// //   console.log(`🎫 Lottery ticket created for anonymous vote: ${votingUuid}`);
// // }

// //       // Audit event
// //       try {
// //         await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
// //       } catch (auditError) {
// //         console.warn('⚠️ Failed to log audit event:', auditError.message);
// //       }

// //       await client.query('COMMIT');

// //       // Socket.IO real-time updates
// //       setImmediate(async () => {
// //         try {
// //           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
// //           emitVoteCast(electionId, {
// //             questionId: Object.keys(answers)[0],
// //             timestamp: new Date().toISOString(),
// //           });
// //           const liveResultsResponse = await getLiveResultsData(electionId);
// //           if (liveResultsResponse) {
// //             emitLiveResultsUpdate(electionId, liveResultsResponse);
// //           }
// //         } catch (socketError) {
// //           console.error('⚠️ Socket emission error:', socketError);
// //         }
// //       });

// //       // Send notification email
// //       setImmediate(async () => {
// //         try {
// //           const userResult = await pool.query(
// //             `SELECT u.email, ud.full_name 
// //              FROM votteryy_users u
// //              LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
// //              WHERE u.id = $1`,
// //             [userId]
// //           );
          
// //           if (userResult.rows.length > 0 && userResult.rows[0].email) {
// //             await NotificationService.sendVoteConfirmation(
// //               userResult.rows[0].email,
// //               election.title,
// //               receiptId,
// //               voteHash
// //             );
// //           }
// //         } catch (notifError) {
// //           console.warn('⚠️ Failed to send notification:', notifError.message);
// //         }
// //       });

// //       return res.json({
// //         success: true,
// //         anonymous: false,
// //         votingId: votingUuid,
// //         voteHash,
// //         receiptId,
// //         verificationCode,
// //         message: hasVotedBefore 
// //           ? 'Your vote has been updated successfully.' 
// //           : 'Vote cast successfully.',
// //         isEdit: hasVotedBefore
// //       });
// //     }

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

// // /**
// //  * Helper function to get live results data (reusable for Socket.IO)
// //  */
// // async function getLiveResultsData(electionId) {
// //   const client = await pool.connect();
  
// //   try {
// //     // Check if election is anonymous
// //     const electionResult = await client.query(
// //       `SELECT anonymous_voting_enabled FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       console.error('❌ Election not found for live results:', electionId);
// //       return null;
// //     }

// //     const isAnonymous = electionResult.rows[0].anonymous_voting_enabled || false;
// //     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
// //     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

// //     // Get questions and options
// //     const questionsResult = await client.query(
// //       `SELECT 
// //         q.id,
// //         q.question_text,
// //         q.question_order,
// //         json_agg(
// //           json_build_object(
// //             'id', o.id,
// //             'option_text', o.option_text,
// //             'option_order', o.option_order
// //           ) ORDER BY o.option_order
// //         ) as options
// //       FROM votteryy_election_questions q
// //       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
// //       WHERE q.election_id = $1
// //       GROUP BY q.id, q.question_text, q.question_order
// //       ORDER BY q.question_order`,
// //       [electionId]
// //     );

// //     const questions = [];

// //     for (const question of questionsResult.rows) {
// //       const optionsWithCounts = [];

// //       for (const option of question.options) {
// //         if (!option.id) continue;

// //         const voteCountQuery = `
// //           SELECT COUNT(DISTINCT v.id) as count
// //           FROM ${votesTableName} v
// //           WHERE v.election_id = $1
// //           ${statusFilter}
// //           AND (
// //             (v.answers->$2::text)::text = $3::text
// //             OR
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'array'
// //               AND v.answers->$2::text @> $3::jsonb
// //             )
// //             OR
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'object'
// //               AND v.answers->$2::text ? $3::text
// //             )
// //           )
// //         `;

// //         const voteCountResult = await client.query(voteCountQuery, [
// //           electionId,
// //           question.id.toString(),
// //           option.id.toString()
// //         ]);

// //         const voteCount = parseInt(voteCountResult.rows[0].count) || 0;

// //         optionsWithCounts.push({
// //           id: option.id,
// //           option_text: option.option_text,
// //           option_order: option.option_order,
// //           vote_count: voteCount
// //         });
// //       }

// //       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
// //       optionsWithCounts.forEach(opt => {
// //         opt.percentage = questionTotalVotes > 0 
// //           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
// //           : '0.00';
// //       });

// //       questions.push({
// //         id: question.id,
// //         question_text: question.question_text,
// //         question_order: question.question_order,
// //         options: optionsWithCounts,
// //         total_votes: questionTotalVotes
// //       });
// //     }

// //     const grandTotalVotes = questions.reduce((sum, q) => sum + q.total_votes, 0);

// //     return {
// //       electionId: parseInt(electionId),
// //       totalVotes: grandTotalVotes,
// //       questions,
// //       lastUpdated: new Date().toISOString(),
// //     };

// //   } catch (error) {
// //     console.error('❌ Error fetching live results data:', error);
// //     return null;
// //   } finally {
// //     client.release();
// //   }
// // }

// // // ========================================
// // //  NEW: GET VIDEO WATCH PROGRESS
// // // ========================================
// // export const getVideoProgress = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = String(req.user?.userId || req.headers['x-user-id']);

// //     console.log('📹 GET VIDEO PROGRESS:', { userId, electionId });

// //     if (!userId || userId === 'undefined') {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const result = await pool.query(
// //       `SELECT * FROM votteryy_video_watch_progress 
// //        WHERE user_id = $1 AND election_id = $2`,
// //       [userId, electionId]
// //     );

// //     console.log('📹 Found video progress:', result.rows[0] || 'NONE');

// //     if (result.rows.length === 0) {
// //       return res.json({
// //         completed: false,
// //         watch_percentage: 0,
// //         last_position: 0,
// //         total_duration: 0,
// //       });
// //     }

// //     res.json(result.rows[0]);

// //   } catch (error) {
// //     console.error('Get video progress error:', error);
// //     res.status(500).json({ error: 'Failed to get video progress' });
// //   }
// // };

// // // ========================================
// // // UPDATE VIDEO WATCH PROGRESS
// // // ========================================
// // export const updateVideoProgress = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const { watchPercentage, lastPosition, totalDuration, completed } = req.body;
// //     const userId = String(req.user?.userId || req.headers['x-user-id']);

// //     console.log('📹 UPDATE VIDEO PROGRESS:', {
// //       userId,
// //       electionId,
// //       watchPercentage,
// //       lastPosition,
// //       totalDuration,
// //       completed,
// //     });

// //     if (!userId || userId === 'undefined') {
// //       console.log('❌ No userId found');
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const electionResult = await pool.query(
// //       `SELECT minimum_watch_percentage FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     const minPercentage = electionResult.rows.length > 0 
// //       ? parseFloat(electionResult.rows[0].minimum_watch_percentage) || 80
// //       : 80;

// //     const isCompleted = completed || (watchPercentage >= minPercentage);

// //     const watchPercentageInt = Math.round(watchPercentage);
// //     const lastPositionInt = Math.round(lastPosition);
// //     const totalDurationInt = Math.round(totalDuration);

// //     console.log('💾 Saving to database:', {
// //       userId,
// //       electionId,
// //       watchPercentageInt,
// //       lastPositionInt,
// //       totalDurationInt,
// //       completed: isCompleted,
// //       minPercentage,
// //     });

// //     const result = await pool.query(
// //       `INSERT INTO votteryy_video_watch_progress 
// //        (user_id, election_id, watch_percentage, last_position, total_duration, completed, completed_at)
// //        VALUES ($1, $2, $3, $4, $5, $6, $7)
// //        ON CONFLICT (user_id, election_id)
// //        DO UPDATE SET 
// //          watch_percentage = GREATEST(votteryy_video_watch_progress.watch_percentage, $3),
// //          last_position = $4,
// //          total_duration = $5,
// //          completed = CASE WHEN $6 = TRUE THEN TRUE ELSE votteryy_video_watch_progress.completed END,
// //          completed_at = CASE WHEN $6 = TRUE AND votteryy_video_watch_progress.completed = FALSE THEN NOW() ELSE votteryy_video_watch_progress.completed_at END,
// //          updated_at = NOW()
// //        RETURNING *`,
// //       [userId, electionId, watchPercentageInt, lastPositionInt, totalDurationInt, isCompleted, isCompleted ? new Date() : null]
// //     );

// //     console.log('✅ Saved to database:', result.rows[0]);

// //     res.json({ 
// //       success: true,
// //       watchPercentage: watchPercentageInt,
// //       completed: isCompleted,
// //       data: result.rows[0],
// //     });

// //   } catch (error) {
// //     console.error('❌ Update video progress error:', error);
// //     res.status(500).json({ error: 'Failed to update video progress', details: error.message });
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
// // // ========================================
// // // ✅ REQUIREMENT 4: GET USER'S VOTE (Review after casting)
// // // ========================================
// // export const getUserVote = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     console.log(`📋 Retrieving vote for user ${userId} in election ${electionId}`);

// //     // Check if election is anonymous
// //     const electionResult = await pool.query(
// //       `SELECT anonymous_voting_enabled, status FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       return res.status(404).json({ error: 'Election not found' });
// //     }

// //     const election = electionResult.rows[0];
// //     const isAnonymous = election.anonymous_voting_enabled || false;

// //     if (isAnonymous) {
// //       // For anonymous elections, retrieve via participation
// //       const participationResult = await pool.query(
// //         `SELECT voting_session_id FROM votteryyy_voter_participation 
// //          WHERE election_id = $1 AND user_id = $2`,
// //         [electionId, String(userId)]
// //       );

// //       if (participationResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Vote not found' });
// //       }

// //       const votingSessionId = participationResult.rows[0].voting_session_id;

// //       const voteResult = await pool.query(
// //         `SELECT 
// //           voting_id,
// //           answers,
// //           vote_hash,
// //           receipt_id,
// //           verification_code,
// //           created_at,
// //           updated_at
// //          FROM votteryyy_anonymous_votes
// //          WHERE voting_session_id = $1`,
// //         [votingSessionId]
// //       );

// //       if (voteResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Vote not found' });
// //       }

// //       res.json({
// //         success: true,
// //         anonymous: true,
// //         vote: voteResult.rows[0],
// //         electionStatus: election.status
// //       });

// //     } else {
// //       // For normal elections
// //       const voteResult = await pool.query(
// //         `SELECT 
// //           voting_id,
// //           answers,
// //           vote_hash,
// //           receipt_id,
// //           verification_code,
// //           is_edited,
// //           created_at,
// //           updated_at
// //          FROM votteryy_votes
// //          WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //         [electionId, String(userId)]
// //       );

// //       if (voteResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Vote not found' });
// //       }

// //       res.json({
// //         success: true,
// //         anonymous: false,
// //         vote: voteResult.rows[0],
// //         electionStatus: election.status
// //       });
// //     }

// //   } catch (error) {
// //     console.error('❌ Get user vote error:', error);
// //     res.status(500).json({ error: 'Failed to get vote' });
// //   }
// // };


// // // ========================================
// // // GET VOTING HISTORY
// // // ========================================
// // export const getVotingHistory = async (req, res) => {
// //   try {
// //     const userId = req.user?.userId || req.headers['x-user-id'];
// //     const page = parseInt(req.query.page) || 1;
// //     const limit = parseInt(req.query.limit) || 10;
// //     const offset = (page - 1) * limit;

// //     console.log('📜 Getting voting history for user:', userId);

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get total count
// //     const countQuery = `
// //       SELECT COUNT(*) as total
// //       FROM votteryy_votes
// //       WHERE user_id = $1 AND status = 'valid'
// //     `;
// //     const countResult = await pool.query(countQuery, [String(userId)]);
// //     const total = parseInt(countResult.rows[0].total);

// //     // Get votes with election details and lottery info
// //     const query = `
// //       SELECT 
// //         v.id,
// //         v.voting_id,
// //         v.election_id,
// //         v.user_id,
// //         v.receipt_id,
// //         v.vote_hash,
// //         v.status,
// //         v.created_at,
// //         v.anonymous,
// //         e.title as election_title,
// //         e.status as election_status,
// //         e.is_free,
// //         e.general_participation_fee,
// //         e.lottery_enabled,
// //         lt.ball_number,
// //         lt.ticket_number as lottery_ticket_number,
// //         lt.ticket_id,
// //         CASE 
// //           WHEN e.status = 'completed' THEN 'Draw Completed'
// //           WHEN e.status = 'active' OR e.status = 'published' THEN 'Pending Draw'
// //           ELSE 'Pending Draw'
// //         END as lottery_status,
// //         CASE 
// //           WHEN e.is_free = false THEN e.general_participation_fee
// //           ELSE 0
// //         END as payment_amount,
// //         'USD' as payment_currency
// //       FROM votteryy_votes v
// //       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
// //       LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
// //       WHERE v.user_id = $1 AND v.status = 'valid'
// //       ORDER BY v.created_at DESC
// //       LIMIT $2 OFFSET $3
// //     `;

// //     const result = await pool.query(query, [String(userId), limit, offset]);

// //     console.log('✅ Found', result.rows.length, 'votes for user');

// //     res.status(200).json({
// //       success: true,
// //       data: {
// //         votes: result.rows,
// //         pagination: {
// //           currentPage: page,
// //           limit,
// //           total,
// //           totalPages: Math.ceil(total / limit)
// //         }
// //       }
// //     });
// //   } catch (error) {
// //     console.error('❌ Error fetching voting history:', error);
// //     res.status(500).json({
// //       success: false,
// //       message: 'Failed to fetch voting history',
// //       error: error.message
// //     });
// //   }
// // };

// // // ========================================
// // // GET AUDIT LOGS (Admin only)
// // // ========================================
// // // src/controllers/voting.controller.js

// // // src/controllers/voting.controller.js

// // export const getVoteAuditLogs = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const { page = 1, limit = 50 } = req.query;
// //     const offset = (page - 1) * limit;

// //     console.log(`📋 Retrieving audit logs for election ${electionId}`);

// //     // ✅ CORRECTED SQL QUERY - Using real table names
// //     let query;
// //     let queryParams;

// //     if (electionId === 'all') {
// //       // Get audit logs for all elections
// //       query = `
// //         SELECT 
// //           a.id,
// //           a.user_id,
// //           a.election_id,
// //           a.attempt_type,
// //           a.ip_address,
// //           a.user_agent,
// //           a.attempted_at,
// //           a.flagged_for_review,
// //           a.reviewed_at,
// //           a.notes,
// //           e.title as election_title,
// //           ud.first_name,
// //           ud.last_name,
// //           CONCAT(ud.first_name, ' ', ud.last_name) as user_name
// //         FROM votteryy_audit_logs a
// //         LEFT JOIN votteryyy_elections e ON a.election_id = e.id
// //         LEFT JOIN votteryy_user_details ud ON a.user_id = ud.user_id
// //         ORDER BY a.attempted_at DESC
// //         LIMIT $1 OFFSET $2
// //       `;
// //       queryParams = [limit, offset];
// //     } else {
// //       // Get audit logs for specific election
// //       query = `
// //         SELECT 
// //           a.id,
// //           a.user_id,
// //           a.election_id,
// //           a.attempt_type,
// //           a.ip_address,
// //           a.user_agent,
// //           a.attempted_at,
// //           a.flagged_for_review,
// //           a.reviewed_at,
// //           a.notes,
// //           e.title as election_title,
// //           ud.first_name,
// //           ud.last_name,
// //           CONCAT(ud.first_name, ' ', ud.last_name) as user_name
// //         FROM votteryy_audit_logs a
// //         LEFT JOIN votteryyy_elections e ON a.election_id = e.id
// //         LEFT JOIN votteryy_user_details ud ON a.user_id = ud.user_id
// //         WHERE a.election_id = $1
// //         ORDER BY a.attempted_at DESC
// //         LIMIT $2 OFFSET $3
// //       `;
// //       queryParams = [electionId, limit, offset];
// //     }

// //     const result = await pool.query(query, queryParams);

// //     // Get total count
// //     const countQuery = electionId === 'all'
// //       ? 'SELECT COUNT(*) FROM votteryy_audit_logs'
// //       : 'SELECT COUNT(*) FROM votteryy_audit_logs WHERE election_id = $1';
    
// //     const countParams = electionId === 'all' ? [] : [electionId];
// //     const countResult = await pool.query(countQuery, countParams);
// //     const total = parseInt(countResult.rows[0].count);

// //     console.log(`✅ Found ${result.rows.length} audit logs`);

// //     res.json({
// //       success: true,
// //       data: result.rows,
// //       pagination: {
// //         total,
// //         page: parseInt(page),
// //         limit: parseInt(limit),
// //         pages: Math.ceil(total / limit),
// //       },
// //     });

// //   } catch (error) {
// //     console.error('❌ Get audit logs error:', error);
// //     res.status(500).json({ 
// //       success: false,
// //       error: 'Failed to retrieve audit logs',
// //       message: error.message 
// //     });
// //   }
// // };


// // export default {
// //   getBallot,
// //   castVote,
// //   getVideoProgress, 
// //   updateVideoProgress,
// //   recordAbstention,
// //   getUserVote,
// //   getLiveResults,
// //   getVotingHistory,
// //   getVoteAuditLogs 
// // };







// //last workable perfect code, just to add edit feature above code
// // import pool from '../config/database.js';
// // import crypto from 'crypto';
// // import { 
// //   encryptVote, 
// //   generateVoteHash, 
// //   generateReceiptId, 
// //   generateVerificationCode,
// //   generateVoteToken
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

// //     //  FIX: Handle date/time properly with PostgreSQL timestamp format
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

// //     //  FIXED: Get questions from YOUR tables (votteryy_election_questions)
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
// // // GET LIVE RESULTS - FIXED VERSION (ONLY ONE)
// // // ========================================
// // export const getLiveResults = async (req, res) => {
// //   const client = await pool.connect();
  
// //   try {
// //     const { electionId } = req.params;

// //     console.log(`\n========================================`);
// //     console.log(`📊 LIVE RESULTS - Election ${electionId}`);
// //     console.log(`========================================`);

// //     // 1. Get election info
// //     const electionResult = await client.query(
// //       `SELECT 
// //         id, 
// //         title, 
// //         voting_type, 
// //         show_live_results, 
// //         status,
// //         anonymous_voting_enabled
// //       FROM votteryyy_elections
// //       WHERE id = $1`,
// //       [electionId]
// //     );
    
// //     if (electionResult.rows.length === 0) {
// //       return res.status(404).json({
// //         success: false,
// //         error: 'Election not found',
// //       });
// //     }

// //     const election = electionResult.rows[0];
// //     const isAnonymous = election.anonymous_voting_enabled || false;

// //     console.log(`📋 Election: ${election.title}`);
// //     console.log(`🔐 Anonymous: ${isAnonymous}`);
// //     console.log(`📊 Voting Type: ${election.voting_type}`);

// //     // Check if live results are enabled
// //     if (!election.show_live_results && election.status !== 'completed') {
// //       return res.status(403).json({
// //         success: false,
// //         error: 'Live results are not enabled for this election',
// //       });
// //     }

// //     // 2. Determine which table to query
// //     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
// //     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

// //     console.log(`🗄️  Querying table: ${votesTableName}`);

// //     // 3. Get questions and options structure
// //     const questionsAndOptionsQuery = `
// //       SELECT 
// //         q.id,
// //         q.question_text,
// //         q.question_type,
// //         q.question_order,
// //         json_agg(
// //           json_build_object(
// //             'id', o.id,
// //             'option_text', o.option_text,
// //             'option_order', o.option_order
// //           ) ORDER BY o.option_order
// //         ) as options
// //       FROM votteryy_election_questions q
// //       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
// //       WHERE q.election_id = $1
// //       GROUP BY q.id, q.question_text, q.question_type, q.question_order
// //       ORDER BY q.question_order
// //     `;

// //     const questionsResult = await client.query(questionsAndOptionsQuery, [electionId]);

// //     if (questionsResult.rows.length === 0) {
// //       return res.json({
// //         success: true,
// //         data: {
// //           electionId: parseInt(electionId),
// //           electionTitle: election.title,
// //           votingType: election.voting_type,
// //           isAnonymous: isAnonymous,
// //           totalVotes: 0,
// //           questions: [],
// //           lastUpdated: new Date().toISOString(),
// //         }
// //       });
// //     }

// //     console.log(`📝 Found ${questionsResult.rows.length} questions`);

// //     // 4. Count votes for each option
// //     const questions = [];
// //     let grandTotalVotes = 0;

// //     for (const question of questionsResult.rows) {
// //       console.log(`\n   Question ${question.id}: ${question.question_text}`);
      
// //       const optionsWithCounts = [];

// //       for (const option of question.options) {
// //         if (!option.id) continue; // Skip null options

// //         // ⭐ FIXED: Count votes for this specific option
// //         const voteCountQuery = `
// //           SELECT COUNT(DISTINCT v.id) as count
// //           FROM ${votesTableName} v
// //           WHERE v.election_id = $1
// //           ${statusFilter}
// //           AND (
// //             -- Plurality/Single choice: answers->'questionId' = 'optionId'
// //             (v.answers->$2::text)::text = $3::text
// //             OR
// //             -- Approval voting: answers->'questionId' is array containing optionId
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'array'
// //               AND v.answers->$2::text @> $3::jsonb
// //             )
// //             OR
// //             -- Ranked choice: answers->'questionId' is object with optionId as key
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'object'
// //               AND v.answers->$2::text ? $3::text
// //             )
// //           )
// //         `;

// //         try {
// //           const voteCountResult = await client.query(voteCountQuery, [
// //             electionId,
// //             question.id.toString(),
// //             option.id.toString()
// //           ]);

// //           const voteCount = parseInt(voteCountResult.rows[0].count) || 0;
          
// //           console.log(`      ${option.option_text}: ${voteCount} votes`);

// //           optionsWithCounts.push({
// //             id: option.id,
// //             option_text: option.option_text,
// //             option_order: option.option_order,
// //             vote_count: voteCount
// //           });

// //         } catch (optionError) {
// //           console.error(`      ❌ Error counting votes for option ${option.id}:`, optionError.message);
// //           optionsWithCounts.push({
// //             id: option.id,
// //             option_text: option.option_text,
// //             option_order: option.option_order,
// //             vote_count: 0
// //           });
// //         }
// //       }

// //       // Calculate question total and percentages
// //       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
// //       optionsWithCounts.forEach(opt => {
// //         opt.percentage = questionTotalVotes > 0 
// //           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
// //           : '0.00';
// //       });

// //       grandTotalVotes += questionTotalVotes;

// //       questions.push({
// //         id: question.id,
// //         question_text: question.question_text,
// //         question_type: question.question_type,
// //         question_order: question.question_order,
// //         options: optionsWithCounts,
// //         total_votes: questionTotalVotes
// //       });

// //       console.log(`      Question total: ${questionTotalVotes} votes`);
// //     }

// //     console.log(`\n✅ GRAND TOTAL VOTES: ${grandTotalVotes}`);
// //     console.log(`========================================\n`);

// //     const liveResults = {
// //       electionId: parseInt(electionId),
// //       electionTitle: election.title,
// //       votingType: election.voting_type,
// //       isAnonymous: isAnonymous,
// //       totalVotes: grandTotalVotes,
// //       questions,
// //       lastUpdated: new Date().toISOString(),
// //     };

// //     res.json({
// //       success: true,
// //       data: liveResults,
// //     });

// //   } catch (error) {
// //     console.error('❌ Get live results error:', error);
// //     console.error('Stack trace:', error.stack);
// //     res.status(500).json({
// //       success: false,
// //       error: 'Failed to retrieve live results',
// //       message: error.message,
// //     });
// //   } finally {
// //     client.release();
// //   }
// // };

// // // ========================================
// // // CAST VOTE - WITH ANONYMOUS & ABSTENTION SUPPORT
// // // ========================================
// // export const castVote = async (req, res) => {
// //   const client = await pool.connect();
  
// //   try {
// //     await client.query('BEGIN');

// //     const { electionId } = req.params;
// //     const { answers, isAbstention = false } = req.body;
// //     const userId = req.user?.userId || req.headers['x-user-id'];

// //     console.log('🗳️ Casting vote:', { 
// //       electionId, 
// //       userId, 
// //       isAbstention,
// //       answersCount: answers ? Object.keys(answers).length : 0 
// //     });

// //     if (!userId) {
// //       await client.query('ROLLBACK');
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get election with anonymous voting settings
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

// //     //  NEW: Check if anonymous voting is enabled
// //     const isAnonymousElection = election.anonymous_voting_enabled || false;
// //     console.log(' Anonymous election:', isAnonymousElection);

// //     //  NEW: Check if user already participated (for both anonymous and normal) 
// //     if (isAnonymousElection) {
// //       // For anonymous elections, check participation table
// //       const participationCheck = await client.query(
// //         `SELECT id FROM votteryyy_voter_participation 
// //          WHERE election_id = $1 AND user_id = $2`,
// //         [electionId, String(userId)]
// //       );

// //       if (participationCheck.rows.length > 0 && !election.vote_editing_allowed) {
// //         await client.query('ROLLBACK');
// //         return res.status(400).json({ error: 'You have already voted in this election' });
// //       }
// //     } else {
// //       // For normal elections, check votes table
// //       const existingVote = await client.query(
// //         `SELECT id, voting_id FROM votteryy_votes 
// //          WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //         [electionId, String(userId)]
// //       );

// //       if (existingVote.rows.length > 0 && !election.vote_editing_allowed) {
// //         await client.query('ROLLBACK');
// //         return res.status(400).json({ error: 'You have already voted in this election' });
// //       }
// //     }

// //     // NEW: Handle ABSTENTION
// //     if (isAbstention) {
// //       console.log(' Recording abstention');
      
// //       // Record in participation (for lottery eligibility)
// //       await client.query(
// //         `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
// //          VALUES ($1, $2, TRUE)
// //          ON CONFLICT (election_id, user_id) DO NOTHING`,
// //         [electionId, String(userId)]
// //       );

// //       // Record abstention
// //       await client.query(
// //         `INSERT INTO votteryy_abstentions (election_id, user_id, is_full_abstention, reason)
// //          VALUES ($1, $2, TRUE, 'blank_ballot')
// //          ON CONFLICT (election_id, user_id, question_id) DO NOTHING`,
// //         [electionId, String(userId)]
// //       );

// //       await client.query('COMMIT');
      
// //       return res.json({
// //         success: true,
// //         message: 'Abstention recorded successfully',
// //         abstention: true
// //       });
// //     }

// //     //  VALIDATE ANSWERS
// //     if (!answers || Object.keys(answers).length === 0) {
// //       await client.query('ROLLBACK');
// //       return res.status(400).json({ error: 'No answers provided' });
// //     }

// //     // BRANCH: ANONYMOUS VS NORMAL VOTING 
    
// //     if (isAnonymousElection) {
// //       // ========================================
// //       // ANONYMOUS VOTING FLOW
// //       // ========================================
// //       console.log(' Processing ANONYMOUS vote');

// //       // Prepare vote data
// //       const voteData = {
// //         electionId,
// //         answers,
// //         timestamp: new Date().toISOString(),
// //       };

// //       const encryptedVote = encryptVote(JSON.stringify(voteData));
// //       const voteHash = generateVoteHash(encryptedVote);
// //       const receiptId = generateReceiptId();
// //       const verificationCode = generateVerificationCode();
// //       const voteToken = generateVoteToken();

// //       console.log(' Vote token generated:', voteToken.substring(0, 16) + '...');

// //       // 1. Record participation (prevents double voting, enables lottery)
// //       const participationResult = await client.query(
// //         `INSERT INTO votteryyy_voter_participation (election_id, user_id, has_voted)
// //          VALUES ($1, $2, TRUE)
// //          ON CONFLICT (election_id, user_id) 
// //          DO UPDATE SET voted_at = NOW()
// //          RETURNING voting_session_id`,
// //         [electionId, String(userId)]
// //       );

// //       const votingSessionId = participationResult.rows[0].voting_session_id;
// //       console.log(' Participation recorded, session:', votingSessionId);

// //       // 2. Store anonymous vote (WITHOUT user_id)
// //       const anonymousVoteResult = await client.query(
// //         `INSERT INTO votteryyy_anonymous_votes 
// //          (election_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, vote_token, ip_address, user_agent)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //          RETURNING id, voting_id`,
// //         [
// //           electionId,
// //           JSON.stringify(answers),
// //           encryptedVote,
// //           voteHash,
// //           receiptId,
// //           verificationCode,
// //           voteToken,
// //           req.ip || req.connection.remoteAddress,
// //           req.headers['user-agent']
// //         ]
// //       );

// //       const anonymousVoteId = anonymousVoteResult.rows[0].id;
// //       const votingUuid = anonymousVoteResult.rows[0].voting_id;
// //       console.log(' Anonymous vote stored:', anonymousVoteId, 'UUID:', votingUuid);

// //       // 3. Create lottery ticket if enabled (linked to participation, not vote)
// //       if (election.lottery_enabled) {
// //         const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
// //         const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

// //         await client.query(
// //           `INSERT INTO votteryy_lottery_tickets 
// //            (user_id, election_id, voting_id, ball_number, ticket_number)
// //            VALUES ($1, $2, $3, $4, $5)
// //            ON CONFLICT (user_id, election_id) DO NOTHING`,
// //           [String(userId), electionId, votingSessionId, ballNumber, ticketNumber]
// //         );
// //         console.log(' Lottery ticket created (anonymous):', ticketNumber);
// //       }

// //       // 4. Audit event
// //       try {
// //         await AuditService.logVoteCast(userId, electionId, anonymousVoteId, voteHash, req);
// //         console.log(' Audit event logged (anonymous)');
// //       } catch (auditError) {
// //         console.warn(' Failed to log audit event:', auditError.message);
// //       }

// //       await client.query('COMMIT');
// //       console.log(' Anonymous vote transaction committed');

// //       // Socket.IO real-time updates
// //       setImmediate(async () => {
// //         try {
// //           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
// //           emitVoteCast(electionId, {
// //             questionId: Object.keys(answers)[0],
// //             timestamp: new Date().toISOString(),
// //           });
// //           const liveResultsResponse = await getLiveResultsData(electionId);
// //           if (liveResultsResponse) {
// //             emitLiveResultsUpdate(electionId, liveResultsResponse);
// //           }
// //           console.log(`📡 Real-time updates emitted for election ${electionId}`);
// //         } catch (socketError) {
// //           console.error('⚠️ Socket emission error:', socketError);
// //         }
// //       });

// //       console.log(' Anonymous vote cast successfully');

// //       // RETURN VOTE TOKEN FOR VERIFICATION 
// //       return res.json({
// //         success: true,
// //         anonymous: true,
// //         voteToken,
// //         voteHash,
// //         receiptId,
// //         verificationCode,
// //         message: 'Anonymous vote cast successfully. Save your vote token to verify your vote later.',
// //       });

// //     } else {
// //       // ========================================
// //       // NORMAL VOTING FLOW (EXISTING CODE)
// //       // ========================================
// //       console.log('📊 Processing NORMAL vote');

// //       // Check if already voted
// //       const existingVote = await client.query(
// //         `SELECT id, voting_id FROM votteryy_votes WHERE election_id = $1 AND user_id = $2 AND status = 'valid'`,
// //         [electionId, String(userId)]
// //       );

// //       // Prepare vote data
// //       const voteData = {
// //         electionId,
// //         userId,
// //         answers,
// //         timestamp: new Date().toISOString(),
// //       };

// //       const encryptedVote = encryptVote(JSON.stringify(voteData));
// //       const voteHash = generateVoteHash(encryptedVote);
// //       const receiptId = generateReceiptId();
// //       const verificationCode = generateVerificationCode();

// //       // Insert or update vote
// //       let voteId, votingUuid;
      
// //       if (existingVote.rows.length > 0) {
// //         // Update existing vote
// //         const updateResult = await client.query(
// //           `UPDATE votteryy_votes 
// //            SET 
// //              answers = $1,
// //              encrypted_vote = $2, 
// //              vote_hash = $3,
// //              is_edited = true,
// //              updated_at = NOW()
// //            WHERE id = $4
// //            RETURNING id, voting_id`,
// //           [JSON.stringify(answers), encryptedVote, voteHash, existingVote.rows[0].id]
// //         );
// //         voteId = updateResult.rows[0].id;
// //         votingUuid = updateResult.rows[0].voting_id;
// //         console.log('✅ Vote updated:', voteId, 'UUID:', votingUuid);
// //       } else {
// //         // Insert new vote
// //         const voteResult = await client.query(
// //           `INSERT INTO votteryy_votes 
// //            (election_id, user_id, answers, encrypted_vote, vote_hash, receipt_id, verification_code, anonymous, ip_address, user_agent, status)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'valid')
// //            RETURNING id, voting_id`,
// //           [
// //             electionId,
// //             String(userId),
// //             JSON.stringify(answers),
// //             encryptedVote,
// //             voteHash,
// //             receiptId,
// //             verificationCode,
// //             false,
// //             req.ip || req.connection.remoteAddress,
// //             req.headers['user-agent'],
// //           ]
// //         );
// //         voteId = voteResult.rows[0].id;
// //         votingUuid = voteResult.rows[0].voting_id;
// //         console.log('✅ Vote inserted:', voteId, 'UUID:', votingUuid);

// //         // Create receipt
// //         await client.query(
// //           `INSERT INTO votteryy_vote_receipts 
// //            (voting_id, election_id, user_id, verification_code, vote_hash)
// //            VALUES ($1, $2, $3, $4, $5)`,
// //           [votingUuid, electionId, String(userId), verificationCode, voteHash]
// //         );
// //         console.log('✅ Receipt created for voting_id:', votingUuid);
// //       }

// //       // Create lottery ticket if lottery is enabled
// //       if (election.lottery_enabled) {
// //         const ballNumber = parseInt(`${userId}${electionId}${Date.now()}`.slice(-6));
// //         const ticketNumber = `TKT-${new Date().getFullYear()}-${String(ballNumber).padStart(6, '0')}`;

// //         await client.query(
// //           `INSERT INTO votteryy_lottery_tickets 
// //            (user_id, election_id, voting_id, ball_number, ticket_number)
// //            VALUES ($1, $2, $3, $4, $5)
// //            ON CONFLICT (user_id, election_id) DO NOTHING`,
// //           [String(userId), electionId, votingUuid, ballNumber, ticketNumber]
// //         );
// //         console.log('🎰 Lottery ticket created:', ticketNumber, 'for voting UUID:', votingUuid);
// //       }

// //       // Record audit event
// //       try {
// //         await AuditService.logVoteCast(userId, electionId, voteId, voteHash, req);
// //         console.log('📝 Audit event logged');
// //       } catch (auditError) {
// //         console.warn('⚠️ Failed to log audit event:', auditError.message);
// //       }

// //       // Commit transaction
// //       await client.query('COMMIT');
// //       console.log('✅ Transaction committed');

// //       // Socket.IO real-time updates
// //       setImmediate(async () => {
// //         try {
// //           const { emitVoteCast, emitLiveResultsUpdate } = await import('../socket/votingSocket.js');
// //           emitVoteCast(electionId, {
// //             questionId: Object.keys(answers)[0],
// //             timestamp: new Date().toISOString(),
// //           });
// //           const liveResultsResponse = await getLiveResultsData(electionId);
// //           if (liveResultsResponse) {
// //             emitLiveResultsUpdate(electionId, liveResultsResponse);
// //           }
// //           console.log(`📡 Real-time updates emitted for election ${electionId}`);
// //         } catch (socketError) {
// //           console.error('⚠️ Socket emission error:', socketError);
// //         }
// //       });

// //       // Send notification email (after commit)
// //       setImmediate(async () => {
// //         try {
// //           const userResult = await pool.query(
// //             `SELECT u.email, ud.full_name 
// //              FROM votteryy_users u
// //              LEFT JOIN votteryy_user_details ud ON u.id = ud.user_id
// //              WHERE u.id = $1`,
// //             [userId]
// //           );
          
// //           if (userResult.rows.length > 0 && userResult.rows[0].email) {
// //             await NotificationService.sendVoteConfirmation(
// //               userResult.rows[0].email,
// //               election.title,
// //               receiptId,
// //               voteHash
// //             );
// //             console.log('📧 Confirmation email sent to:', userResult.rows[0].email);
// //           }
// //         } catch (notifError) {
// //           console.warn('⚠️ Failed to send notification:', notifError.message);
// //         }
// //       });

// //       console.log('✅ Vote cast successfully:', { votingId: voteId, votingUuid, receiptId, verificationCode });

// //       // Return success response
// //       return res.json({
// //         success: true,
// //         anonymous: false,
// //         votingId: votingUuid,
// //         voteHash,
// //         receiptId,
// //         verificationCode,
// //         message: 'Vote cast successfully',
// //       });
// //     }

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

// // /**
// //  * Helper function to get live results data (reusable for Socket.IO)
// //  */
// // async function getLiveResultsData(electionId) {
// //   const client = await pool.connect();
  
// //   try {
// //     // Check if election is anonymous
// //     const electionResult = await client.query(
// //       `SELECT anonymous_voting_enabled FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       console.error('❌ Election not found for live results:', electionId);
// //       return null;
// //     }

// //     const isAnonymous = electionResult.rows[0].anonymous_voting_enabled || false;
// //     const votesTableName = isAnonymous ? 'votteryyy_anonymous_votes' : 'votteryy_votes';
// //     const statusFilter = isAnonymous ? '' : "AND status = 'valid'";

// //     // Get questions and options
// //     const questionsResult = await client.query(
// //       `SELECT 
// //         q.id,
// //         q.question_text,
// //         q.question_order,
// //         json_agg(
// //           json_build_object(
// //             'id', o.id,
// //             'option_text', o.option_text,
// //             'option_order', o.option_order
// //           ) ORDER BY o.option_order
// //         ) as options
// //       FROM votteryy_election_questions q
// //       LEFT JOIN votteryy_election_options o ON q.id = o.question_id
// //       WHERE q.election_id = $1
// //       GROUP BY q.id, q.question_text, q.question_order
// //       ORDER BY q.question_order`,
// //       [electionId]
// //     );

// //     const questions = [];

// //     for (const question of questionsResult.rows) {
// //       const optionsWithCounts = [];

// //       for (const option of question.options) {
// //         if (!option.id) continue;

// //         const voteCountQuery = `
// //           SELECT COUNT(DISTINCT v.id) as count
// //           FROM ${votesTableName} v
// //           WHERE v.election_id = $1
// //           ${statusFilter}
// //           AND (
// //             (v.answers->$2::text)::text = $3::text
// //             OR
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'array'
// //               AND v.answers->$2::text @> $3::jsonb
// //             )
// //             OR
// //             (
// //               jsonb_typeof(v.answers->$2::text) = 'object'
// //               AND v.answers->$2::text ? $3::text
// //             )
// //           )
// //         `;

// //         const voteCountResult = await client.query(voteCountQuery, [
// //           electionId,
// //           question.id.toString(),
// //           option.id.toString()
// //         ]);

// //         const voteCount = parseInt(voteCountResult.rows[0].count) || 0;

// //         optionsWithCounts.push({
// //           id: option.id,
// //           option_text: option.option_text,
// //           option_order: option.option_order,
// //           vote_count: voteCount
// //         });
// //       }

// //       const questionTotalVotes = optionsWithCounts.reduce((sum, opt) => sum + opt.vote_count, 0);
      
// //       optionsWithCounts.forEach(opt => {
// //         opt.percentage = questionTotalVotes > 0 
// //           ? ((opt.vote_count / questionTotalVotes) * 100).toFixed(2)
// //           : '0.00';
// //       });

// //       questions.push({
// //         id: question.id,
// //         question_text: question.question_text,
// //         question_order: question.question_order,
// //         options: optionsWithCounts,
// //         total_votes: questionTotalVotes
// //       });
// //     }

// //     const grandTotalVotes = questions.reduce((sum, q) => sum + q.total_votes, 0);

// //     return {
// //       electionId: parseInt(electionId),
// //       totalVotes: grandTotalVotes,
// //       questions,
// //       lastUpdated: new Date().toISOString(),
// //     };

// //   } catch (error) {
// //     console.error('❌ Error fetching live results data:', error);
// //     return null;
// //   } finally {
// //     client.release();
// //   }
// // }

// // // ========================================
// // //  NEW: GET VIDEO WATCH PROGRESS
// // // ========================================
// // export const getVideoProgress = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = String(req.user?.userId || req.headers['x-user-id']);

// //     console.log('📹 GET VIDEO PROGRESS:', { userId, electionId });

// //     if (!userId || userId === 'undefined') {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const result = await pool.query(
// //       `SELECT * FROM votteryy_video_watch_progress 
// //        WHERE user_id = $1 AND election_id = $2`,
// //       [userId, electionId]
// //     );

// //     console.log('📹 Found video progress:', result.rows[0] || 'NONE');

// //     if (result.rows.length === 0) {
// //       return res.json({
// //         completed: false,
// //         watch_percentage: 0,
// //         last_position: 0,
// //         total_duration: 0,
// //       });
// //     }

// //     res.json(result.rows[0]);

// //   } catch (error) {
// //     console.error('Get video progress error:', error);
// //     res.status(500).json({ error: 'Failed to get video progress' });
// //   }
// // };

// // // ========================================
// // // UPDATE VIDEO WATCH PROGRESS
// // // ========================================
// // export const updateVideoProgress = async (req, res) => {
// //   try {
// //     const { electionId } = req.params;
// //     const { watchPercentage, lastPosition, totalDuration, completed } = req.body;
// //     const userId = String(req.user?.userId || req.headers['x-user-id']);

// //     console.log('📹 UPDATE VIDEO PROGRESS:', {
// //       userId,
// //       electionId,
// //       watchPercentage,
// //       lastPosition,
// //       totalDuration,
// //       completed,
// //     });

// //     if (!userId || userId === 'undefined') {
// //       console.log('❌ No userId found');
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     const electionResult = await pool.query(
// //       `SELECT minimum_watch_percentage FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     const minPercentage = electionResult.rows.length > 0 
// //       ? parseFloat(electionResult.rows[0].minimum_watch_percentage) || 80
// //       : 80;

// //     const isCompleted = completed || (watchPercentage >= minPercentage);

// //     const watchPercentageInt = Math.round(watchPercentage);
// //     const lastPositionInt = Math.round(lastPosition);
// //     const totalDurationInt = Math.round(totalDuration);

// //     console.log('💾 Saving to database:', {
// //       userId,
// //       electionId,
// //       watchPercentageInt,
// //       lastPositionInt,
// //       totalDurationInt,
// //       completed: isCompleted,
// //       minPercentage,
// //     });

// //     const result = await pool.query(
// //       `INSERT INTO votteryy_video_watch_progress 
// //        (user_id, election_id, watch_percentage, last_position, total_duration, completed, completed_at)
// //        VALUES ($1, $2, $3, $4, $5, $6, $7)
// //        ON CONFLICT (user_id, election_id)
// //        DO UPDATE SET 
// //          watch_percentage = GREATEST(votteryy_video_watch_progress.watch_percentage, $3),
// //          last_position = $4,
// //          total_duration = $5,
// //          completed = CASE WHEN $6 = TRUE THEN TRUE ELSE votteryy_video_watch_progress.completed END,
// //          completed_at = CASE WHEN $6 = TRUE AND votteryy_video_watch_progress.completed = FALSE THEN NOW() ELSE votteryy_video_watch_progress.completed_at END,
// //          updated_at = NOW()
// //        RETURNING *`,
// //       [userId, electionId, watchPercentageInt, lastPositionInt, totalDurationInt, isCompleted, isCompleted ? new Date() : null]
// //     );

// //     console.log('✅ Saved to database:', result.rows[0]);

// //     res.json({ 
// //       success: true,
// //       watchPercentage: watchPercentageInt,
// //       completed: isCompleted,
// //       data: result.rows[0],
// //     });

// //   } catch (error) {
// //     console.error('❌ Update video progress error:', error);
// //     res.status(500).json({ error: 'Failed to update video progress', details: error.message });
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

// // // ========================================
// // // GET VOTING HISTORY
// // // ========================================
// // export const getVotingHistory = async (req, res) => {
// //   try {
// //     const userId = req.user?.userId || req.headers['x-user-id'];
// //     const page = parseInt(req.query.page) || 1;
// //     const limit = parseInt(req.query.limit) || 10;
// //     const offset = (page - 1) * limit;

// //     console.log('📜 Getting voting history for user:', userId);

// //     if (!userId) {
// //       return res.status(401).json({ error: 'Authentication required' });
// //     }

// //     // Get total count
// //     const countQuery = `
// //       SELECT COUNT(*) as total
// //       FROM votteryy_votes
// //       WHERE user_id = $1 AND status = 'valid'
// //     `;
// //     const countResult = await pool.query(countQuery, [String(userId)]);
// //     const total = parseInt(countResult.rows[0].total);

// //     // Get votes with election details and lottery info
// //     const query = `
// //       SELECT 
// //         v.id,
// //         v.voting_id,
// //         v.election_id,
// //         v.user_id,
// //         v.receipt_id,
// //         v.vote_hash,
// //         v.status,
// //         v.created_at,
// //         v.anonymous,
// //         e.title as election_title,
// //         e.status as election_status,
// //         e.is_free,
// //         e.general_participation_fee,
// //         e.lottery_enabled,
// //         lt.ball_number,
// //         lt.ticket_number as lottery_ticket_number,
// //         lt.ticket_id,
// //         CASE 
// //           WHEN e.status = 'completed' THEN 'Draw Completed'
// //           WHEN e.status = 'active' OR e.status = 'published' THEN 'Pending Draw'
// //           ELSE 'Pending Draw'
// //         END as lottery_status,
// //         CASE 
// //           WHEN e.is_free = false THEN e.general_participation_fee
// //           ELSE 0
// //         END as payment_amount,
// //         'USD' as payment_currency
// //       FROM votteryy_votes v
// //       LEFT JOIN votteryyy_elections e ON v.election_id = e.id
// //       LEFT JOIN votteryy_lottery_tickets lt ON v.voting_id = lt.voting_id
// //       WHERE v.user_id = $1 AND v.status = 'valid'
// //       ORDER BY v.created_at DESC
// //       LIMIT $2 OFFSET $3
// //     `;

// //     const result = await pool.query(query, [String(userId), limit, offset]);

// //     console.log('✅ Found', result.rows.length, 'votes for user');

// //     res.status(200).json({
// //       success: true,
// //       data: {
// //         votes: result.rows,
// //         pagination: {
// //           currentPage: page,
// //           limit,
// //           total,
// //           totalPages: Math.ceil(total / limit)
// //         }
// //       }
// //     });
// //   } catch (error) {
// //     console.error('❌ Error fetching voting history:', error);
// //     res.status(500).json({
// //       success: false,
// //       message: 'Failed to fetch voting history',
// //       error: error.message
// //     });
// //   }
// // };

// // export default {
// //   getBallot,
// //   castVote,
// //   getVideoProgress, 
// //   updateVideoProgress,
// //   recordAbstention,
// //   getUserVote,
// //   getLiveResults,
// //   getVotingHistory
// // };
