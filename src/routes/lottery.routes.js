import express from 'express';
import lotteryController from '../controllers/lottery.controller.js';
import roleCheck from '../ middleware/roleCheck.js';
//import roleCheck from '../middleware/roleCheck.js';

const router = express.Router();

// Get lottery info for election
router.get(
  '/elections/:electionId/lottery',
  lotteryController.getLotteryInfo
);

// Get user's lottery ticket
router.get(
  '/elections/:electionId/lottery/my-ticket',
  roleCheck(['voter']),
  lotteryController.getUserTicket
);

// Get lottery participants (admin/creator only)
router.get(
  '/elections/:electionId/lottery/participants',
  //roleCheck(['admin', 'manager', 'individual_election_creator_subscribed', 'organization_election_creator_subscribed']),
  lotteryController.getLotteryParticipants
);

// Draw lottery (admin only - manual trigger)
router.post(
  '/elections/:electionId/lottery/draw',
  roleCheck(['admin', 'manager']),
  lotteryController.drawLottery
);


// Claim lottery prize
router.post(
  '/lottery/winners/:winnerId/claim',
  roleCheck(['voter']),
  lotteryController.claimPrize
);

export default router;