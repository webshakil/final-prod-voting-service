import express from 'express';
import analyticsController from '../controllers/analytics.controller.js';
import roleCheck from '../ middleware/roleCheck.js';
//import roleCheck from '../middleware/roleCheck.js';

const router = express.Router();

// Get election analytics
router.get(
  '/elections/:electionId/analytics',
  roleCheck(['admin', 'manager', 'individual_election_creator_subscribed', 'organization_election_creator_subscribed']),
  analyticsController.getElectionAnalytics
);

// Get real-time election results
router.get(
  '/elections/:electionId/results',
  analyticsController.getElectionResults
);

// Get platform analytics (admin only)
router.get(
  '/platform/analytics',
  roleCheck(['admin', 'manager', 'analyst']),
  analyticsController.getPlatformAnalytics
);

// Get user voting history
router.get(
  '/users/me/voting-history',
  roleCheck(['voter']),
  analyticsController.getUserVotingHistory
);

// Get voter demographics (admin/creator only)
router.get(
  '/elections/:electionId/demographics',
  roleCheck(['admin', 'manager', 'individual_election_creator_subscribed', 'organization_election_creator_subscribed']),
  analyticsController.getVoterDemographics
);

export default router;