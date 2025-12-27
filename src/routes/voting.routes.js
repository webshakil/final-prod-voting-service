

//last working code 
import express from 'express';
import votingController from '../controllers/voting.controller.js';
import roleCheck from '../ middleware/roleCheck.js';
import electionAccess from '../ middleware/electionAccess.js';
import videoWatch from '../ middleware/videoWatch.js';

const router = express.Router();

// Get election ballot
router.get(
  '/elections/:electionId/ballot',
  roleCheck(['voter']),
  electionAccess,
  votingController.getBallot
);

// Cast vote
router.post(
  '/elections/:electionId/vote',
  roleCheck(['voter']),
  electionAccess,
  videoWatch, // Uncomment if video watch is mandatory
  votingController.castVote
);

// ✅ NEW: Get video watch progress
router.get(
  '/elections/:electionId/video-progress',
  roleCheck(['voter']),
  votingController.getVideoProgress
);

// Update video watch progress
router.post(
  '/elections/:electionId/video-progress',
  roleCheck(['voter']),
  votingController.updateVideoProgress
);

// New route in voting.routes.js
router.get(
  '/elections/:electionId/live-results',
  votingController.getLiveResults
);

// Record abstention
router.post(
  '/elections/:electionId/abstain',
  roleCheck(['voter']),
  votingController.recordAbstention
);

// Get user's vote
router.get(
  '/elections/:electionId/my-vote',
  roleCheck(['voter']),
  votingController.getUserVote
);
router.get(
  '/history',
  roleCheck(['voter']),
  votingController.getVotingHistory
);

router.get(
  '/elections/:electionId/audit-logs',
  roleCheck(['admin', 'election_creator']),
  votingController.getVoteAuditLogs
);
router.get(
  '/public-bulletin/:electionId',
  votingController.getPublicBulletin
);

export default router;




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