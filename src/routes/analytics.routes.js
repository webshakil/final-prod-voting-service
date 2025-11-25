// src/routes/analytics.routes.js
// VOTING-SERVICE (3007) - Analytics API Routes
// Supports both API Key auth (x-api-key) and User auth (x-user-data)

import express from 'express';
import analyticsController from '../controllers/analytics.controller.js';
import analyticsApiKeyAuth from '../ middleware/analyticsApiKeyAuth.js';
//import { analyticsApiKeyAuth } from '../middleware/analyticsApiKeyAuth.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: Check for API Key OR User Authentication
// ═══════════════════════════════════════════════════════════════════════════
const flexibleAuth = async (req, res, next) => {
  // Check if API key is provided
  const apiKey = req.headers['x-api-key'];
  
  if (apiKey) {
    // Use API key authentication
    return analyticsApiKeyAuth(req, res, next);
  }
  
  // Check for user authentication via x-user-data header
  const userDataHeader = req.headers['x-user-data'];
  
  if (userDataHeader) {
    try {
      const userData = JSON.parse(userDataHeader);
      if (userData && userData.userId) {
        req.user = userData;
        return next();
      }
    } catch (e) {
      // Invalid JSON, continue to check other auth methods
    }
  }
  
  // Check for Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    req.user = { authorized: true };
    return next();
  }
  
  // No authentication provided
  return res.status(401).json({
    success: false,
    error: 'Authentication required',
    message: 'Provide either x-api-key header or x-user-data header'
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM ANALYTICS ROUTES (Protected)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/analytics/platform/report - Comprehensive platform report
// Query params: period (days, default 30, max 365)
router.get('/platform/report', flexibleAuth, analyticsController.getComprehensivePlatformReport.bind(analyticsController));

// GET /api/analytics/platform/revenue - Revenue report
// Query params: dateFrom, dateTo, groupBy (day/week/month)
router.get('/platform/revenue', flexibleAuth, analyticsController.getRevenueReport.bind(analyticsController));

// GET /api/analytics/platform/realtime - Real-time statistics
router.get('/platform/realtime', flexibleAuth, analyticsController.getRealTimeStats.bind(analyticsController));

// ═══════════════════════════════════════════════════════════════════════════
// ELECTION-SPECIFIC ANALYTICS ROUTES (Protected)
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/analytics/elections/:electionId/analytics - Election analytics
router.get('/elections/:electionId/analytics', flexibleAuth, analyticsController.getElectionAnalytics.bind(analyticsController));

// GET /api/analytics/elections/:electionId/demographics - Voter demographics
router.get('/elections/:electionId/demographics', flexibleAuth, analyticsController.getVoterDemographics.bind(analyticsController));

export default router;
// // src/routes/analytics.routes.js
// // VOTING-SERVICE (3007) - Analytics API Routes
// // Supports both API Key auth (x-api-key) and User auth (x-user-data)

// import express from 'express';
// import analyticsController from '../controllers/analytics.controller.js';
// import analyticsApiKeyAuth from '../ middleware/analyticsApiKeyAuth.js';
// //import { analyticsApiKeyAuth } from '../middleware/analyticsApiKeyAuth.js';

// const router = express.Router();

// // ═══════════════════════════════════════════════════════════════════════════
// // MIDDLEWARE: Check for API Key OR User Authentication
// // ═══════════════════════════════════════════════════════════════════════════
// const flexibleAuth = async (req, res, next) => {
//   // Check if API key is provided
//   const apiKey = req.headers['x-api-key'];
  
//   if (apiKey) {
//     // Use API key authentication
//     return analyticsApiKeyAuth(req, res, next);
//   }
  
//   // Check for user authentication via x-user-data header
//   const userDataHeader = req.headers['x-user-data'];
  
//   if (userDataHeader) {
//     try {
//       const userData = JSON.parse(userDataHeader);
//       if (userData && userData.userId) {
//         req.user = userData;
//         return next();
//       }
//     } catch (e) {
//       // Invalid JSON, continue to check other auth methods
//     }
//   }
  
//   // Check for Authorization header
//   const authHeader = req.headers['authorization'];
//   if (authHeader) {
//     req.user = { authorized: true };
//     return next();
//   }
  
//   // No authentication provided
//   return res.status(401).json({
//     success: false,
//     error: 'Authentication required',
//     message: 'Provide either x-api-key header or x-user-data header'
//   });
// };

// // ═══════════════════════════════════════════════════════════════════════════
// // PLATFORM ANALYTICS ROUTES (Protected)
// // ═══════════════════════════════════════════════════════════════════════════

// // GET /api/analytics/platform/report - Comprehensive platform report
// // Query params: period (days, default 30, max 365)
// router.get('/platform/report', flexibleAuth, analyticsController.getComprehensivePlatformReport);

// // GET /api/analytics/platform/revenue - Revenue report
// // Query params: dateFrom, dateTo, groupBy (day/week/month)
// router.get('/platform/revenue', flexibleAuth, analyticsController.getRevenueReport);

// // GET /api/analytics/platform/realtime - Real-time statistics
// router.get('/platform/realtime', flexibleAuth, analyticsController.getRealTimeStats);

// // GET /api/analytics/platform/export - Export analytics data
// // Query params: type (elections/votes/revenue), format (json/csv)
// router.get('/platform/export', flexibleAuth, analyticsController.exportAnalyticsData);

// // ═══════════════════════════════════════════════════════════════════════════
// // ELECTION-SPECIFIC ANALYTICS ROUTES (Protected)
// // ═══════════════════════════════════════════════════════════════════════════

// // GET /api/analytics/elections/:electionId/analytics - Election analytics
// router.get('/elections/:electionId/analytics', flexibleAuth, analyticsController.getElectionAnalytics);

// // GET /api/analytics/elections/:electionId/demographics - Voter demographics
// router.get('/elections/:electionId/demographics', flexibleAuth, analyticsController.getVoterDemographics);

// export default router;
// // src/routes/analytics.routes.js
// // VOTING-SERVICE (3007) - Analytics data endpoints
// // Requires analytics API key (vta_live_xxx or vta_test_xxx)

// import express from 'express';
// import analyticsController from '../controllers/analytics.controller.js';
// import analyticsApiKeyAuth from '../ middleware/analyticsApiKeyAuth.js';
// //import analyticsApiKeyAuth from '../middleware/analyticsApiKeyAuth.js';

// const router = express.Router();

// // All routes require valid analytics API key
// router.get('/platform/report', analyticsApiKeyAuth, analyticsController.getComprehensivePlatformReport);
// router.get('/platform/revenue', analyticsApiKeyAuth, analyticsController.getRevenueReport);
// router.get('/platform/realtime', analyticsApiKeyAuth, analyticsController.getRealTimeStats);
// router.get('/elections/:electionId/analytics', analyticsApiKeyAuth, analyticsController.getElectionAnalytics);
// router.get('/elections/:electionId/demographics', analyticsApiKeyAuth, analyticsController.getVoterDemographics);

// export default router;