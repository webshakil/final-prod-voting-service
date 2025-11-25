// src/services/analyticsApiKeyService.js
// VOTING-SERVICE (3007) - Completely separate from election-service

import crypto from 'crypto';
import pool from '../config/database.js';

class AnalyticsApiKeyService {

  // Create new analytics API key
  async createApiKey(userId, options) {
    const { name, description, environment = 'live', expiresAt } = options;

    const keyPrefix = environment === 'test' ? 'vta_test_' : 'vta_live_';
    const rawKey = keyPrefix + crypto.randomBytes(24).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPreview = rawKey.substring(0, 16) + '...';

    const result = await pool.query(`
      INSERT INTO votteryy_analytics_api_keys 
      (user_id, name, description, key_hash, key_preview, environment, expires_at, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, true)
      RETURNING id, name, description, key_preview, environment, is_active, created_at
    `, [userId, name, description, keyHash, keyPreview, environment, expiresAt]);

    return {
      ...result.rows[0],
      api_key: rawKey // Only returned once at creation
    };
  }

  // Get all analytics API keys for display
  async getApiKeys() {
    const result = await pool.query(`
      SELECT 
        ak.id,
        ak.user_id,
        ak.name,
        ak.description,
        ak.key_preview,
        ak.environment,
        ak.is_active,
        ak.expires_at,
        ak.last_used_at,
        ak.rate_limit_per_hour,
        ak.created_at,
        ud.first_name || ' ' || ud.last_name as created_by
      FROM votteryy_analytics_api_keys ak
      LEFT JOIN votteryy_user_details ud ON ak.user_id = ud.user_id
      ORDER BY ak.created_at DESC
    `);
    return result.rows;
  }

  // Get single API key by ID
  async getApiKeyById(id) {
    const result = await pool.query(`
      SELECT * FROM votteryy_analytics_api_keys WHERE id = $1
    `, [id]);
    return result.rows[0];
  }

  // Validate API key (for auth middleware)
  async validateApiKey(rawKey) {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    
    const result = await pool.query(`
      SELECT id, user_id, name, environment, is_active, expires_at,
             rate_limit_per_minute, rate_limit_per_hour, allowed_ips
      FROM votteryy_analytics_api_keys
      WHERE key_hash = $1
    `, [keyHash]);

    return result.rows[0] || null;
  }

  // Update last used timestamp
  async updateLastUsed(id) {
    await pool.query(`
      UPDATE votteryy_analytics_api_keys SET last_used_at = NOW() WHERE id = $1
    `, [id]);
  }

  // Log API usage
  async logUsage(apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent) {
    await pool.query(`
      INSERT INTO votteryy_analytics_api_key_usage 
      (api_key_id, endpoint, method, status_code, response_time_ms, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [apiKeyId, endpoint, method, statusCode, responseTimeMs, ipAddress, userAgent]);
  }

  // Toggle API key status
  async toggleStatus(id, isActive) {
    const result = await pool.query(`
      UPDATE votteryy_analytics_api_keys 
      SET is_active = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, is_active
    `, [isActive, id]);
    return result.rows[0];
  }

  // Delete/Revoke API key
  async revokeApiKey(id) {
    await pool.query(`DELETE FROM votteryy_analytics_api_keys WHERE id = $1`, [id]);
    return true;
  }

  // Get usage stats for an API key
  async getUsageStats(apiKeyId, days = 30) {
    const result = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as total_requests,
        COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400) as successful,
        COUNT(*) FILTER (WHERE status_code >= 400) as errors,
        ROUND(AVG(response_time_ms)) as avg_response_time
      FROM votteryy_analytics_api_key_usage
      WHERE api_key_id = $1 AND created_at >= NOW() - INTERVAL '${days} days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `, [apiKeyId]);
    return result.rows;
  }
}

export default new AnalyticsApiKeyService();