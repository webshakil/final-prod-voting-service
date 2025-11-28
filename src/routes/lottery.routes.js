import express from 'express';
import lotteryController from '../controllers/lottery.controller.js';
import roleCheck from '../ middleware/roleCheck.js';
//import roleCheck from '../middleware/roleCheck.js';

const router = express.Router();

// =====================================================
// PUBLIC ROUTES
// =====================================================
router.get('/elections/:electionId/info', lotteryController.getLotteryInfo);
router.get('/elections/:electionId/winners', lotteryController.getWinnersAnnouncement);

// =====================================================
// USER ROUTES (Voters)
// =====================================================
router.get('/elections/:electionId/my-ticket', roleCheck(['voter']), lotteryController.getUserTicket);
router.get('/my-winnings', roleCheck(['voter']), lotteryController.getUserWinningHistory);
router.post('/winners/:winnerId/claim', roleCheck(['voter']), lotteryController.claimPrize);

// =====================================================
// ADMIN ROUTES
// =====================================================
router.get('/elections/:electionId/participants', roleCheck(['admin', 'manager']), lotteryController.getLotteryParticipants);
router.post('/elections/:electionId/draw', roleCheck(['admin', 'manager']), lotteryController.drawLottery);
router.get('/admin/pending-approvals', roleCheck(['admin', 'manager']), lotteryController.getPendingApprovals);
router.get('/admin/disbursements', roleCheck(['admin', 'manager']), lotteryController.getDisbursementHistory);
router.post('/admin/winners/:winnerId/approve', roleCheck(['admin', 'manager']), lotteryController.approveDisbursement);
router.post('/admin/winners/:winnerId/reject', roleCheck(['admin', 'manager']), lotteryController.rejectDisbursement);
router.post('/admin/disbursements/bulk-approve', roleCheck(['admin', 'manager']), lotteryController.bulkApproveDisbursements);

// =====================================================
// CONFIG ROUTES (Manager Only for Updates)
// =====================================================
// GET config - admin and manager can view
router.get('/admin/config', roleCheck(['admin', 'manager']), lotteryController.getDisbursementConfig);

// PUT single config - manager only
router.put('/admin/config', roleCheck(['manager']), lotteryController.updateDisbursementConfig);

// PUT bulk config - manager only (update all at once)
router.put('/admin/config/bulk', roleCheck(['manager']), lotteryController.bulkUpdateDisbursementConfig);

export default router;
//last workable code only to add new api above code
// import express from 'express';
// import lotteryController from '../controllers/lottery.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// //import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // PUBLIC ROUTES
// router.get('/elections/:electionId/info', lotteryController.getLotteryInfo);
// router.get('/elections/:electionId/winners', lotteryController.getWinnersAnnouncement);

// // USER ROUTES
// router.get('/elections/:electionId/my-ticket', roleCheck(['voter']), lotteryController.getUserTicket);
// router.get('/my-winnings', roleCheck(['voter']), lotteryController.getUserWinningHistory);
// router.post('/winners/:winnerId/claim', roleCheck(['voter']), lotteryController.claimPrize);

// // ADMIN ROUTES
// router.get('/elections/:electionId/participants', roleCheck(['admin', 'manager']), lotteryController.getLotteryParticipants);
// router.post('/elections/:electionId/draw', roleCheck(['admin', 'manager']), lotteryController.drawLottery);
// router.get('/admin/pending-approvals', roleCheck(['admin', 'manager']), lotteryController.getPendingApprovals);
// router.get('/admin/disbursements', roleCheck(['admin', 'manager']), lotteryController.getDisbursementHistory);
// router.post('/admin/winners/:winnerId/approve', roleCheck(['admin', 'manager']), lotteryController.approveDisbursement);
// router.post('/admin/winners/:winnerId/reject', roleCheck(['admin', 'manager']), lotteryController.rejectDisbursement);
// router.post('/admin/disbursements/bulk-approve', roleCheck(['admin', 'manager']), lotteryController.bulkApproveDisbursements);
// router.get('/admin/config', roleCheck(['admin', 'manager']), lotteryController.getDisbursementConfig);
// router.put('/admin/config', roleCheck(['manager']), lotteryController.updateDisbursementConfig);

// export default router;
// import express from 'express';
// import lotteryController from '../controllers/lottery.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// //import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // PUBLIC ROUTES
// router.get('/elections/:electionId/lottery', lotteryController.getLotteryInfo);
// router.get('/elections/:electionId/lottery/winners', lotteryController.getWinnersAnnouncement);

