// src/routes/analytics.routes.js
// VOTING-SERVICE (3007) - Analytics data endpoints
// Requires analytics API key (vta_live_xxx or vta_test_xxx)

import express from 'express';
import analyticsController from '../controllers/analytics.controller.js';
import analyticsApiKeyAuth from '../ middleware/analyticsApiKeyAuth.js';
//import analyticsApiKeyAuth from '../middleware/analyticsApiKeyAuth.js';

const router = express.Router();

// All routes require valid analytics API key
router.get('/platform/report', analyticsApiKeyAuth, analyticsController.getComprehensivePlatformReport);
router.get('/platform/revenue', analyticsApiKeyAuth, analyticsController.getRevenueReport);
router.get('/platform/realtime', analyticsApiKeyAuth, analyticsController.getRealTimeStats);
router.get('/elections/:electionId/analytics', analyticsApiKeyAuth, analyticsController.getElectionAnalytics);
router.get('/elections/:electionId/demographics', analyticsApiKeyAuth, analyticsController.getVoterDemographics);

export default router;