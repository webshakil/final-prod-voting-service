// src/controllers/analyticsApiKeyController.js
// VOTING-SERVICE (3007) - Manages analytics API keys

import analyticsApiKeyService from '../services/analyticsApiKeyService.js';

class AnalyticsApiKeyController {

  // Create new analytics API key
  async createApiKey(req, res) {
    try {
      const userId = req.user.userId;
      const userRoles = req.user.roles || [];

      // Check if admin or manager
      const isAdminOrManager = userRoles.some(role => {
        const normalized = typeof role === 'string' 
          ? role.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase() 
          : '';
        return ['admin', 'manager'].includes(normalized);
      });

      if (!isAdminOrManager) {
        return res.status(403).json({
          success: false,
          message: 'Only admin or manager can create analytics API keys.'
        });
      }

      const { name, description, environment, expires_at } = req.body;

      if (!name || !name.trim()) {
        return res.status(400).json({
          success: false,
          message: 'API key name is required.'
        });
      }

      const apiKey = await analyticsApiKeyService.createApiKey(userId, {
        name: name.trim(),
        description: description?.trim() || null,
        environment: environment || 'live',
        expiresAt: expires_at || null
      });

      return res.status(201).json({
        success: true,
        message: 'Analytics API key created successfully. Save it now - you will not see it again!',
        data: apiKey
      });

    } catch (error) {
      console.error('Create Analytics API Key Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to create analytics API key.',
        error: error.message
      });
    }
  }

  // Get all analytics API keys
  async getApiKeys(req, res) {
    try {
      const keys = await analyticsApiKeyService.getApiKeys();
      return res.status(200).json({
        success: true,
        data: keys
      });
    } catch (error) {
      console.error('Get Analytics API Keys Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch analytics API keys.'
      });
    }
  }

  // Toggle API key status (enable/disable)
  async toggleStatus(req, res) {
    try {
      const { id } = req.params;
      const { is_active } = req.body;

      const result = await analyticsApiKeyService.toggleStatus(id, is_active);
      
      if (!result) {
        return res.status(404).json({
          success: false,
          message: 'API key not found.'
        });
      }

      return res.status(200).json({
        success: true,
        message: `API key ${is_active ? 'enabled' : 'disabled'} successfully.`,
        data: result
      });
    } catch (error) {
      console.error('Toggle Analytics API Key Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to update API key.'
      });
    }
  }

  // Revoke/Delete API key
  async revokeApiKey(req, res) {
    try {
      const { id } = req.params;
      
      await analyticsApiKeyService.revokeApiKey(id);
      
      return res.status(200).json({
        success: true,
        message: 'API key revoked successfully.'
      });
    } catch (error) {
      console.error('Revoke Analytics API Key Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to revoke API key.'
      });
    }
  }

  // Get usage stats for an API key
  async getUsageStats(req, res) {
    try {
      const { id } = req.params;
      const { days = 30 } = req.query;

      const stats = await analyticsApiKeyService.getUsageStats(id, parseInt(days));
      
      return res.status(200).json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('Get Analytics API Key Usage Error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch usage stats.'
      });
    }
  }
}

export default new AnalyticsApiKeyController();