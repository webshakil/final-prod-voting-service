// src/routes/analyticsApiKeyRoutes.js
// VOTING-SERVICE (3007) - Routes for managing analytics API keys

import express from 'express';
import analyticsApiKeyController from '../controllers/analyticsApiKeyController.js';
import roleCheck from '../ middleware/roleCheck.js';
//import roleCheck from '../middleware/roleCheck.js';

const router = express.Router();

// All routes require admin or manager role
const adminOnly = roleCheck(['admin', 'manager']);

// Create new analytics API key
// POST /api/admin/analytics-api-keys
router.post('/', adminOnly, analyticsApiKeyController.createApiKey);

// Get all analytics API keys
// GET /api/admin/analytics-api-keys
router.get('/', adminOnly, analyticsApiKeyController.getApiKeys);

// Toggle API key status (enable/disable)
// PATCH /api/admin/analytics-api-keys/:id/status
router.patch('/:id/status', adminOnly, analyticsApiKeyController.toggleStatus);

// Revoke/Delete API key
// DELETE /api/admin/analytics-api-keys/:id
router.delete('/:id', adminOnly, analyticsApiKeyController.revokeApiKey);

// Get usage stats for an API key
// GET /api/admin/analytics-api-keys/:id/usage
router.get('/:id/usage', adminOnly, analyticsApiKeyController.getUsageStats);

export default router;