// // USER ROUTES
// router.get('/elections/:electionId/lottery/my-ticket', roleCheck(['voter']), lotteryController.getUserTicket);
// router.get('/lottery/my-winnings', roleCheck(['voter']), lotteryController.getUserWinningHistory);
// router.post('/lottery/winners/:winnerId/claim', roleCheck(['voter']), lotteryController.claimPrize);

// // ADMIN ROUTES
// router.get('/elections/:electionId/lottery/participants', roleCheck(['admin', 'manager']), lotteryController.getLotteryParticipants);
// router.post('/elections/:electionId/lottery/draw', roleCheck(['admin', 'manager']), lotteryController.drawLottery);
// router.get('/admin/lottery/pending-approvals', roleCheck(['admin', 'manager']), lotteryController.getPendingApprovals);
// router.get('/admin/lottery/disbursements', roleCheck(['admin', 'manager']), lotteryController.getDisbursementHistory);
// router.post('/admin/lottery/winners/:winnerId/approve', roleCheck(['admin', 'manager']), lotteryController.approveDisbursement);
// router.post('/admin/lottery/winners/:winnerId/reject', roleCheck(['admin', 'manager']), lotteryController.rejectDisbursement);
// router.post('/admin/lottery/disbursements/bulk-approve', roleCheck(['admin', 'manager']), lotteryController.bulkApproveDisbursements);
// router.get('/admin/lottery/config', roleCheck(['admin', 'manager']), lotteryController.getDisbursementConfig);
// router.put('/admin/lottery/config', roleCheck(['manager']), lotteryController.updateDisbursementConfig);

// export default router;
// import express from 'express';
// import lotteryController from '../controllers/lottery.controller.js';
// import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // PUBLIC ROUTES
// router.get('/elections/:electionId/lottery', lotteryController.getLotteryInfo);
// router.get('/elections/:electionId/lottery/winners', lotteryController.getWinnersAnnouncement);

// // USER ROUTES
// router.get('/elections/:electionId/lottery/my-ticket', roleCheck(['voter']), lotteryController.getUserTicket);
// router.get('/lottery/my-winnings', roleCheck(['voter']), lotteryController.getUserWinningHistory);
// router.post('/lottery/winners/:winnerId/claim', roleCheck(['voter']), lotteryController.claimPrize);

// // ADMIN ROUTES
// router.get('/elections/:electionId/lottery/participants', roleCheck(['admin', 'manager']), lotteryController.getLotteryParticipants);
// router.post('/elections/:electionId/lottery/draw', roleCheck(['admin', 'manager']), lotteryController.drawLottery);
// router.get('/admin/lottery/pending-approvals', roleCheck(['admin', 'manager']), lotteryController.getPendingApprovals);
// router.get('/admin/lottery/disbursements', roleCheck(['admin', 'manager']), lotteryController.getDisbursementHistory);
// router.post('/admin/lottery/winners/:winnerId/approve', roleCheck(['admin', 'manager']), lotteryController.approveDisbursement);
// router.post('/admin/lottery/winners/:winnerId/reject', roleCheck(['admin', 'manager']), lotteryController.rejectDisbursement);
// router.post('/admin/lottery/disbursements/bulk-approve', roleCheck(['admin', 'manager']), lotteryController.bulkApproveDisbursements);
// router.get('/admin/lottery/config', roleCheck(['admin', 'manager']), lotteryController.getDisbursementConfig);
// router.put('/admin/lottery/config', roleCheck(['manager']), lotteryController.updateDisbursementConfig);

// export default router;
// import express from 'express';
// import lotteryController from '../controllers/lottery.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// //import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // Get lottery info for election
// router.get(
//   '/elections/:electionId/lottery',
//   lotteryController.getLotteryInfo
// );

// // Get user's lottery ticket
// router.get(
//   '/elections/:electionId/lottery/my-ticket',
//   roleCheck(['voter']),
//   lotteryController.getUserTicket
// );

// // Get lottery participants (admin/creator only)
// router.get(
//   '/elections/:electionId/lottery/participants',
//   //roleCheck(['admin', 'manager', 'individual_election_creator_subscribed', 'organization_election_creator_subscribed']),
//   lotteryController.getLotteryParticipants
// );

// // Draw lottery (admin only - manual trigger)
// router.post(
//   '/elections/:electionId/lottery/draw',
//   roleCheck(['admin', 'manager']),
//   lotteryController.drawLottery
// );


// // Claim lottery prize
// router.post(
//   '/lottery/winners/:winnerId/claim',
//   roleCheck(['voter']),
//   lotteryController.claimPrize
// );

// export default router;