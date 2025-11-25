// src/middleware/analyticsApiKeyAuth.js
// VOTING-SERVICE (3007) - Validates analytics API keys from votteryy_analytics_api_keys table

import analyticsApiKeyService from '../services/analyticsApiKeyService.js';

const analyticsApiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  
  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: { 
        code: 'API_KEY_REQUIRED', 
        message: 'Analytics API key is required. Provide x-api-key header.' 
      }
    });
  }

  // Check if key starts with correct prefix
  if (!apiKey.startsWith('vta_live_') && !apiKey.startsWith('vta_test_')) {
    return res.status(401).json({
      success: false,
      error: { 
        code: 'INVALID_API_KEY_FORMAT', 
        message: 'Invalid API key format. Analytics keys start with vta_live_ or vta_test_' 
      }
    });
  }

  try {
    const keyData = await analyticsApiKeyService.validateApiKey(apiKey);

    if (!keyData) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_API_KEY', message: 'Invalid or unknown API key.' }
      });
    }

    if (!keyData.is_active) {
      return res.status(401).json({
        success: false,
        error: { code: 'API_KEY_INACTIVE', message: 'This API key has been deactivated.' }
      });
    }

    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      return res.status(401).json({
        success: false,
        error: { code: 'API_KEY_EXPIRED', message: 'This API key has expired.' }
      });
    }

    // Check IP allowlist
    if (keyData.allowed_ips && Array.isArray(keyData.allowed_ips) && keyData.allowed_ips.length > 0) {
      const clientIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0]?.trim();
      if (!keyData.allowed_ips.includes(clientIp)) {
        return res.status(403).json({
          success: false,
          error: { code: 'IP_NOT_ALLOWED', message: 'Request from this IP address is not allowed.' }
        });
      }
    }

    // Update last used (async, don't wait)
    analyticsApiKeyService.updateLastUsed(keyData.id).catch(() => {});

    // Log usage (async, don't wait)
    const startTime = Date.now();
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      analyticsApiKeyService.logUsage(
        keyData.id,
        req.originalUrl || req.url,
        req.method,
        res.statusCode,
        responseTime,
        req.ip || req.connection?.remoteAddress,
        req.headers['user-agent'] || 'Unknown'
      ).catch(() => {});
    });

    // Attach API key info to request
    req.apiKey = {
      id: keyData.id,
      userId: keyData.user_id,
      name: keyData.name,
      environment: keyData.environment
    };

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', keyData.rate_limit_per_hour || 1000);

    return next();

  } catch (error) {
    console.error('Analytics API Key Auth Error:', error);
    return res.status(500).json({
      success: false,
      error: { code: 'SERVER_ERROR', message: 'Authentication failed.' }
    });
  }
};

export default analyticsApiKeyAuth;