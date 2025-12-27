import express from 'express';
import { body, param,query } from 'express-validator';
import { extractUserData, requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import * as voteController from '../controllers/voteController.js';
import { voteRateLimiter } from '../middleware/rateLimiter.js';

const router = express.Router();

// ✅ NEW: Get election ballot (checks if user already voted)
router.get(
  '/elections/:electionId/ballot',
  extractUserData,
  [param('electionId').isInt(), validate],
  voteController.getElectionBallot
);

// Cast vote
router.post(
  '/submit',
  voteRateLimiter,
  [
    body('userId').notEmpty().withMessage('User ID is required'), // 🔥 ADD THIS
    body('electionId').isInt().withMessage('Valid election ID required'),
    body('answers').isObject().withMessage('Answers must be an object'),
    validate
  ],
  voteController.castVote
);

// Edit vote
router.put(
  '/edit',
  extractUserData,
  requireAuth,
  [
    body('electionId').isInt().withMessage('Valid election ID required'),
    body('answers').isObject().withMessage('Answers must be an object'),
    validate
  ],
  voteController.editVote
);

// Get my vote for an election
router.get(
  '/my-vote/:electionId',
  extractUserData,
  requireAuth,
  [param('electionId').isInt(), validate],
  voteController.getMyVote
);

// Get voting history
router.get(
  '/history',
  //extractUserData,
  //requireAuth,
  voteController.getVotingHistory
);

// Verify receipt
router.get(
  '/verify/:receiptId',
  [param('receiptId').isUUID(), validate],
  voteController.verifyReceipt
);

// Get election results
router.get(
  '/results/:electionId',
  [param('electionId').isInt(), validate],
  voteController.getElectionResults
);

//new routes for audit trail
router.get(
  '/audit-trail',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('actionType').optional().isString(),
    query('electionId').optional().isInt(),
    validate
  ],
  voteController.getAuditTrail
);

// Get audit statistics
router.get(
  '/audit-stats',
  voteController.getAuditStats
);

// Get hash chain for election (blockchain-style verification)
router.get(
  '/hash-chain/:electionId',
  [param('electionId').isInt(), validate],
  voteController.getHashChain
);
router.get(
  '/public-bulletin/:electionId',
  [param('electionId').isInt(), validate],
  voteController.getPublicBulletinBoard
);
export default router;

//last working code 
// import express from 'express';
// import votingController from '../controllers/voting.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// import electionAccess from '../ middleware/electionAccess.js';
// import videoWatch from '../ middleware/videoWatch.js';

// const router = express.Router();

// // Get election ballot
// router.get(
//   '/elections/:electionId/ballot',
//   roleCheck(['voter']),
//   electionAccess,
//   votingController.getBallot
// );

// // Cast vote
// router.post(
//   '/elections/:electionId/vote',
//   roleCheck(['voter']),
//   electionAccess,
//   videoWatch, // Uncomment if video watch is mandatory
//   votingController.castVote
// );

// // ✅ NEW: Get video watch progress
// router.get(
//   '/elections/:electionId/video-progress',
//   roleCheck(['voter']),
//   votingController.getVideoProgress
// );

// // Update video watch progress
// router.post(
//   '/elections/:electionId/video-progress',
//   roleCheck(['voter']),
//   votingController.updateVideoProgress
// );

// // New route in voting.routes.js
// router.get(
//   '/elections/:electionId/live-results',
//   votingController.getLiveResults
// );

// // Record abstention
// router.post(
//   '/elections/:electionId/abstain',
//   roleCheck(['voter']),
//   votingController.recordAbstention
// );

// // Get user's vote
// router.get(
//   '/elections/:electionId/my-vote',
//   roleCheck(['voter']),
//   votingController.getUserVote
// );
// router.get(
//   '/history',
//   roleCheck(['voter']),
//   votingController.getVotingHistory
// );

// router.get(
//   '/elections/:electionId/audit-logs',
//   roleCheck(['admin', 'election_creator']),
//   votingController.getVoteAuditLogs
// );
// router.get(
//   '/public-bulletin/:electionId',
//   votingController.getPublicBulletin
// );

// export default router;
// // import express from 'express';
// // import votingController from '../controllers/voting.controller.js';
// // import roleCheck from '../ middleware/roleCheck.js';
// // import electionAccess from '../ middleware/electionAccess.js';
// // import videoWatch from '../ middleware/videoWatch.js';

// // const router = express.Router();

// // // Get election ballot
// // router.get(
// //   '/elections/:electionId/ballot',
// //   roleCheck(['voter']),
// //   electionAccess,
// //   votingController.getBallot
// // );

// // // Cast vote
// // router.post(
// //   '/elections/:electionId/vote',
// //   roleCheck(['voter']),
// //   electionAccess,
// //    //videoWatch, // Uncomment if video watch is mandatory
// //   votingController.castVote
// // );

// // // Update video watch progress
// // router.post(
// //   '/elections/:electionId/video-progress',
// //   roleCheck(['voter']),
// //   votingController.updateVideoProgress
// // );

// // // Record abstention
// // router.post(
// //   '/elections/:electionId/abstain',
// //   roleCheck(['voter']),
// //   votingController.recordAbstention
// // );

// // // Get user's vote
// // router.get(
// //   '/elections/:electionId/my-vote',
// //   roleCheck(['voter']),
// //   votingController.getUserVote
// // );

// // export default router;