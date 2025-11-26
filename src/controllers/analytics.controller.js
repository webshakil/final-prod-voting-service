// src/controllers/analytics.controller.js
// VOTING-SERVICE (3007) - Platform Analytics Data
// ONLY uses verified columns from actual database schemas

import pool from '../config/database.js';

class AnalyticsController {

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPREHENSIVE PLATFORM REPORT
  // ═══════════════════════════════════════════════════════════════════════════
  async getComprehensivePlatformReport(req, res) {
    try {
      const { period = '30' } = req.query;
      const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

      // ─────────────────────────────────────────────────────────────────────────
      // OVERVIEW STATS (safe queries)
      // ─────────────────────────────────────────────────────────────────────────
      const overviewResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
          (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
          (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
          (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE lottery_enabled = true) as lottery_elections,
          (SELECT COALESCE(SUM(lottery_total_prize_pool), 0) FROM votteryyy_elections WHERE lottery_enabled = true) as total_prize_pool
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // USER STATISTICS (using actual votteryy_user_details columns)
      // ─────────────────────────────────────────────────────────────────────────
      const userStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_registered,
          COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as new_users_period,
          COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '7 days') as new_users_week,
          COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '1 day') as new_users_today
        FROM votteryy_user_details
      `);

      const usersByCountryResult = await pool.query(`
        SELECT country, COUNT(*) as count
        FROM votteryy_user_details 
        WHERE country IS NOT NULL
        GROUP BY country 
        ORDER BY count DESC 
        LIMIT 10
      `);

      const usersByGenderResult = await pool.query(`
        SELECT COALESCE(gender, 'Not Specified') as gender, COUNT(*) as count
        FROM votteryy_user_details 
        GROUP BY gender
      `);

      // Age groups using actual 'age' column (not date_of_birth)
      const usersByAgeResult = await pool.query(`
        SELECT 
          CASE 
            WHEN age < 18 THEN 'Under 18'
            WHEN age BETWEEN 18 AND 24 THEN '18-24'
            WHEN age BETWEEN 25 AND 34 THEN '25-34'
            WHEN age BETWEEN 35 AND 44 THEN '35-44'
            WHEN age BETWEEN 45 AND 54 THEN '45-54'
            WHEN age BETWEEN 55 AND 64 THEN '55-64'
            WHEN age >= 65 THEN '65+'
            ELSE 'Unknown'
          END as age_group,
          COUNT(*) as count
        FROM votteryy_user_details
        WHERE age IS NOT NULL
        GROUP BY age_group
      `);

      const userTrendResult = await pool.query(`
        SELECT DATE(collected_at) as date, COUNT(*) as count
        FROM votteryy_user_details
        WHERE collected_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE(collected_at) 
        ORDER BY date ASC
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // ELECTION STATISTICS (using actual votteryyy_elections columns)
      // ─────────────────────────────────────────────────────────────────────────
      const electionStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total,
          -- Status breakdown
          COUNT(*) FILTER (WHERE status = 'draft') as draft,
          COUNT(*) FILTER (WHERE status = 'published') as published,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
          -- Voting type breakdown
          COUNT(*) FILTER (WHERE voting_type = 'plurality') as plurality,
          COUNT(*) FILTER (WHERE voting_type = 'ranked_choice') as ranked_choice,
          COUNT(*) FILTER (WHERE voting_type = 'approval') as approval,
          -- Pricing breakdown
          COUNT(*) FILTER (WHERE is_free = true) as free_elections,
          COUNT(*) FILTER (WHERE is_free = false) as paid_elections,
          -- Permission type breakdown
          COUNT(*) FILTER (WHERE permission_type = 'public') as permission_public,
          COUNT(*) FILTER (WHERE permission_type = 'country_specific') as permission_country_specific,
          COUNT(*) FILTER (WHERE permission_type = 'specific_group') as permission_specific_group,
          COUNT(*) FILTER (WHERE permission_type = 'organization_only') as permission_organization_only,
          -- Creator type breakdown
          COUNT(*) FILTER (WHERE creator_type = 'individual') as creator_individual,
          COUNT(*) FILTER (WHERE creator_type = 'organization') as creator_organization,
          COUNT(*) FILTER (WHERE creator_type = 'content_creator') as creator_content_creator,
          -- Feature usage
          COUNT(*) FILTER (WHERE lottery_enabled = true) as lottery_enabled_count,
          COUNT(*) FILTER (WHERE biometric_required = true) as biometric_required_count,
          COUNT(*) FILTER (WHERE anonymous_voting_enabled = true) as anonymous_voting_count,
          COUNT(*) FILTER (WHERE video_watch_required = true) as video_required_count,
          COUNT(*) FILTER (WHERE show_live_results = true) as live_results_count,
          COUNT(*) FILTER (WHERE vote_editing_allowed = true) as vote_editing_count,
          -- Period stats
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_period,
          -- Aggregates
          COALESCE(SUM(view_count), 0) as total_views,
          COALESCE(SUM(vote_count), 0) as total_vote_count,
          COALESCE(SUM(lottery_total_prize_pool), 0) as total_lottery_prize_pool
        FROM votteryyy_elections
      `);

      const electionTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM votteryyy_elections
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE(created_at) 
        ORDER BY date ASC
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // VOTE STATISTICS (using actual votteryy_votes columns)
      // ─────────────────────────────────────────────────────────────────────────
      const voteStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_votes,
          COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
          COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
          COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
          COUNT(*) FILTER (WHERE anonymous = true) as anonymous_votes,
          COUNT(DISTINCT user_id) as unique_voters,
          COUNT(DISTINCT election_id) as elections_with_votes,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as votes_period,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as votes_week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as votes_today
        FROM votteryy_votes
      `);

      const voteTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM votteryy_votes
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid'
        GROUP BY DATE(created_at) 
        ORDER BY date ASC
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // LOTTERY STATISTICS (using actual votteryy_lottery_draws columns)
      // ─────────────────────────────────────────────────────────────────────────
      let lotteryStats = { total_draws: 0, completed_draws: 0, pending_draws: 0, total_participants: 0, total_winner_slots: 0 };
      try {
        const lotteryStatsResult = await pool.query(`
          SELECT
            COUNT(*) as total_draws,
            COUNT(*) FILTER (WHERE status = 'completed') as completed_draws,
            COUNT(*) FILTER (WHERE status = 'pending') as pending_draws,
            COALESCE(SUM(total_participants), 0) as total_participants,
            COALESCE(SUM(winner_count), 0) as total_winner_slots
          FROM votteryy_lottery_draws
        `);
        lotteryStats = lotteryStatsResult.rows[0];
      } catch (e) {
        console.log('Lottery stats query failed:', e.message);
      }

      // Lottery election breakdown by reward type
      const lotteryBreakdownResult = await pool.query(`
        SELECT
          lottery_reward_type,
          COUNT(*) as count,
          COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool
        FROM votteryyy_elections
        WHERE lottery_enabled = true AND lottery_reward_type IS NOT NULL
        GROUP BY lottery_reward_type
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // SUBSCRIPTION STATISTICS (using actual votteryy_user_subscriptions columns)
      // ─────────────────────────────────────────────────────────────────────────
      let subscriptionStats = { total_subscriptions: 0, active: 0, cancelled: 0, expired: 0 };
      let subscriptionByPlan = [];
      let subscriptionByGateway = [];
      try {
        const subscriptionStatsResult = await pool.query(`
          SELECT
            COUNT(*) as total_subscriptions,
            COUNT(*) FILTER (WHERE status = 'active') as active,
            COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
            COUNT(*) FILTER (WHERE status = 'expired') as expired,
            COUNT(*) FILTER (WHERE payment_type = 'recurring') as recurring_count,
            COUNT(*) FILTER (WHERE payment_type = 'pay_as_you_go') as pay_as_you_go_count,
            COUNT(*) FILTER (WHERE auto_renew = true) as auto_renew_enabled,
            COALESCE(SUM(total_usage_amount), 0) as total_usage_amount,
            COALESCE(SUM(unpaid_usage_amount), 0) as total_unpaid_amount
          FROM votteryy_user_subscriptions
        `);
        subscriptionStats = subscriptionStatsResult.rows[0];

        const subscriptionByPlanResult = await pool.query(`
          SELECT plan_id, COUNT(*) as count
          FROM votteryy_user_subscriptions 
          WHERE status = 'active' AND plan_id IS NOT NULL
          GROUP BY plan_id 
          ORDER BY count DESC
        `);
        subscriptionByPlan = subscriptionByPlanResult.rows;

        const subscriptionByGatewayResult = await pool.query(`
          SELECT COALESCE(gateway, 'unknown') as gateway, COUNT(*) as count
          FROM votteryy_user_subscriptions 
          WHERE status = 'active'
          GROUP BY gateway
        `);
        subscriptionByGateway = subscriptionByGatewayResult.rows;
      } catch (e) {
        console.log('Subscription stats query failed:', e.message);
      }

      // ─────────────────────────────────────────────────────────────────────────
      // TOP ELECTIONS
      // ─────────────────────────────────────────────────────────────────────────
      const topElectionsResult = await pool.query(`
        SELECT id, title, status, vote_count, view_count, lottery_enabled, is_free, created_at
        FROM votteryyy_elections
        ORDER BY vote_count DESC NULLS LAST
        LIMIT 10
      `);

      // ─────────────────────────────────────────────────────────────────────────
      // RESPONSE
      // ─────────────────────────────────────────────────────────────────────────
      res.json({
        success: true,
        data: {
          period: periodDays,
          generatedAt: new Date().toISOString(),
          overview: overviewResult.rows[0],
          users: {
            stats: userStatsResult.rows[0],
            byCountry: usersByCountryResult.rows,
            byGender: usersByGenderResult.rows,
            byAge: usersByAgeResult.rows,
            trend: userTrendResult.rows
          },
          elections: {
            stats: electionStatsResult.rows[0],
            trend: electionTrendResult.rows,
            topElections: topElectionsResult.rows
          },
          votes: {
            stats: voteStatsResult.rows[0],
            trend: voteTrendResult.rows
          },
          lottery: {
            stats: lotteryStats,
            byRewardType: lotteryBreakdownResult.rows
          },
          subscriptions: {
            stats: subscriptionStats,
            byPlan: subscriptionByPlan,
            byGateway: subscriptionByGateway
          }
        }
      });

    } catch (error) {
      console.error('Get comprehensive platform report error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve platform report',
        details: error.message
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REAL-TIME STATS
  // ═══════════════════════════════════════════════════════════════════════════
  async getRealTimeStats(req, res) {
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'published') as published_elections,
          (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
          (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '24 hours') as votes_last_24h,
          (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h,
          (SELECT COUNT(*) FROM votteryy_lottery_draws WHERE status = 'pending') as pending_lottery_draws
      `);

      // Recent votes
      const recentVotesResult = await pool.query(`
        SELECT v.id, v.election_id, v.created_at, v.anonymous, e.title as election_title
        FROM votteryy_votes v
        JOIN votteryyy_elections e ON v.election_id = e.id
        WHERE v.status = 'valid'
        ORDER BY v.created_at DESC 
        LIMIT 10
      `);

      // Active elections
      const activeElectionsResult = await pool.query(`
        SELECT 
          id, title, status, end_date, vote_count, view_count, lottery_enabled, is_free
        FROM votteryyy_elections
        WHERE status = 'active'
        ORDER BY end_date ASC 
        LIMIT 10
      `);

      res.json({
        success: true,
        data: {
          stats: result.rows[0],
          recentVotes: recentVotesResult.rows,
          activeElections: activeElectionsResult.rows,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      console.error('Get real-time stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve real-time stats',
        details: error.message
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REVENUE REPORT (stub - no payment table schema provided)
  // ═══════════════════════════════════════════════════════════════════════════
  async getRevenueReport(req, res) {
    try {
      // Since votteryy_election_payments schema not provided, return elections revenue data
      const { dateFrom, dateTo, groupBy = 'day' } = req.query;

      let dateFilter = '';
      if (dateFrom && dateTo) {
        dateFilter = `WHERE created_at BETWEEN '${dateFrom}' AND '${dateTo}'`;
      } else if (dateFrom) {
        dateFilter = `WHERE created_at >= '${dateFrom}'`;
      } else if (dateTo) {
        dateFilter = `WHERE created_at <= '${dateTo}'`;
      }

      let groupFormat;
      switch (groupBy) {
        case 'week':
          groupFormat = "DATE_TRUNC('week', created_at)";
          break;
        case 'month':
          groupFormat = "DATE_TRUNC('month', created_at)";
          break;
        default:
          groupFormat = 'DATE(created_at)';
      }

      // Use subscription data for revenue approximation
      const subscriptionRevenueResult = await pool.query(`
        SELECT
          COALESCE(SUM(total_usage_amount), 0) as total_usage_revenue,
          COALESCE(SUM(unpaid_usage_amount), 0) as pending_revenue,
          COUNT(*) as total_subscriptions,
          COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions
        FROM votteryy_user_subscriptions
      `);

      // Election participation fees
      const electionFeesResult = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE is_free = false) as paid_elections,
          COALESCE(SUM(general_participation_fee), 0) as total_participation_fees,
          COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pools
        FROM votteryyy_elections
        ${dateFilter}
      `);

      res.json({
        success: true,
        data: {
          subscriptions: subscriptionRevenueResult.rows[0],
          elections: electionFeesResult.rows[0],
          groupBy,
          dateRange: { from: dateFrom, to: dateTo },
          note: 'Revenue data from subscriptions and election fees'
        }
      });

    } catch (error) {
      console.error('Get revenue report error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve revenue report',
        details: error.message
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ELECTION ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════════
  async getElectionAnalytics(req, res) {
    try {
      const { electionId } = req.params;

      // Election details
      const electionResult = await pool.query(`
        SELECT 
          id, creator_id, creator_type, organization_id,
          title, description, slug,
          topic_image_url, topic_video_url, logo_url, video_url,
          start_date, start_time, end_date, end_time, timezone,
          voting_type, permission_type, allowed_countries,
          is_free, pricing_type, general_participation_fee,
          biometric_required, show_live_results, vote_editing_allowed,
          status, view_count, vote_count,
          created_at, updated_at, published_at,
          video_watch_required, minimum_watch_time, minimum_watch_percentage,
          lottery_enabled, lottery_reward_type, lottery_total_prize_pool,
          lottery_winner_count, lottery_draw_date,
          category_id, anonymous_voting_enabled
        FROM votteryyy_elections 
        WHERE id = $1
      `, [electionId]);

      if (electionResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Election not found'
        });
      }

      // Vote statistics
      const voteStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_votes,
          COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
          COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
          COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
          COUNT(*) FILTER (WHERE anonymous = true) as anonymous_votes,
          COUNT(DISTINCT user_id) as unique_voters,
          MIN(created_at) as first_vote,
          MAX(created_at) as last_vote
        FROM votteryy_votes 
        WHERE election_id = $1
      `, [electionId]);

      // Vote trend
      const voteTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM votteryy_votes
        WHERE election_id = $1 AND status = 'valid'
        GROUP BY DATE(created_at) 
        ORDER BY date ASC
      `, [electionId]);

      // Hourly distribution
      const hourlyDistResult = await pool.query(`
        SELECT EXTRACT(HOUR FROM created_at)::integer as hour, COUNT(*) as count
        FROM votteryy_votes
        WHERE election_id = $1 AND status = 'valid'
        GROUP BY hour 
        ORDER BY hour ASC
      `, [electionId]);

      // Lottery info if enabled
      let lotteryInfo = null;
      if (electionResult.rows[0].lottery_enabled) {
        const lotteryResult = await pool.query(`
          SELECT id, draw_id, total_participants, winner_count, draw_time, status, created_at
          FROM votteryy_lottery_draws 
          WHERE election_id = $1
        `, [electionId]);
        lotteryInfo = lotteryResult.rows[0] || null;
      }

      res.json({
        success: true,
        data: {
          election: electionResult.rows[0],
          votes: {
            stats: voteStatsResult.rows[0],
            trend: voteTrendResult.rows,
            hourlyDistribution: hourlyDistResult.rows
          },
          lottery: lotteryInfo
        }
      });

    } catch (error) {
      console.error('Get election analytics error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve election analytics',
        details: error.message
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VOTER DEMOGRAPHICS
  // ═══════════════════════════════════════════════════════════════════════════
  async getVoterDemographics(req, res) {
    try {
      const { electionId } = req.params;

      // Check election exists
      const electionCheck = await pool.query(`SELECT id FROM votteryyy_elections WHERE id = $1`, [electionId]);
      if (electionCheck.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Election not found' });
      }

      // Voters by country
      const byCountryResult = await pool.query(`
        SELECT ud.country, COUNT(DISTINCT v.user_id) as count
        FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid' AND ud.country IS NOT NULL
        GROUP BY ud.country 
        ORDER BY count DESC 
        LIMIT 15
      `, [electionId]);

      // Voters by gender
      const byGenderResult = await pool.query(`
        SELECT COALESCE(ud.gender, 'Not Specified') as gender, COUNT(DISTINCT v.user_id) as count
        FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid'
        GROUP BY ud.gender
      `, [electionId]);

      // Voters by age group (using age column)
      const byAgeResult = await pool.query(`
        SELECT 
          CASE 
            WHEN ud.age < 18 THEN 'Under 18'
            WHEN ud.age BETWEEN 18 AND 24 THEN '18-24'
            WHEN ud.age BETWEEN 25 AND 34 THEN '25-34'
            WHEN ud.age BETWEEN 35 AND 44 THEN '35-44'
            WHEN ud.age BETWEEN 45 AND 54 THEN '45-54'
            WHEN ud.age BETWEEN 55 AND 64 THEN '55-64'
            WHEN ud.age >= 65 THEN '65+'
            ELSE 'Unknown'
          END as age_group,
          COUNT(DISTINCT v.user_id) as count
        FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid'
        GROUP BY age_group
      `, [electionId]);

      // Total unique voters
      const totalVotersResult = await pool.query(`
        SELECT COUNT(DISTINCT user_id) as total
        FROM votteryy_votes
        WHERE election_id = $1 AND status = 'valid'
      `, [electionId]);

      // Voters by city
      const byCityResult = await pool.query(`
        SELECT ud.city, COUNT(DISTINCT v.user_id) as count
        FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid' AND ud.city IS NOT NULL
        GROUP BY ud.city 
        ORDER BY count DESC 
        LIMIT 10
      `, [electionId]);

      res.json({
        success: true,
        data: {
          totalVoters: parseInt(totalVotersResult.rows[0]?.total || 0),
          byCountry: byCountryResult.rows,
          byGender: byGenderResult.rows,
          byAgeGroup: byAgeResult.rows,
          byCity: byCityResult.rows
        }
      });

    } catch (error) {
      console.error('Get voter demographics error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve voter demographics',
        details: error.message
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
// PLATFORM REVENUE REPORT - Subscription & Platform Fee Earnings
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// PLATFORM REVENUE REPORT - Subscription & Platform Fee Earnings
// ═══════════════════════════════════════════════════════════════════════════
async getPlatformRevenueReport(req, res) {
  try {
    const { period = '30' } = req.query;
    const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

    // ─────────────────────────────────────────────────────────────────────────
    // SUBSCRIPTION STATS (from votteryy_user_subscriptions)
    // Note: This table tracks usage-based billing, not fixed subscription amounts
    // ─────────────────────────────────────────────────────────────────────────
    const subscriptionStatsResult = await pool.query(`
      SELECT
        COUNT(*) as total_subscriptions,
        COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions,
        COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_subscriptions,
        COUNT(*) FILTER (WHERE status = 'expired') as expired_subscriptions,
        COALESCE(SUM(total_usage_amount), 0) as total_usage_revenue,
        COALESCE(SUM(CASE WHEN status = 'active' THEN total_usage_amount ELSE 0 END), 0) as active_usage_revenue,
        COALESCE(SUM(unpaid_usage_amount), 0) as total_unpaid_amount,
        COUNT(*) FILTER (WHERE payment_type = 'recurring') as recurring_count,
        COUNT(*) FILTER (WHERE payment_type = 'pay_as_you_go') as pay_as_you_go_count,
        COUNT(*) FILTER (WHERE auto_renew = true) as auto_renew_enabled,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_subscriptions_period,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') as new_subscriptions_30d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_subscriptions_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as new_subscriptions_today
      FROM votteryy_user_subscriptions
    `);

    // Subscription by plan
    const subscriptionByPlanResult = await pool.query(`
      SELECT 
        COALESCE(plan_id::text, 'unknown') as plan_id,
        COUNT(*) as subscription_count,
        COALESCE(SUM(total_usage_amount), 0) as total_usage
      FROM votteryy_user_subscriptions
      WHERE status = 'active'
      GROUP BY plan_id
      ORDER BY subscription_count DESC
    `);

    // Subscription by gateway
    const subscriptionByGatewayResult = await pool.query(`
      SELECT 
        COALESCE(gateway, 'unknown') as gateway,
        COUNT(*) as subscription_count,
        COALESCE(SUM(total_usage_amount), 0) as total_usage
      FROM votteryy_user_subscriptions
      WHERE status = 'active'
      GROUP BY gateway
      ORDER BY subscription_count DESC
    `);

    // Subscription trend (by creation date)
    const subscriptionTrendResult = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count
      FROM votteryy_user_subscriptions
      WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // PLATFORM FEE REVENUE (from votteryy_election_payments)
    // ─────────────────────────────────────────────────────────────────────────
    const platformFeeResult = await pool.query(`
      SELECT
        COUNT(*) as total_payments,
        COUNT(*) FILTER (WHERE status = 'completed' OR status = 'success' OR status = 'succeeded') as successful_payments,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_payments,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_payments,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') THEN platform_fee ELSE 0 END), 0) as total_platform_fee_revenue,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') THEN amount ELSE 0 END), 0) as total_payment_amount,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') THEN net_amount ELSE 0 END), 0) as total_net_amount,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') THEN stripe_fee ELSE 0 END), 0) as total_stripe_fees,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') THEN paddle_fee ELSE 0 END), 0) as total_paddle_fees,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '${periodDays} days' THEN platform_fee ELSE 0 END), 0) as platform_fee_this_period,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '30 days' THEN platform_fee ELSE 0 END), 0) as platform_fee_last_30_days,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '7 days' THEN platform_fee ELSE 0 END), 0) as platform_fee_last_7_days,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '1 day' THEN platform_fee ELSE 0 END), 0) as platform_fee_today,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '${periodDays} days' THEN amount ELSE 0 END), 0) as amount_this_period,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '30 days' THEN amount ELSE 0 END), 0) as amount_last_30_days,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '7 days' THEN amount ELSE 0 END), 0) as amount_last_7_days,
        COALESCE(SUM(CASE WHEN status IN ('completed', 'success', 'succeeded') AND created_at >= NOW() - INTERVAL '1 day' THEN amount ELSE 0 END), 0) as amount_today
      FROM votteryy_election_payments
    `);

    // Platform fee by gateway
    const platformFeeByGatewayResult = await pool.query(`
      SELECT 
        COALESCE(gateway_used, 'unknown') as gateway,
        COUNT(*) as payment_count,
        COALESCE(SUM(platform_fee), 0) as total_platform_fee,
        COALESCE(SUM(amount), 0) as total_amount,
        COALESCE(SUM(net_amount), 0) as total_net_amount,
        COALESCE(SUM(stripe_fee), 0) as stripe_fees,
        COALESCE(SUM(paddle_fee), 0) as paddle_fees
      FROM votteryy_election_payments
      WHERE status IN ('completed', 'success', 'succeeded')
      GROUP BY gateway_used
      ORDER BY total_platform_fee DESC
    `);

    // Platform fee trend
    const platformFeeTrendResult = await pool.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count,
        COALESCE(SUM(platform_fee), 0) as platform_fee,
        COALESCE(SUM(amount), 0) as total_amount
      FROM votteryy_election_payments
      WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        AND status IN ('completed', 'success', 'succeeded')
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Top elections by platform fee
    const topElectionsByFeeResult = await pool.query(`
      SELECT 
        ep.election_id,
        e.title as election_title,
        COUNT(*) as payment_count,
        COALESCE(SUM(ep.platform_fee), 0) as total_platform_fee,
        COALESCE(SUM(ep.amount), 0) as total_amount,
        COALESCE(SUM(ep.net_amount), 0) as total_net_amount
      FROM votteryy_election_payments ep
      LEFT JOIN votteryyy_elections e ON ep.election_id = e.id
      WHERE ep.status IN ('completed', 'success', 'succeeded')
      GROUP BY ep.election_id, e.title
      ORDER BY total_platform_fee DESC
      LIMIT 10
    `);

    // Recent payments
    const recentPaymentsResult = await pool.query(`
      SELECT 
        ep.id,
        ep.payment_id,
        ep.election_id,
        e.title as election_title,
        ep.amount,
        ep.platform_fee,
        ep.net_amount,
        ep.gateway_used,
        ep.status,
        ep.created_at
      FROM votteryy_election_payments ep
      LEFT JOIN votteryyy_elections e ON ep.election_id = e.id
      ORDER BY ep.created_at DESC
      LIMIT 10
    `);

    // ─────────────────────────────────────────────────────────────────────────
    // COMBINED TOTALS
    // ─────────────────────────────────────────────────────────────────────────
    const subscriptionUsageRevenue = parseFloat(subscriptionStatsResult.rows[0]?.total_usage_revenue || 0);
    const platformFeeRevenue = parseFloat(platformFeeResult.rows[0]?.total_platform_fee_revenue || 0);
    const totalPlatformRevenue = subscriptionUsageRevenue + platformFeeRevenue;

    const platformFeePeriod = parseFloat(platformFeeResult.rows[0]?.platform_fee_this_period || 0);

    // ─────────────────────────────────────────────────────────────────────────
    // RESPONSE
    // ─────────────────────────────────────────────────────────────────────────
    res.json({
      success: true,
      data: {
        period: periodDays,
        generatedAt: new Date().toISOString(),
        
        // Combined Summary
        summary: {
          total_platform_revenue: totalPlatformRevenue,
          total_subscription_usage_revenue: subscriptionUsageRevenue,
          total_platform_fee_revenue: platformFeeRevenue,
          total_payment_volume: parseFloat(platformFeeResult.rows[0]?.total_payment_amount || 0),
          total_net_to_creators: parseFloat(platformFeeResult.rows[0]?.total_net_amount || 0),
          total_processing_fees: parseFloat(platformFeeResult.rows[0]?.total_stripe_fees || 0) + parseFloat(platformFeeResult.rows[0]?.total_paddle_fees || 0),
          platform_fee_this_period: platformFeePeriod,
          subscription_percentage: totalPlatformRevenue > 0 ? ((subscriptionUsageRevenue / totalPlatformRevenue) * 100).toFixed(2) : 0,
          platform_fee_percentage: totalPlatformRevenue > 0 ? ((platformFeeRevenue / totalPlatformRevenue) * 100).toFixed(2) : 0
        },

        // Subscription Details (usage-based)
        subscriptions: {
          stats: subscriptionStatsResult.rows[0],
          byPlan: subscriptionByPlanResult.rows,
          byGateway: subscriptionByGatewayResult.rows,
          trend: subscriptionTrendResult.rows
        },

        // Platform Fee Details (from election payments)
        platformFees: {
          stats: platformFeeResult.rows[0],
          byGateway: platformFeeByGatewayResult.rows,
          trend: platformFeeTrendResult.rows,
          topElections: topElectionsByFeeResult.rows,
          recentPayments: recentPaymentsResult.rows
        }
      }
    });

  } catch (error) {
    console.error('Get platform revenue report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve platform revenue report',
      details: error.message
    });
  }
}
// async getPlatformRevenueReport(req, res) {
//   try {
//     const { period = '30', dateFrom, dateTo } = req.query;
//     const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

//     // ─────────────────────────────────────────────────────────────────────────
//     // SUBSCRIPTION REVENUE (from votteryy_user_subscriptions)
//     // ─────────────────────────────────────────────────────────────────────────
//     const subscriptionRevenueResult = await pool.query(`
//       SELECT
//         COUNT(*) as total_subscriptions,
//         COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions,
//         COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_subscriptions,
//         COUNT(*) FILTER (WHERE status = 'expired') as expired_subscriptions,
//         COALESCE(SUM(CASE WHEN status IN ('active', 'cancelled', 'expired') THEN amount ELSE 0 END), 0) as total_subscription_revenue,
//         COALESCE(SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END), 0) as active_subscription_revenue,
//         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '${periodDays} days' THEN amount ELSE 0 END), 0) as revenue_this_period,
//         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN amount ELSE 0 END), 0) as revenue_last_30_days,
//         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN amount ELSE 0 END), 0) as revenue_last_7_days,
//         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '1 day' THEN amount ELSE 0 END), 0) as revenue_today
//       FROM votteryy_user_subscriptions
//     `);

//     // Subscription revenue by plan
//     const subscriptionByPlanResult = await pool.query(`
//       SELECT 
//         COALESCE(plan_id, 'unknown') as plan_id,
//         COUNT(*) as subscription_count,
//         COALESCE(SUM(amount), 0) as total_revenue
//       FROM votteryy_user_subscriptions
//       WHERE status IN ('active', 'cancelled', 'expired')
//       GROUP BY plan_id
//       ORDER BY total_revenue DESC
//     `);

//     // Subscription revenue by gateway
//     const subscriptionByGatewayResult = await pool.query(`
//       SELECT 
//         COALESCE(gateway, 'unknown') as gateway,
//         COUNT(*) as subscription_count,
//         COALESCE(SUM(amount), 0) as total_revenue
//       FROM votteryy_user_subscriptions
//       WHERE status IN ('active', 'cancelled', 'expired')
//       GROUP BY gateway
//       ORDER BY total_revenue DESC
//     `);

//     // Subscription revenue trend
//     const subscriptionTrendResult = await pool.query(`
//       SELECT 
//         DATE(created_at) as date,
//         COUNT(*) as count,
//         COALESCE(SUM(amount), 0) as revenue
//       FROM votteryy_user_subscriptions
//       WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
//       GROUP BY DATE(created_at)
//       ORDER BY date ASC
//     `);

//     // ─────────────────────────────────────────────────────────────────────────
//     // PLATFORM FEE REVENUE (from votteryy_election_payments)
//     // ─────────────────────────────────────────────────────────────────────────
//     const platformFeeResult = await pool.query(`
//       SELECT
//         COUNT(*) as total_payments,
//         COUNT(*) FILTER (WHERE status = 'completed' OR status = 'success') as successful_payments,
//         COUNT(*) FILTER (WHERE status = 'pending') as pending_payments,
//         COUNT(*) FILTER (WHERE status = 'failed') as failed_payments,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') THEN platform_fee ELSE 0 END), 0) as total_platform_fee_revenue,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') THEN amount ELSE 0 END), 0) as total_payment_amount,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') AND created_at >= NOW() - INTERVAL '${periodDays} days' THEN platform_fee ELSE 0 END), 0) as platform_fee_this_period,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') AND created_at >= NOW() - INTERVAL '30 days' THEN platform_fee ELSE 0 END), 0) as platform_fee_last_30_days,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') AND created_at >= NOW() - INTERVAL '7 days' THEN platform_fee ELSE 0 END), 0) as platform_fee_last_7_days,
//         COALESCE(SUM(CASE WHEN status IN ('completed', 'success') AND created_at >= NOW() - INTERVAL '1 day' THEN platform_fee ELSE 0 END), 0) as platform_fee_today
//       FROM votteryy_election_payments
//     `);

//     // Platform fee by payment type/gateway
//     const platformFeeByGatewayResult = await pool.query(`
//       SELECT 
//         COALESCE(gateway, 'unknown') as gateway,
//         COUNT(*) as payment_count,
//         COALESCE(SUM(platform_fee), 0) as total_platform_fee,
//         COALESCE(SUM(amount), 0) as total_amount
//       FROM votteryy_election_payments
//       WHERE status IN ('completed', 'success')
//       GROUP BY gateway
//       ORDER BY total_platform_fee DESC
//     `);

//     // Platform fee trend
//     const platformFeeTrendResult = await pool.query(`
//       SELECT 
//         DATE(created_at) as date,
//         COUNT(*) as count,
//         COALESCE(SUM(platform_fee), 0) as platform_fee,
//         COALESCE(SUM(amount), 0) as total_amount
//       FROM votteryy_election_payments
//       WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
//         AND status IN ('completed', 'success')
//       GROUP BY DATE(created_at)
//       ORDER BY date ASC
//     `);

//     // Top elections by platform fee
//     const topElectionsByFeeResult = await pool.query(`
//       SELECT 
//         ep.election_id,
//         e.title as election_title,
//         COUNT(*) as payment_count,
//         COALESCE(SUM(ep.platform_fee), 0) as total_platform_fee,
//         COALESCE(SUM(ep.amount), 0) as total_amount
//       FROM votteryy_election_payments ep
//       LEFT JOIN votteryyy_elections e ON ep.election_id = e.id
//       WHERE ep.status IN ('completed', 'success')
//       GROUP BY ep.election_id, e.title
//       ORDER BY total_platform_fee DESC
//       LIMIT 10
//     `);

//     // ─────────────────────────────────────────────────────────────────────────
//     // COMBINED TOTALS
//     // ─────────────────────────────────────────────────────────────────────────
//     const subscriptionRevenue = parseFloat(subscriptionRevenueResult.rows[0]?.total_subscription_revenue || 0);
//     const platformFeeRevenue = parseFloat(platformFeeResult.rows[0]?.total_platform_fee_revenue || 0);
//     const totalPlatformRevenue = subscriptionRevenue + platformFeeRevenue;

//     const subscriptionRevenuePeriod = parseFloat(subscriptionRevenueResult.rows[0]?.revenue_this_period || 0);
//     const platformFeePeriod = parseFloat(platformFeeResult.rows[0]?.platform_fee_this_period || 0);
//     const totalRevenuePeriod = subscriptionRevenuePeriod + platformFeePeriod;

//     // ─────────────────────────────────────────────────────────────────────────
//     // RESPONSE
//     // ─────────────────────────────────────────────────────────────────────────
//     res.json({
//       success: true,
//       data: {
//         period: periodDays,
//         generatedAt: new Date().toISOString(),
        
//         // Combined Summary
//         summary: {
//           total_platform_revenue: totalPlatformRevenue,
//           total_subscription_revenue: subscriptionRevenue,
//           total_platform_fee_revenue: platformFeeRevenue,
//           revenue_this_period: totalRevenuePeriod,
//           subscription_revenue_period: subscriptionRevenuePeriod,
//           platform_fee_revenue_period: platformFeePeriod,
//           subscription_percentage: totalPlatformRevenue > 0 ? ((subscriptionRevenue / totalPlatformRevenue) * 100).toFixed(2) : 0,
//           platform_fee_percentage: totalPlatformRevenue > 0 ? ((platformFeeRevenue / totalPlatformRevenue) * 100).toFixed(2) : 0
//         },

//         // Subscription Details
//         subscriptions: {
//           stats: subscriptionRevenueResult.rows[0],
//           byPlan: subscriptionByPlanResult.rows,
//           byGateway: subscriptionByGatewayResult.rows,
//           trend: subscriptionTrendResult.rows
//         },

//         // Platform Fee Details
//         platformFees: {
//           stats: platformFeeResult.rows[0],
//           byGateway: platformFeeByGatewayResult.rows,
//           trend: platformFeeTrendResult.rows,
//           topElections: topElectionsByFeeResult.rows
//         }
//       }
//     });

//   } catch (error) {
//     console.error('Get platform revenue report error:', error);
//     res.status(500).json({
//       success: false,
//       error: 'Failed to retrieve platform revenue report',
//       details: error.message
//     });
//   }
// }
}

export default new AnalyticsController();
//last workable code only to add revenue report above code
// // src/controllers/analytics.controller.js
// // VOTING-SERVICE (3007) - Platform Analytics Data
// // ONLY uses verified columns from actual database schemas

// import pool from '../config/database.js';

// class AnalyticsController {

//   // ═══════════════════════════════════════════════════════════════════════════
//   // COMPREHENSIVE PLATFORM REPORT
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getComprehensivePlatformReport(req, res) {
//     try {
//       const { period = '30' } = req.query;
//       const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

//       // ─────────────────────────────────────────────────────────────────────────
//       // OVERVIEW STATS (safe queries)
//       // ─────────────────────────────────────────────────────────────────────────
//       const overviewResult = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
//           (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
//           (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE lottery_enabled = true) as lottery_elections,
//           (SELECT COALESCE(SUM(lottery_total_prize_pool), 0) FROM votteryyy_elections WHERE lottery_enabled = true) as total_prize_pool
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // USER STATISTICS (using actual votteryy_user_details columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       const userStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_registered,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as new_users_period,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '7 days') as new_users_week,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '1 day') as new_users_today
//         FROM votteryy_user_details
//       `);

//       const usersByCountryResult = await pool.query(`
//         SELECT country, COUNT(*) as count
//         FROM votteryy_user_details 
//         WHERE country IS NOT NULL
//         GROUP BY country 
//         ORDER BY count DESC 
//         LIMIT 10
//       `);

//       const usersByGenderResult = await pool.query(`
//         SELECT COALESCE(gender, 'Not Specified') as gender, COUNT(*) as count
//         FROM votteryy_user_details 
//         GROUP BY gender
//       `);

//       // Age groups using actual 'age' column (not date_of_birth)
//       const usersByAgeResult = await pool.query(`
//         SELECT 
//           CASE 
//             WHEN age < 18 THEN 'Under 18'
//             WHEN age BETWEEN 18 AND 24 THEN '18-24'
//             WHEN age BETWEEN 25 AND 34 THEN '25-34'
//             WHEN age BETWEEN 35 AND 44 THEN '35-44'
//             WHEN age BETWEEN 45 AND 54 THEN '45-54'
//             WHEN age BETWEEN 55 AND 64 THEN '55-64'
//             WHEN age >= 65 THEN '65+'
//             ELSE 'Unknown'
//           END as age_group,
//           COUNT(*) as count
//         FROM votteryy_user_details
//         WHERE age IS NOT NULL
//         GROUP BY age_group
//       `);

//       const userTrendResult = await pool.query(`
//         SELECT DATE(collected_at) as date, COUNT(*) as count
//         FROM votteryy_user_details
//         WHERE collected_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(collected_at) 
//         ORDER BY date ASC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // ELECTION STATISTICS (using actual votteryyy_elections columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       const electionStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total,
//           -- Status breakdown
//           COUNT(*) FILTER (WHERE status = 'draft') as draft,
//           COUNT(*) FILTER (WHERE status = 'published') as published,
//           COUNT(*) FILTER (WHERE status = 'active') as active,
//           COUNT(*) FILTER (WHERE status = 'completed') as completed,
//           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//           -- Voting type breakdown
//           COUNT(*) FILTER (WHERE voting_type = 'plurality') as plurality,
//           COUNT(*) FILTER (WHERE voting_type = 'ranked_choice') as ranked_choice,
//           COUNT(*) FILTER (WHERE voting_type = 'approval') as approval,
//           -- Pricing breakdown
//           COUNT(*) FILTER (WHERE is_free = true) as free_elections,
//           COUNT(*) FILTER (WHERE is_free = false) as paid_elections,
//           -- Permission type breakdown
//           COUNT(*) FILTER (WHERE permission_type = 'public') as permission_public,
//           COUNT(*) FILTER (WHERE permission_type = 'country_specific') as permission_country_specific,
//           COUNT(*) FILTER (WHERE permission_type = 'specific_group') as permission_specific_group,
//           COUNT(*) FILTER (WHERE permission_type = 'organization_only') as permission_organization_only,
//           -- Creator type breakdown
//           COUNT(*) FILTER (WHERE creator_type = 'individual') as creator_individual,
//           COUNT(*) FILTER (WHERE creator_type = 'organization') as creator_organization,
//           COUNT(*) FILTER (WHERE creator_type = 'content_creator') as creator_content_creator,
//           -- Feature usage
//           COUNT(*) FILTER (WHERE lottery_enabled = true) as lottery_enabled_count,
//           COUNT(*) FILTER (WHERE biometric_required = true) as biometric_required_count,
//           COUNT(*) FILTER (WHERE anonymous_voting_enabled = true) as anonymous_voting_count,
//           COUNT(*) FILTER (WHERE video_watch_required = true) as video_required_count,
//           COUNT(*) FILTER (WHERE show_live_results = true) as live_results_count,
//           COUNT(*) FILTER (WHERE vote_editing_allowed = true) as vote_editing_count,
//           -- Period stats
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_period,
//           -- Aggregates
//           COALESCE(SUM(view_count), 0) as total_views,
//           COALESCE(SUM(vote_count), 0) as total_vote_count,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_lottery_prize_pool
//         FROM votteryyy_elections
//       `);

//       const electionTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryyy_elections
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // VOTE STATISTICS (using actual votteryy_votes columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       const voteStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_votes,
//           COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
//           COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
//           COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
//           COUNT(*) FILTER (WHERE anonymous = true) as anonymous_votes,
//           COUNT(DISTINCT user_id) as unique_voters,
//           COUNT(DISTINCT election_id) as elections_with_votes,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as votes_period,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as votes_week,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as votes_today
//         FROM votteryy_votes
//       `);

//       const voteTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // LOTTERY STATISTICS (using actual votteryy_lottery_draws columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       let lotteryStats = { total_draws: 0, completed_draws: 0, pending_draws: 0, total_participants: 0, total_winner_slots: 0 };
//       try {
//         const lotteryStatsResult = await pool.query(`
//           SELECT
//             COUNT(*) as total_draws,
//             COUNT(*) FILTER (WHERE status = 'completed') as completed_draws,
//             COUNT(*) FILTER (WHERE status = 'pending') as pending_draws,
//             COALESCE(SUM(total_participants), 0) as total_participants,
//             COALESCE(SUM(winner_count), 0) as total_winner_slots
//           FROM votteryy_lottery_draws
//         `);
//         lotteryStats = lotteryStatsResult.rows[0];
//       } catch (e) {
//         console.log('Lottery stats query failed:', e.message);
//       }

//       // Lottery election breakdown by reward type
//       const lotteryBreakdownResult = await pool.query(`
//         SELECT
//           lottery_reward_type,
//           COUNT(*) as count,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool
//         FROM votteryyy_elections
//         WHERE lottery_enabled = true AND lottery_reward_type IS NOT NULL
//         GROUP BY lottery_reward_type
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // SUBSCRIPTION STATISTICS (using actual votteryy_user_subscriptions columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       let subscriptionStats = { total_subscriptions: 0, active: 0, cancelled: 0, expired: 0 };
//       let subscriptionByPlan = [];
//       let subscriptionByGateway = [];
//       try {
//         const subscriptionStatsResult = await pool.query(`
//           SELECT
//             COUNT(*) as total_subscriptions,
//             COUNT(*) FILTER (WHERE status = 'active') as active,
//             COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//             COUNT(*) FILTER (WHERE status = 'expired') as expired,
//             COUNT(*) FILTER (WHERE payment_type = 'recurring') as recurring_count,
//             COUNT(*) FILTER (WHERE payment_type = 'pay_as_you_go') as pay_as_you_go_count,
//             COUNT(*) FILTER (WHERE auto_renew = true) as auto_renew_enabled,
//             COALESCE(SUM(total_usage_amount), 0) as total_usage_amount,
//             COALESCE(SUM(unpaid_usage_amount), 0) as total_unpaid_amount
//           FROM votteryy_user_subscriptions
//         `);
//         subscriptionStats = subscriptionStatsResult.rows[0];

//         const subscriptionByPlanResult = await pool.query(`
//           SELECT plan_id, COUNT(*) as count
//           FROM votteryy_user_subscriptions 
//           WHERE status = 'active' AND plan_id IS NOT NULL
//           GROUP BY plan_id 
//           ORDER BY count DESC
//         `);
//         subscriptionByPlan = subscriptionByPlanResult.rows;

//         const subscriptionByGatewayResult = await pool.query(`
//           SELECT COALESCE(gateway, 'unknown') as gateway, COUNT(*) as count
//           FROM votteryy_user_subscriptions 
//           WHERE status = 'active'
//           GROUP BY gateway
//         `);
//         subscriptionByGateway = subscriptionByGatewayResult.rows;
//       } catch (e) {
//         console.log('Subscription stats query failed:', e.message);
//       }

//       // ─────────────────────────────────────────────────────────────────────────
//       // TOP ELECTIONS
//       // ─────────────────────────────────────────────────────────────────────────
//       const topElectionsResult = await pool.query(`
//         SELECT id, title, status, vote_count, view_count, lottery_enabled, is_free, created_at
//         FROM votteryyy_elections
//         ORDER BY vote_count DESC NULLS LAST
//         LIMIT 10
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // RESPONSE
//       // ─────────────────────────────────────────────────────────────────────────
//       res.json({
//         success: true,
//         data: {
//           period: periodDays,
//           generatedAt: new Date().toISOString(),
//           overview: overviewResult.rows[0],
//           users: {
//             stats: userStatsResult.rows[0],
//             byCountry: usersByCountryResult.rows,
//             byGender: usersByGenderResult.rows,
//             byAge: usersByAgeResult.rows,
//             trend: userTrendResult.rows
//           },
//           elections: {
//             stats: electionStatsResult.rows[0],
//             trend: electionTrendResult.rows,
//             topElections: topElectionsResult.rows
//           },
//           votes: {
//             stats: voteStatsResult.rows[0],
//             trend: voteTrendResult.rows
//           },
//           lottery: {
//             stats: lotteryStats,
//             byRewardType: lotteryBreakdownResult.rows
//           },
//           subscriptions: {
//             stats: subscriptionStats,
//             byPlan: subscriptionByPlan,
//             byGateway: subscriptionByGateway
//           }
//         }
//       });

//     } catch (error) {
//       console.error('Get comprehensive platform report error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve platform report',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // REAL-TIME STATS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getRealTimeStats(req, res) {
//     try {
//       const result = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'published') as published_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '24 hours') as votes_last_24h,
//           (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h,
//           (SELECT COUNT(*) FROM votteryy_lottery_draws WHERE status = 'pending') as pending_lottery_draws
//       `);

//       // Recent votes
//       const recentVotesResult = await pool.query(`
//         SELECT v.id, v.election_id, v.created_at, v.anonymous, e.title as election_title
//         FROM votteryy_votes v
//         JOIN votteryyy_elections e ON v.election_id = e.id
//         WHERE v.status = 'valid'
//         ORDER BY v.created_at DESC 
//         LIMIT 10
//       `);

//       // Active elections
//       const activeElectionsResult = await pool.query(`
//         SELECT 
//           id, title, status, end_date, vote_count, view_count, lottery_enabled, is_free
//         FROM votteryyy_elections
//         WHERE status = 'active'
//         ORDER BY end_date ASC 
//         LIMIT 10
//       `);

//       res.json({
//         success: true,
//         data: {
//           stats: result.rows[0],
//           recentVotes: recentVotesResult.rows,
//           activeElections: activeElectionsResult.rows,
//           timestamp: new Date().toISOString()
//         }
//       });

//     } catch (error) {
//       console.error('Get real-time stats error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve real-time stats',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // REVENUE REPORT (stub - no payment table schema provided)
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getRevenueReport(req, res) {
//     try {
//       // Since votteryy_election_payments schema not provided, return elections revenue data
//       const { dateFrom, dateTo, groupBy = 'day' } = req.query;

//       let dateFilter = '';
//       if (dateFrom && dateTo) {
//         dateFilter = `WHERE created_at BETWEEN '${dateFrom}' AND '${dateTo}'`;
//       } else if (dateFrom) {
//         dateFilter = `WHERE created_at >= '${dateFrom}'`;
//       } else if (dateTo) {
//         dateFilter = `WHERE created_at <= '${dateTo}'`;
//       }

//       let groupFormat;
//       switch (groupBy) {
//         case 'week':
//           groupFormat = "DATE_TRUNC('week', created_at)";
//           break;
//         case 'month':
//           groupFormat = "DATE_TRUNC('month', created_at)";
//           break;
//         default:
//           groupFormat = 'DATE(created_at)';
//       }

//       // Use subscription data for revenue approximation
//       const subscriptionRevenueResult = await pool.query(`
//         SELECT
//           COALESCE(SUM(total_usage_amount), 0) as total_usage_revenue,
//           COALESCE(SUM(unpaid_usage_amount), 0) as pending_revenue,
//           COUNT(*) as total_subscriptions,
//           COUNT(*) FILTER (WHERE status = 'active') as active_subscriptions
//         FROM votteryy_user_subscriptions
//       `);

//       // Election participation fees
//       const electionFeesResult = await pool.query(`
//         SELECT
//           COUNT(*) FILTER (WHERE is_free = false) as paid_elections,
//           COALESCE(SUM(general_participation_fee), 0) as total_participation_fees,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pools
//         FROM votteryyy_elections
//         ${dateFilter}
//       `);

//       res.json({
//         success: true,
//         data: {
//           subscriptions: subscriptionRevenueResult.rows[0],
//           elections: electionFeesResult.rows[0],
//           groupBy,
//           dateRange: { from: dateFrom, to: dateTo },
//           note: 'Revenue data from subscriptions and election fees'
//         }
//       });

//     } catch (error) {
//       console.error('Get revenue report error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve revenue report',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // ELECTION ANALYTICS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getElectionAnalytics(req, res) {
//     try {
//       const { electionId } = req.params;

//       // Election details
//       const electionResult = await pool.query(`
//         SELECT 
//           id, creator_id, creator_type, organization_id,
//           title, description, slug,
//           topic_image_url, topic_video_url, logo_url, video_url,
//           start_date, start_time, end_date, end_time, timezone,
//           voting_type, permission_type, allowed_countries,
//           is_free, pricing_type, general_participation_fee,
//           biometric_required, show_live_results, vote_editing_allowed,
//           status, view_count, vote_count,
//           created_at, updated_at, published_at,
//           video_watch_required, minimum_watch_time, minimum_watch_percentage,
//           lottery_enabled, lottery_reward_type, lottery_total_prize_pool,
//           lottery_winner_count, lottery_draw_date,
//           category_id, anonymous_voting_enabled
//         FROM votteryyy_elections 
//         WHERE id = $1
//       `, [electionId]);

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({
//           success: false,
//           error: 'Election not found'
//         });
//       }

//       // Vote statistics
//       const voteStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_votes,
//           COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
//           COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
//           COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
//           COUNT(*) FILTER (WHERE anonymous = true) as anonymous_votes,
//           COUNT(DISTINCT user_id) as unique_voters,
//           MIN(created_at) as first_vote,
//           MAX(created_at) as last_vote
//         FROM votteryy_votes 
//         WHERE election_id = $1
//       `, [electionId]);

//       // Vote trend
//       const voteTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `, [electionId]);

//       // Hourly distribution
//       const hourlyDistResult = await pool.query(`
//         SELECT EXTRACT(HOUR FROM created_at)::integer as hour, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//         GROUP BY hour 
//         ORDER BY hour ASC
//       `, [electionId]);

//       // Lottery info if enabled
//       let lotteryInfo = null;
//       if (electionResult.rows[0].lottery_enabled) {
//         const lotteryResult = await pool.query(`
//           SELECT id, draw_id, total_participants, winner_count, draw_time, status, created_at
//           FROM votteryy_lottery_draws 
//           WHERE election_id = $1
//         `, [electionId]);
//         lotteryInfo = lotteryResult.rows[0] || null;
//       }

//       res.json({
//         success: true,
//         data: {
//           election: electionResult.rows[0],
//           votes: {
//             stats: voteStatsResult.rows[0],
//             trend: voteTrendResult.rows,
//             hourlyDistribution: hourlyDistResult.rows
//           },
//           lottery: lotteryInfo
//         }
//       });

//     } catch (error) {
//       console.error('Get election analytics error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve election analytics',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // VOTER DEMOGRAPHICS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getVoterDemographics(req, res) {
//     try {
//       const { electionId } = req.params;

//       // Check election exists
//       const electionCheck = await pool.query(`SELECT id FROM votteryyy_elections WHERE id = $1`, [electionId]);
//       if (electionCheck.rows.length === 0) {
//         return res.status(404).json({ success: false, error: 'Election not found' });
//       }

//       // Voters by country
//       const byCountryResult = await pool.query(`
//         SELECT ud.country, COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' AND ud.country IS NOT NULL
//         GROUP BY ud.country 
//         ORDER BY count DESC 
//         LIMIT 15
//       `, [electionId]);

//       // Voters by gender
//       const byGenderResult = await pool.query(`
//         SELECT COALESCE(ud.gender, 'Not Specified') as gender, COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         GROUP BY ud.gender
//       `, [electionId]);

//       // Voters by age group (using age column)
//       const byAgeResult = await pool.query(`
//         SELECT 
//           CASE 
//             WHEN ud.age < 18 THEN 'Under 18'
//             WHEN ud.age BETWEEN 18 AND 24 THEN '18-24'
//             WHEN ud.age BETWEEN 25 AND 34 THEN '25-34'
//             WHEN ud.age BETWEEN 35 AND 44 THEN '35-44'
//             WHEN ud.age BETWEEN 45 AND 54 THEN '45-54'
//             WHEN ud.age BETWEEN 55 AND 64 THEN '55-64'
//             WHEN ud.age >= 65 THEN '65+'
//             ELSE 'Unknown'
//           END as age_group,
//           COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         GROUP BY age_group
//       `, [electionId]);

//       // Total unique voters
//       const totalVotersResult = await pool.query(`
//         SELECT COUNT(DISTINCT user_id) as total
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//       `, [electionId]);

//       // Voters by city
//       const byCityResult = await pool.query(`
//         SELECT ud.city, COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id::integer = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' AND ud.city IS NOT NULL
//         GROUP BY ud.city 
//         ORDER BY count DESC 
//         LIMIT 10
//       `, [electionId]);

//       res.json({
//         success: true,
//         data: {
//           totalVoters: parseInt(totalVotersResult.rows[0]?.total || 0),
//           byCountry: byCountryResult.rows,
//           byGender: byGenderResult.rows,
//           byAgeGroup: byAgeResult.rows,
//           byCity: byCityResult.rows
//         }
//       });

//     } catch (error) {
//       console.error('Get voter demographics error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve voter demographics',
//         details: error.message
//       });
//     }
//   }
// }

// export default new AnalyticsController();
// // src/controllers/analytics.controller.js
// // VOTING-SERVICE (3007) - Platform Analytics Data
// // Matches actual votteryyy_elections schema

// import pool from '../config/database.js';

// class AnalyticsController {

//   // ═══════════════════════════════════════════════════════════════════════════
//   // COMPREHENSIVE PLATFORM REPORT
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getComprehensivePlatformReport(req, res) {
//     try {
//       const { period = '30' } = req.query;
//       const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

//       // ─────────────────────────────────────────────────────────────────────────
//       // OVERVIEW STATS
//       // ─────────────────────────────────────────────────────────────────────────
//       const overviewResult = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
//           (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
//           (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
//           (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE lottery_enabled = true) as lottery_elections,
//           (SELECT COALESCE(SUM(lottery_total_prize_pool), 0) FROM votteryyy_elections WHERE lottery_enabled = true) as total_prize_pool
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // USER STATISTICS
//       // ─────────────────────────────────────────────────────────────────────────
//       const userStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_registered,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as new_users_period,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '7 days') as new_users_week,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '1 day') as new_users_today
//         FROM votteryy_user_details
//       `);

//       const usersByCountryResult = await pool.query(`
//         SELECT country, COUNT(*) as count
//         FROM votteryy_user_details 
//         WHERE country IS NOT NULL
//         GROUP BY country 
//         ORDER BY count DESC 
//         LIMIT 10
//       `);

//       const usersByGenderResult = await pool.query(`
//         SELECT COALESCE(gender, 'Not Specified') as gender, COUNT(*) as count
//         FROM votteryy_user_details 
//         GROUP BY gender
//       `);

//       const userTrendResult = await pool.query(`
//         SELECT DATE(collected_at) as date, COUNT(*) as count
//         FROM votteryy_user_details
//         WHERE collected_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(collected_at) 
//         ORDER BY date ASC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // ELECTION STATISTICS (Using actual schema columns)
//       // ─────────────────────────────────────────────────────────────────────────
//       const electionStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total,
//           -- Status breakdown
//           COUNT(*) FILTER (WHERE status = 'draft') as draft,
//           COUNT(*) FILTER (WHERE status = 'published') as published,
//           COUNT(*) FILTER (WHERE status = 'active') as active,
//           COUNT(*) FILTER (WHERE status = 'completed') as completed,
//           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//           -- Voting type breakdown
//           COUNT(*) FILTER (WHERE voting_type = 'plurality') as plurality,
//           COUNT(*) FILTER (WHERE voting_type = 'ranked_choice') as ranked_choice,
//           COUNT(*) FILTER (WHERE voting_type = 'approval') as approval,
//           -- Pricing breakdown (using is_free column)
//           COUNT(*) FILTER (WHERE is_free = true) as free_elections,
//           COUNT(*) FILTER (WHERE is_free = false) as paid_elections,
//           -- Pricing type breakdown
//           COUNT(*) FILTER (WHERE pricing_type = 'free') as pricing_free,
//           COUNT(*) FILTER (WHERE pricing_type = 'general_fee') as pricing_general_fee,
//           COUNT(*) FILTER (WHERE pricing_type = 'regional_fee') as pricing_regional_fee,
//           -- Permission type breakdown
//           COUNT(*) FILTER (WHERE permission_type = 'public') as permission_public,
//           COUNT(*) FILTER (WHERE permission_type = 'country_specific') as permission_country_specific,
//           COUNT(*) FILTER (WHERE permission_type = 'specific_group') as permission_specific_group,
//           COUNT(*) FILTER (WHERE permission_type = 'organization_only') as permission_organization_only,
//           -- Creator type breakdown
//           COUNT(*) FILTER (WHERE creator_type = 'individual') as creator_individual,
//           COUNT(*) FILTER (WHERE creator_type = 'organization') as creator_organization,
//           COUNT(*) FILTER (WHERE creator_type = 'content_creator') as creator_content_creator,
//           -- Feature usage
//           COUNT(*) FILTER (WHERE lottery_enabled = true) as lottery_enabled,
//           COUNT(*) FILTER (WHERE biometric_required = true) as biometric_required,
//           COUNT(*) FILTER (WHERE anonymous_voting_enabled = true) as anonymous_voting,
//           COUNT(*) FILTER (WHERE video_watch_required = true) as video_required,
//           COUNT(*) FILTER (WHERE show_live_results = true) as live_results_enabled,
//           COUNT(*) FILTER (WHERE vote_editing_allowed = true) as vote_editing_enabled,
//           -- Period stats
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_period,
//           -- Aggregates
//           COALESCE(SUM(view_count), 0) as total_views,
//           COALESCE(SUM(vote_count), 0) as total_vote_count,
//           COALESCE(SUM(general_participation_fee), 0) as total_participation_fees,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_lottery_prize_pool
//         FROM votteryyy_elections
//       `);

//       const electionTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryyy_elections
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `);

//       // Elections by category
//       const electionsByCategoryResult = await pool.query(`
//         SELECT category_id, COUNT(*) as count
//         FROM votteryyy_elections 
//         WHERE category_id IS NOT NULL
//         GROUP BY category_id 
//         ORDER BY count DESC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // VOTE STATISTICS
//       // ─────────────────────────────────────────────────────────────────────────
//       const voteStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_votes,
//           COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
//           COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
//           COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
//           COUNT(DISTINCT user_id) as unique_voters,
//           COUNT(DISTINCT election_id) as elections_with_votes,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as votes_period,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as votes_week,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as votes_today
//         FROM votteryy_votes
//       `);

//       const voteTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `);

//       // Abstentions count
//       let abstentionCount = 0;
//       try {
//         const abstentionResult = await pool.query(`SELECT COUNT(*) as total FROM votteryy_abstentions`);
//         abstentionCount = parseInt(abstentionResult.rows[0]?.total || 0);
//       } catch (e) {
//         // Table might not exist
//         abstentionCount = 0;
//       }

//       // ─────────────────────────────────────────────────────────────────────────
//       // REVENUE STATISTICS
//       // ─────────────────────────────────────────────────────────────────────────
//       const revenueStatsResult = await pool.query(`
//         SELECT
//           COALESCE(SUM(amount), 0) as total_revenue,
//           COALESCE(SUM(platform_fee), 0) as total_platform_fees,
//           COALESCE(SUM(stripe_fee), 0) as total_stripe_fees,
//           COALESCE(SUM(creator_amount), 0) as total_creator_earnings,
//           COUNT(*) as total_transactions,
//           COUNT(*) FILTER (WHERE status = 'succeeded') as successful_transactions,
//           COUNT(*) FILTER (WHERE status = 'failed') as failed_transactions,
//           COUNT(*) FILTER (WHERE status = 'pending') as pending_transactions,
//           COALESCE(AVG(amount), 0) as avg_transaction_amount,
//           COALESCE(MAX(amount), 0) as max_transaction_amount
//         FROM votteryy_election_payments
//       `);

//       const revenueTrendResult = await pool.query(`
//         SELECT 
//           DATE(created_at) as date, 
//           COALESCE(SUM(amount), 0) as revenue,
//           COALESCE(SUM(platform_fee), 0) as platform_fees,
//           COUNT(*) as transactions
//         FROM votteryy_election_payments
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'succeeded'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // LOTTERY STATISTICS
//       // ─────────────────────────────────────────────────────────────────────────
//       let lotteryStats = { total_draws: 0, completed_draws: 0, pending_draws: 0, total_prize_distributed: 0, total_winners: 0 };
//       try {
//         const lotteryStatsResult = await pool.query(`
//           SELECT
//             COUNT(*) as total_draws,
//             COUNT(*) FILTER (WHERE status = 'completed') as completed_draws,
//             COUNT(*) FILTER (WHERE status = 'pending') as pending_draws,
//             COALESCE(SUM(total_prize_pool), 0) as total_prize_distributed,
//             COALESCE(SUM(total_winners), 0) as total_winners
//           FROM votteryy_lottery_draws
//         `);
//         lotteryStats = lotteryStatsResult.rows[0];
//       } catch (e) {
//         // Table might not exist
//       }

//       // Lottery election breakdown
//       const lotteryBreakdownResult = await pool.query(`
//         SELECT
//           lottery_reward_type,
//           COUNT(*) as count,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool
//         FROM votteryyy_elections
//         WHERE lottery_enabled = true AND lottery_reward_type IS NOT NULL
//         GROUP BY lottery_reward_type
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // SUBSCRIPTION STATISTICS
//       // ─────────────────────────────────────────────────────────────────────────
//       let subscriptionStats = { total_subscriptions: 0, active: 0, cancelled: 0, expired: 0 };
//       let subscriptionByPlan = [];
//       try {
//         const subscriptionStatsResult = await pool.query(`
//           SELECT
//             COUNT(*) as total_subscriptions,
//             COUNT(*) FILTER (WHERE status = 'active') as active,
//             COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//             COUNT(*) FILTER (WHERE status = 'expired') as expired
//           FROM votteryy_user_subscriptions
//         `);
//         subscriptionStats = subscriptionStatsResult.rows[0];

//         const subscriptionByPlanResult = await pool.query(`
//           SELECT plan_id, COUNT(*) as count
//           FROM votteryy_user_subscriptions 
//           WHERE status = 'active'
//           GROUP BY plan_id 
//           ORDER BY count DESC
//         `);
//         subscriptionByPlan = subscriptionByPlanResult.rows;
//       } catch (e) {
//         // Tables might not exist
//       }

//       // ─────────────────────────────────────────────────────────────────────────
//       // TOP ELECTIONS
//       // ─────────────────────────────────────────────────────────────────────────
//       const topElectionsResult = await pool.query(`
//         SELECT id, title, status, vote_count, view_count, lottery_enabled, is_free
//         FROM votteryyy_elections
//         ORDER BY vote_count DESC
//         LIMIT 10
//       `);

//       // ─────────────────────────────────────────────────────────────────────────
//       // RESPONSE
//       // ─────────────────────────────────────────────────────────────────────────
//       res.json({
//         success: true,
//         data: {
//           period: periodDays,
//           generatedAt: new Date().toISOString(),
//           overview: overviewResult.rows[0],
//           users: {
//             stats: userStatsResult.rows[0],
//             byCountry: usersByCountryResult.rows,
//             byGender: usersByGenderResult.rows,
//             trend: userTrendResult.rows
//           },
//           elections: {
//             stats: electionStatsResult.rows[0],
//             trend: electionTrendResult.rows,
//             byCategory: electionsByCategoryResult.rows,
//             topElections: topElectionsResult.rows
//           },
//           votes: {
//             stats: voteStatsResult.rows[0],
//             trend: voteTrendResult.rows,
//             abstentions: abstentionCount
//           },
//           revenue: {
//             stats: revenueStatsResult.rows[0],
//             trend: revenueTrendResult.rows
//           },
//           lottery: {
//             stats: lotteryStats,
//             byRewardType: lotteryBreakdownResult.rows
//           },
//           subscriptions: {
//             stats: subscriptionStats,
//             byPlan: subscriptionByPlan
//           }
//         }
//       });

//     } catch (error) {
//       console.error('Get comprehensive platform report error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve platform report',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // REVENUE REPORT
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getRevenueReport(req, res) {
//     try {
//       const { dateFrom, dateTo, groupBy = 'day' } = req.query;

//       let dateFilter = '';
//       const params = [];
//       let paramIndex = 1;

//       if (dateFrom && dateTo) {
//         dateFilter = `WHERE created_at BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
//         params.push(dateFrom, dateTo);
//         paramIndex += 2;
//       } else if (dateFrom) {
//         dateFilter = `WHERE created_at >= $${paramIndex}`;
//         params.push(dateFrom);
//         paramIndex++;
//       } else if (dateTo) {
//         dateFilter = `WHERE created_at <= $${paramIndex}`;
//         params.push(dateTo);
//         paramIndex++;
//       }

//       let groupFormat;
//       switch (groupBy) {
//         case 'week':
//           groupFormat = "DATE_TRUNC('week', created_at)";
//           break;
//         case 'month':
//           groupFormat = "DATE_TRUNC('month', created_at)";
//           break;
//         default:
//           groupFormat = 'DATE(created_at)';
//       }

//       const revenueQuery = `
//         SELECT 
//           ${groupFormat} as period,
//           COALESCE(SUM(amount), 0) as total_revenue,
//           COALESCE(SUM(platform_fee), 0) as platform_fees,
//           COALESCE(SUM(stripe_fee), 0) as stripe_fees,
//           COALESCE(SUM(creator_amount), 0) as creator_earnings,
//           COUNT(*) as transaction_count,
//           COUNT(*) FILTER (WHERE status = 'succeeded') as successful,
//           COUNT(*) FILTER (WHERE status = 'failed') as failed
//         FROM votteryy_election_payments
//         ${dateFilter}
//         GROUP BY ${groupFormat}
//         ORDER BY period ASC
//       `;

//       const revenueResult = await pool.query(revenueQuery, params);

//       const summaryQuery = `
//         SELECT
//           COALESCE(SUM(amount), 0) as total_revenue,
//           COALESCE(SUM(platform_fee), 0) as total_platform_fees,
//           COALESCE(SUM(stripe_fee), 0) as total_stripe_fees,
//           COALESCE(SUM(creator_amount), 0) as total_creator_earnings,
//           COUNT(*) as total_transactions,
//           COALESCE(AVG(amount), 0) as avg_transaction
//         FROM votteryy_election_payments
//         ${dateFilter ? dateFilter + ' AND status = \'succeeded\'' : 'WHERE status = \'succeeded\''}
//       `;

//       const summaryResult = await pool.query(summaryQuery, params);

//       res.json({
//         success: true,
//         data: {
//           summary: summaryResult.rows[0],
//           breakdown: revenueResult.rows,
//           groupBy,
//           dateRange: { from: dateFrom, to: dateTo }
//         }
//       });

//     } catch (error) {
//       console.error('Get revenue report error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve revenue report',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // REAL-TIME STATS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getRealTimeStats(req, res) {
//     try {
//       const result = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'published') as published_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '24 hours') as votes_last_24h,
//           (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE created_at >= NOW() - INTERVAL '24 hours' AND status = 'succeeded') as revenue_24h,
//           (SELECT COUNT(*) FROM votteryy_lottery_draws WHERE status = 'pending') as pending_lottery_draws
//       `);

//       // Recent votes (last 10)
//       const recentVotesResult = await pool.query(`
//         SELECT v.id, v.election_id, v.created_at, e.title as election_title
//         FROM votteryy_votes v
//         JOIN votteryyy_elections e ON v.election_id = e.id
//         WHERE v.status = 'valid'
//         ORDER BY v.created_at DESC 
//         LIMIT 10
//       `);

//       // Active elections with vote counts
//       const activeElectionsResult = await pool.query(`
//         SELECT 
//           id, 
//           title, 
//           status, 
//           end_date,
//           vote_count,
//           view_count,
//           lottery_enabled,
//           is_free
//         FROM votteryyy_elections
//         WHERE status = 'active'
//         ORDER BY end_date ASC 
//         LIMIT 10
//       `);

//       // Recent payments
//       const recentPaymentsResult = await pool.query(`
//         SELECT id, election_id, amount, platform_fee, status, created_at
//         FROM votteryy_election_payments
//         ORDER BY created_at DESC
//         LIMIT 5
//       `);

//       res.json({
//         success: true,
//         data: {
//           stats: result.rows[0],
//           recentVotes: recentVotesResult.rows,
//           activeElections: activeElectionsResult.rows,
//           recentPayments: recentPaymentsResult.rows,
//           timestamp: new Date().toISOString()
//         }
//       });

//     } catch (error) {
//       console.error('Get real-time stats error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve real-time stats',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // ELECTION ANALYTICS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getElectionAnalytics(req, res) {
//     try {
//       const { electionId } = req.params;

//       // Election details (all columns from schema)
//       const electionResult = await pool.query(`
//         SELECT 
//           id, creator_id, creator_type, organization_id,
//           title, description, slug,
//           topic_image_url, topic_video_url, logo_url, video_url,
//           start_date, start_time, end_date, end_time, timezone,
//           voting_type, voting_body_content,
//           permission_type, allowed_countries,
//           is_free, pricing_type, general_participation_fee, processing_fee_percentage,
//           biometric_required, authentication_methods,
//           custom_url, corporate_style,
//           show_live_results, vote_editing_allowed,
//           status, subscription_plan_id,
//           view_count, vote_count,
//           created_at, updated_at, published_at,
//           video_watch_required, required_watch_duration_minutes, minimum_watch_time, minimum_watch_percentage,
//           lottery_enabled, lottery_prize_funding_source, lottery_reward_type,
//           lottery_total_prize_pool, lottery_prize_description, lottery_estimated_value,
//           lottery_projected_revenue, lottery_revenue_share_percentage,
//           lottery_winner_count, lottery_prize_distribution, lottery_draw_date,
//           category_id, anonymous_voting_enabled, prize_pool
//         FROM votteryyy_elections 
//         WHERE id = $1
//       `, [electionId]);

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({
//           success: false,
//           error: 'Election not found'
//         });
//       }

//       // Vote statistics
//       const voteStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_votes,
//           COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
//           COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
//           COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
//           COUNT(DISTINCT user_id) as unique_voters,
//           MIN(created_at) as first_vote,
//           MAX(created_at) as last_vote
//         FROM votteryy_votes 
//         WHERE election_id = $1
//       `, [electionId]);

//       // Vote trend over time
//       const voteTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//         GROUP BY DATE(created_at) 
//         ORDER BY date ASC
//       `, [electionId]);

//       // Hourly distribution
//       const hourlyDistResult = await pool.query(`
//         SELECT EXTRACT(HOUR FROM created_at)::integer as hour, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//         GROUP BY hour 
//         ORDER BY hour ASC
//       `, [electionId]);

//       // Payment stats
//       const paymentStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_payments,
//           COALESCE(SUM(amount), 0) as total_amount,
//           COALESCE(SUM(platform_fee), 0) as platform_fees,
//           COALESCE(SUM(creator_amount), 0) as creator_earnings,
//           COUNT(*) FILTER (WHERE status = 'succeeded') as successful_payments,
//           COUNT(*) FILTER (WHERE status = 'failed') as failed_payments
//         FROM votteryy_election_payments
//         WHERE election_id = $1
//       `, [electionId]);

//       // Lottery info if enabled
//       let lotteryInfo = null;
//       if (electionResult.rows[0].lottery_enabled) {
//         const lotteryResult = await pool.query(`
//           SELECT * FROM votteryy_lottery_draws WHERE election_id = $1
//         `, [electionId]);
//         lotteryInfo = lotteryResult.rows[0] || null;
//       }

//       res.json({
//         success: true,
//         data: {
//           election: electionResult.rows[0],
//           votes: {
//             stats: voteStatsResult.rows[0],
//             trend: voteTrendResult.rows,
//             hourlyDistribution: hourlyDistResult.rows
//           },
//           payments: paymentStatsResult.rows[0],
//           lottery: lotteryInfo
//         }
//       });

//     } catch (error) {
//       console.error('Get election analytics error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve election analytics',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // VOTER DEMOGRAPHICS
//   // ═══════════════════════════════════════════════════════════════════════════
//   async getVoterDemographics(req, res) {
//     try {
//       const { electionId } = req.params;

//       // Check election exists
//       const electionCheck = await pool.query(`SELECT id FROM votteryyy_elections WHERE id = $1`, [electionId]);
//       if (electionCheck.rows.length === 0) {
//         return res.status(404).json({ success: false, error: 'Election not found' });
//       }

//       // Voters by country
//       const byCountryResult = await pool.query(`
//         SELECT ud.country, COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' AND ud.country IS NOT NULL
//         GROUP BY ud.country 
//         ORDER BY count DESC 
//         LIMIT 15
//       `, [electionId]);

//       // Voters by gender
//       const byGenderResult = await pool.query(`
//         SELECT COALESCE(ud.gender, 'Not Specified') as gender, COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         GROUP BY ud.gender
//       `, [electionId]);

//       // Voters by age group
//       const byAgeResult = await pool.query(`
//         SELECT 
//           CASE 
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) < 18 THEN 'Under 18'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 18 AND 24 THEN '18-24'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 25 AND 34 THEN '25-34'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 35 AND 44 THEN '35-44'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 45 AND 54 THEN '45-54'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 55 AND 64 THEN '55-64'
//             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) >= 65 THEN '65+'
//             ELSE 'Unknown'
//           END as age_group,
//           COUNT(DISTINCT v.user_id) as count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         GROUP BY age_group 
//         ORDER BY 
//           CASE age_group
//             WHEN 'Under 18' THEN 1
//             WHEN '18-24' THEN 2
//             WHEN '25-34' THEN 3
//             WHEN '35-44' THEN 4
//             WHEN '45-54' THEN 5
//             WHEN '55-64' THEN 6
//             WHEN '65+' THEN 7
//             ELSE 8
//           END
//       `, [electionId]);

//       // Total unique voters
//       const totalVotersResult = await pool.query(`
//         SELECT COUNT(DISTINCT user_id) as total
//         FROM votteryy_votes
//         WHERE election_id = $1 AND status = 'valid'
//       `, [electionId]);

//       res.json({
//         success: true,
//         data: {
//           totalVoters: parseInt(totalVotersResult.rows[0]?.total || 0),
//           byCountry: byCountryResult.rows,
//           byGender: byGenderResult.rows,
//           byAgeGroup: byAgeResult.rows
//         }
//       });

//     } catch (error) {
//       console.error('Get voter demographics error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to retrieve voter demographics',
//         details: error.message
//       });
//     }
//   }

//   // ═══════════════════════════════════════════════════════════════════════════
//   // EXPORT ANALYTICS DATA
//   // ═══════════════════════════════════════════════════════════════════════════
//   async exportAnalyticsData(req, res) {
//     try {
//       const { type = 'elections', format = 'json' } = req.query;

//       let data;
//       switch (type) {
//         case 'elections':
//           const electionsResult = await pool.query(`
//             SELECT 
//               id, title, status, voting_type, permission_type,
//               is_free, pricing_type, general_participation_fee,
//               vote_count, view_count, lottery_enabled,
//               created_at, start_date, end_date
//             FROM votteryyy_elections
//             ORDER BY created_at DESC
//           `);
//           data = electionsResult.rows;
//           break;

//         case 'votes':
//           const votesResult = await pool.query(`
//             SELECT 
//               v.id, v.election_id, e.title as election_title,
//               v.status, v.is_edited, v.created_at
//             FROM votteryy_votes v
//             JOIN votteryyy_elections e ON v.election_id = e.id
//             ORDER BY v.created_at DESC
//             LIMIT 10000
//           `);
//           data = votesResult.rows;
//           break;

//         case 'revenue':
//           const revenueResult = await pool.query(`
//             SELECT 
//               id, election_id, amount, platform_fee, stripe_fee,
//               creator_amount, status, created_at
//             FROM votteryy_election_payments
//             ORDER BY created_at DESC
//           `);
//           data = revenueResult.rows;
//           break;

//         default:
//           return res.status(400).json({ success: false, error: 'Invalid export type' });
//       }

//       if (format === 'csv') {
//         // Convert to CSV
//         if (data.length === 0) {
//           return res.status(200).send('No data to export');
//         }
//         const headers = Object.keys(data[0]).join(',');
//         const rows = data.map(row => Object.values(row).map(v => `"${v}"`).join(','));
//         const csv = [headers, ...rows].join('\n');

//         res.setHeader('Content-Type', 'text/csv');
//         res.setHeader('Content-Disposition', `attachment; filename=${type}_export_${Date.now()}.csv`);
//         return res.send(csv);
//       }

//       res.json({ success: true, data, count: data.length });

//     } catch (error) {
//       console.error('Export analytics data error:', error);
//       res.status(500).json({
//         success: false,
//         error: 'Failed to export data',
//         details: error.message
//       });
//     }
//   }
// }

// export default new AnalyticsController();
// // src/controllers/analytics.controller.js
// // VOTING-SERVICE (3007) - Platform analytics data

// import pool from '../config/database.js';

// class AnalyticsController {

//   async getComprehensivePlatformReport(req, res) {
//     try {
//       const { period = '30' } = req.query;
//       const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

//       const overviewResult = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
//           (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
//           (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
//           (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE lottery_enabled = true) as lottery_elections,
//           (SELECT COALESCE(SUM(lottery_total_prize_pool), 0) FROM votteryyy_elections WHERE lottery_enabled = true) as total_prize_pool
//       `);

//       const userStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_registered,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as new_users_period,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '7 days') as new_users_week,
//           COUNT(*) FILTER (WHERE collected_at >= NOW() - INTERVAL '1 day') as new_users_today
//         FROM votteryy_user_details
//       `);

//       const usersByCountryResult = await pool.query(`
//         SELECT country, COUNT(*) as count
//         FROM votteryy_user_details WHERE country IS NOT NULL
//         GROUP BY country ORDER BY count DESC LIMIT 10
//       `);

//       const usersByGenderResult = await pool.query(`
//         SELECT COALESCE(gender, 'Not Specified') as gender, COUNT(*) as count
//         FROM votteryy_user_details GROUP BY gender
//       `);

//       const userTrendResult = await pool.query(`
//         SELECT DATE(collected_at) as date, COUNT(*) as count
//         FROM votteryy_user_details
//         WHERE collected_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(collected_at) ORDER BY date ASC
//       `);

//       const electionStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total,
//           COUNT(*) FILTER (WHERE status = 'draft') as draft,
//           COUNT(*) FILTER (WHERE status = 'active') as active,
//           COUNT(*) FILTER (WHERE status = 'completed') as completed,
//           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//           COUNT(*) FILTER (WHERE voting_type = 'plurality') as plurality,
//           COUNT(*) FILTER (WHERE voting_type = 'ranked_choice') as ranked_choice,
//           COUNT(*) FILTER (WHERE voting_type = 'approval') as approval,
//           COUNT(*) FILTER (WHERE is_paid = true) as paid_elections,
//           COUNT(*) FILTER (WHERE is_paid = false OR is_paid IS NULL) as free_elections,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_period
//         FROM votteryyy_elections
//       `);

//       const electionTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryyy_elections
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(created_at) ORDER BY date ASC
//       `);

//       const voteStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_votes,
//           COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
//           COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
//           COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
//           COUNT(DISTINCT user_id) as unique_voters,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as votes_period,
//           COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as votes_today
//         FROM votteryy_votes
//       `);

//       const voteTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COUNT(*) as count
//         FROM votteryy_votes
//         WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid'
//         GROUP BY DATE(created_at) ORDER BY date ASC
//       `);

//       const abstentionResult = await pool.query(`SELECT COUNT(*) as total FROM votteryy_abstentions`);

//       const revenueStatsResult = await pool.query(`
//         SELECT
//           COALESCE(SUM(amount), 0) as total_revenue,
//           COALESCE(SUM(platform_fee), 0) as total_platform_fees,
//           COALESCE(SUM(stripe_fee), 0) as total_stripe_fees,
//           COALESCE(SUM(paddle_fee), 0) as total_paddle_fees,
//           COALESCE(SUM(net_amount), 0) as total_net_to_creators,
//           COUNT(*) as total_transactions,
//           COUNT(*) FILTER (WHERE gateway_used = 'stripe') as stripe_transactions,
//           COUNT(*) FILTER (WHERE gateway_used = 'paddle') as paddle_transactions,
//           COALESCE(SUM(amount) FILTER (WHERE gateway_used = 'stripe'), 0) as stripe_revenue,
//           COALESCE(SUM(amount) FILTER (WHERE gateway_used = 'paddle'), 0) as paddle_revenue,
//           COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days'), 0) as revenue_period,
//           COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) as revenue_today,
//           COALESCE(AVG(amount), 0) as avg_transaction_amount
//         FROM votteryy_election_payments WHERE status = 'succeeded'
//       `);

//       const revenueByGatewayResult = await pool.query(`
//         SELECT COALESCE(gateway_used, 'unknown') as gateway, COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
//         FROM votteryy_election_payments WHERE status = 'succeeded'
//         GROUP BY gateway_used
//       `);

//       const revenueTrendResult = await pool.query(`
//         SELECT DATE(created_at) as date, COALESCE(SUM(amount), 0) as revenue, 
//                COALESCE(SUM(platform_fee), 0) as platform_fees, COUNT(*) as transactions
//         FROM votteryy_election_payments
//         WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '${periodDays} days'
//         GROUP BY DATE(created_at) ORDER BY date ASC
//       `);

//       const revenueByRegionResult = await pool.query(`
//         SELECT COALESCE(region_code, 'unknown') as region, COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
//         FROM votteryy_election_payments WHERE status = 'succeeded'
//         GROUP BY region_code ORDER BY amount DESC LIMIT 10
//       `);

//       const subscriptionStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_subscriptions,
//           COUNT(*) FILTER (WHERE status = 'active') as active,
//           COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
//           COUNT(*) FILTER (WHERE gateway_used = 'stripe' OR gateway = 'stripe') as stripe_subs,
//           COUNT(*) FILTER (WHERE gateway_used = 'paddle' OR gateway = 'paddle') as paddle_subs,
//           COUNT(*) FILTER (WHERE payment_type = 'recurring') as recurring,
//           COUNT(*) FILTER (WHERE payment_type = 'one_time') as one_time,
//           COUNT(*) FILTER (WHERE payment_type = 'pay_as_you_go') as pay_as_you_go
//         FROM votteryy_user_subscriptions
//       `);

//       const subscriptionsByPlanResult = await pool.query(`
//         SELECT sp.plan_name, sp.plan_type, COUNT(us.id) as count, sp.price
//         FROM votteryy_user_subscriptions us
//         JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//         WHERE us.status = 'active'
//         GROUP BY sp.id, sp.plan_name, sp.plan_type, sp.price ORDER BY count DESC
//       `);

//       const walletStatsResult = await pool.query(`
//         SELECT
//           COALESCE(SUM(balance), 0) as total_available_balance,
//           COALESCE(SUM(blocked_balance), 0) as total_blocked_balance,
//           COUNT(*) as total_wallets
//         FROM votteryy_wallets
//       `);

//       const transactionTypesResult = await pool.query(`
//         SELECT transaction_type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount
//         FROM votteryy_transactions WHERE status = 'success'
//         GROUP BY transaction_type ORDER BY total_amount DESC
//       `);

//       const lotteryStatsResult = await pool.query(`
//         SELECT
//           COUNT(*) as total_lottery_elections,
//           COUNT(*) FILTER (WHERE status = 'active') as active_lotteries,
//           COUNT(*) FILTER (WHERE status = 'completed') as completed_lotteries,
//           COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool,
//           COALESCE(AVG(lottery_total_prize_pool), 0) as avg_prize_pool
//         FROM votteryyy_elections WHERE lottery_enabled = true
//       `);

//       const growthResult = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as users_current,
//           (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '${periodDays * 2} days' AND collected_at < NOW() - INTERVAL '${periodDays} days') as users_previous,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as elections_current,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days') as elections_previous,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid') as votes_current,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days' AND status = 'valid') as votes_previous,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'succeeded') as revenue_current,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days' AND status = 'succeeded') as revenue_previous
//       `);

//       const calculateGrowth = (current, previous) => {
//         const curr = parseFloat(current) || 0;
//         const prev = parseFloat(previous) || 0;
//         if (prev === 0) return curr > 0 ? 100 : 0;
//         return ((curr - prev) / prev * 100).toFixed(2);
//       };

//       const topElectionsResult = await pool.query(`
//         SELECT e.id, e.title, e.status, COUNT(v.id) as vote_count, e.view_count
//         FROM votteryyy_elections e
//         LEFT JOIN votteryy_votes v ON e.id = v.election_id AND v.status = 'valid'
//         GROUP BY e.id ORDER BY vote_count DESC LIMIT 5
//       `);

//       const topRevenueElectionsResult = await pool.query(`
//         SELECT e.id, e.title, COALESCE(SUM(p.amount), 0) as total_revenue, COUNT(p.id) as payment_count
//         FROM votteryyy_elections e
//         JOIN votteryy_election_payments p ON e.id = p.election_id AND p.status = 'succeeded'
//         GROUP BY e.id, e.title ORDER BY total_revenue DESC LIMIT 5
//       `);

//       const overview = overviewResult.rows[0];
//       const userStats = userStatsResult.rows[0];
//       const electionStats = electionStatsResult.rows[0];
//       const voteStats = voteStatsResult.rows[0];
//       const revenueStats = revenueStatsResult.rows[0];
//       const subscriptionStats = subscriptionStatsResult.rows[0];
//       const walletStats = walletStatsResult.rows[0];
//       const lotteryStats = lotteryStatsResult.rows[0];
//       const growth = growthResult.rows[0];

//       res.json({
//         success: true,
//         generatedAt: new Date().toISOString(),
//         period: `${periodDays} days`,
        
//         overview: {
//           totalUsers: parseInt(overview.total_users),
//           totalElections: parseInt(overview.total_elections),
//           totalVotes: parseInt(overview.total_votes),
//           totalRevenue: parseFloat(overview.total_revenue),
//           totalPlatformFees: parseFloat(overview.total_platform_fees),
//           activeSubscriptions: parseInt(overview.active_subscriptions),
//           lotteryElections: parseInt(overview.lottery_elections),
//           totalPrizePool: parseFloat(overview.total_prize_pool)
//         },

//         users: {
//           total: parseInt(userStats.total_registered),
//           newThisPeriod: parseInt(userStats.new_users_period),
//           newThisWeek: parseInt(userStats.new_users_week),
//           newToday: parseInt(userStats.new_users_today),
//           byCountry: usersByCountryResult.rows,
//           byGender: usersByGenderResult.rows,
//           trend: userTrendResult.rows
//         },

//         elections: {
//           total: parseInt(electionStats.total),
//           byStatus: {
//             draft: parseInt(electionStats.draft),
//             active: parseInt(electionStats.active),
//             completed: parseInt(electionStats.completed),
//             cancelled: parseInt(electionStats.cancelled)
//           },
//           byType: {
//             plurality: parseInt(electionStats.plurality),
//             rankedChoice: parseInt(electionStats.ranked_choice),
//             approval: parseInt(electionStats.approval)
//           },
//           paidVsFree: {
//             paid: parseInt(electionStats.paid_elections),
//             free: parseInt(electionStats.free_elections)
//           },
//           newThisPeriod: parseInt(electionStats.new_period),
//           trend: electionTrendResult.rows
//         },

//         votes: {
//           total: parseInt(voteStats.total_votes),
//           valid: parseInt(voteStats.valid_votes),
//           invalid: parseInt(voteStats.invalid_votes),
//           edited: parseInt(voteStats.edited_votes),
//           uniqueVoters: parseInt(voteStats.unique_voters),
//           abstentions: parseInt(abstentionResult.rows[0].total),
//           thisPeriod: parseInt(voteStats.votes_period),
//           today: parseInt(voteStats.votes_today),
//           trend: voteTrendResult.rows
//         },

//         revenue: {
//           total: parseFloat(revenueStats.total_revenue),
//           platformFees: parseFloat(revenueStats.total_platform_fees),
//           stripeFees: parseFloat(revenueStats.total_stripe_fees),
//           paddleFees: parseFloat(revenueStats.total_paddle_fees),
//           netToCreators: parseFloat(revenueStats.total_net_to_creators),
//           totalTransactions: parseInt(revenueStats.total_transactions),
//           avgTransactionAmount: parseFloat(revenueStats.avg_transaction_amount),
//           byGateway: {
//             stripe: { amount: parseFloat(revenueStats.stripe_revenue), count: parseInt(revenueStats.stripe_transactions) },
//             paddle: { amount: parseFloat(revenueStats.paddle_revenue), count: parseInt(revenueStats.paddle_transactions) }
//           },
//           byGatewayChart: revenueByGatewayResult.rows,
//           byRegion: revenueByRegionResult.rows,
//           thisPeriod: parseFloat(revenueStats.revenue_period),
//           today: parseFloat(revenueStats.revenue_today),
//           trend: revenueTrendResult.rows
//         },

//         subscriptions: {
//           total: parseInt(subscriptionStats.total_subscriptions),
//           active: parseInt(subscriptionStats.active),
//           cancelled: parseInt(subscriptionStats.cancelled),
//           byGateway: { stripe: parseInt(subscriptionStats.stripe_subs), paddle: parseInt(subscriptionStats.paddle_subs) },
//           byPaymentType: {
//             recurring: parseInt(subscriptionStats.recurring),
//             oneTime: parseInt(subscriptionStats.one_time),
//             payAsYouGo: parseInt(subscriptionStats.pay_as_you_go)
//           },
//           byPlan: subscriptionsByPlanResult.rows
//         },

//         wallets: {
//           totalAvailableBalance: parseFloat(walletStats.total_available_balance),
//           totalBlockedBalance: parseFloat(walletStats.total_blocked_balance),
//           totalWallets: parseInt(walletStats.total_wallets),
//           transactionTypes: transactionTypesResult.rows
//         },

//         lottery: {
//           totalElections: parseInt(lotteryStats.total_lottery_elections),
//           active: parseInt(lotteryStats.active_lotteries),
//           completed: parseInt(lotteryStats.completed_lotteries),
//           totalPrizePool: parseFloat(lotteryStats.total_prize_pool),
//           avgPrizePool: parseFloat(lotteryStats.avg_prize_pool)
//         },

//         growth: {
//           users: { current: parseInt(growth.users_current), previous: parseInt(growth.users_previous), percentage: parseFloat(calculateGrowth(growth.users_current, growth.users_previous)) },
//           elections: { current: parseInt(growth.elections_current), previous: parseInt(growth.elections_previous), percentage: parseFloat(calculateGrowth(growth.elections_current, growth.elections_previous)) },
//           votes: { current: parseInt(growth.votes_current), previous: parseInt(growth.votes_previous), percentage: parseFloat(calculateGrowth(growth.votes_current, growth.votes_previous)) },
//           revenue: { current: parseFloat(growth.revenue_current), previous: parseFloat(growth.revenue_previous), percentage: parseFloat(calculateGrowth(growth.revenue_current, growth.revenue_previous)) }
//         },

//         topPerformers: {
//           electionsByVotes: topElectionsResult.rows,
//           electionsByRevenue: topRevenueElectionsResult.rows
//         }
//       });

//     } catch (error) {
//       console.error('Get comprehensive platform report error:', error);
//       res.status(500).json({ success: false, error: 'Failed to retrieve platform report', details: error.message });
//     }
//   }

//   async getRevenueReport(req, res) {
//     try {
//       const { dateFrom, dateTo, groupBy = 'day' } = req.query;

//       let dateFilter = '';
//       const params = [];
      
//       if (dateFrom) { params.push(dateFrom); dateFilter += ` AND created_at >= $${params.length}`; }
//       if (dateTo) { params.push(dateTo); dateFilter += ` AND created_at <= $${params.length}`; }

//       const summaryResult = await pool.query(`
//         SELECT
//           COALESCE(SUM(amount), 0) as gross_revenue,
//           COALESCE(SUM(platform_fee), 0) as platform_fees,
//           COALESCE(SUM(stripe_fee), 0) as stripe_fees,
//           COALESCE(SUM(paddle_fee), 0) as paddle_fees,
//           COALESCE(SUM(net_amount), 0) as net_to_creators,
//           COUNT(*) as total_transactions,
//           COUNT(DISTINCT user_id) as unique_payers,
//           COUNT(DISTINCT election_id) as elections_with_payments,
//           COALESCE(AVG(amount), 0) as avg_payment,
//           COALESCE(MAX(amount), 0) as max_payment,
//           COALESCE(MIN(amount), 0) as min_payment
//         FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
//       `, params);

//       const byGatewayResult = await pool.query(`
//         SELECT gateway_used as gateway, COUNT(*) as transactions,
//           COALESCE(SUM(amount), 0) as gross_revenue,
//           COALESCE(SUM(platform_fee), 0) as platform_fees,
//           COALESCE(SUM(net_amount), 0) as net_to_creators
//         FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
//         GROUP BY gateway_used
//       `, params);

//       let timeGroup = 'DATE(created_at)';
//       if (groupBy === 'week') timeGroup = "DATE_TRUNC('week', created_at)";
//       if (groupBy === 'month') timeGroup = "DATE_TRUNC('month', created_at)";

//       const timeSeriesResult = await pool.query(`
//         SELECT ${timeGroup} as period, COUNT(*) as transactions,
//           COALESCE(SUM(amount), 0) as revenue, COALESCE(SUM(platform_fee), 0) as platform_fees
//         FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
//         GROUP BY ${timeGroup} ORDER BY period ASC
//       `, params);

//       const summary = summaryResult.rows[0];

//       res.json({
//         success: true,
//         generatedAt: new Date().toISOString(),
//         filters: { dateFrom, dateTo, groupBy },
//         summary: {
//           grossRevenue: parseFloat(summary.gross_revenue),
//           platformFees: parseFloat(summary.platform_fees),
//           stripeFees: parseFloat(summary.stripe_fees),
//           paddleFees: parseFloat(summary.paddle_fees),
//           totalGatewayFees: parseFloat(summary.stripe_fees) + parseFloat(summary.paddle_fees),
//           netToCreators: parseFloat(summary.net_to_creators),
//           totalTransactions: parseInt(summary.total_transactions),
//           uniquePayers: parseInt(summary.unique_payers),
//           electionsWithPayments: parseInt(summary.elections_with_payments),
//           avgPayment: parseFloat(summary.avg_payment),
//           maxPayment: parseFloat(summary.max_payment),
//           minPayment: parseFloat(summary.min_payment)
//         },
//         byGateway: byGatewayResult.rows,
//         timeSeries: timeSeriesResult.rows
//       });
//     } catch (error) {
//       console.error('Get revenue report error:', error);
//       res.status(500).json({ success: false, error: 'Failed to retrieve revenue report' });
//     }
//   }

//   async getRealTimeStats(req, res) {
//     try {
//       const result = await pool.query(`
//         SELECT
//           (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
//           (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
//           (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
//           (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid' AND created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
//           (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
//           (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '24 hours') as revenue_24h,
//           (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
//           (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h
//       `);
      
//       const stats = result.rows[0];
      
//       res.json({
//         success: true,
//         timestamp: new Date().toISOString(),
//         totalUsers: parseInt(stats.total_users),
//         totalElections: parseInt(stats.total_elections),
//         activeElections: parseInt(stats.active_elections),
//         totalVotes: parseInt(stats.total_votes),
//         votesLastHour: parseInt(stats.votes_last_hour),
//         totalRevenue: parseFloat(stats.total_revenue),
//         totalPlatformFees: parseFloat(stats.total_platform_fees),
//         revenue24h: parseFloat(stats.revenue_24h),
//         activeSubscriptions: parseInt(stats.active_subscriptions),
//         newUsers24h: parseInt(stats.new_users_24h)
//       });
//     } catch (error) {
//       console.error('Get real-time stats error:', error);
//       res.status(500).json({ success: false, error: 'Failed to retrieve real-time stats' });
//     }
//   }

//   async getElectionAnalytics(req, res) {
//     try {
//       const { electionId } = req.params;

//       const statsResult = await pool.query(`
//         SELECT e.*, COUNT(DISTINCT v.user_id) as unique_voters, COUNT(v.id) as total_votes
//         FROM votteryyy_elections e
//         LEFT JOIN votteryy_votes v ON e.id = v.election_id AND v.status = 'valid'
//         WHERE e.id = $1 GROUP BY e.id
//       `, [electionId]);

//       if (statsResult.rows.length === 0) {
//         return res.status(404).json({ success: false, error: 'Election not found' });
//       }

//       const election = statsResult.rows[0];

//       const geoResult = await pool.query(`
//         SELECT ud.country, COUNT(DISTINCT v.user_id) as voter_count
//         FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid'
//         GROUP BY ud.country ORDER BY voter_count DESC
//       `, [electionId]);

//       const timeSeriesResult = await pool.query(`
//         SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as vote_count
//         FROM votteryy_votes WHERE election_id = $1 AND status = 'valid'
//         GROUP BY hour ORDER BY hour ASC
//       `, [electionId]);

//       const viewCount = parseInt(election.view_count) || 0;
//       const uniqueVoters = parseInt(election.unique_voters) || 0;
//       const participationRate = viewCount > 0 ? ((uniqueVoters / viewCount) * 100).toFixed(2) : 0;

//       res.json({
//         success: true,
//         election: { id: election.id, title: election.title, status: election.status, votingType: election.voting_type },
//         stats: { viewCount, uniqueVoters, totalVotes: parseInt(election.total_votes), participationRate: parseFloat(participationRate) },
//         geographicDistribution: geoResult.rows,
//         timeSeries: timeSeriesResult.rows
//       });
//     } catch (error) {
//       console.error('Get election analytics error:', error);
//       res.status(500).json({ success: false, error: 'Failed to retrieve election analytics' });
//     }
//   }

//   async getVoterDemographics(req, res) {
//     try {
//       const { electionId } = req.params;

//       const ageResult = await pool.query(`
//         SELECT CASE 
//           WHEN age < 18 THEN 'Under 18' WHEN age BETWEEN 18 AND 24 THEN '18-24'
//           WHEN age BETWEEN 25 AND 34 THEN '25-34' WHEN age BETWEEN 35 AND 44 THEN '35-44'
//           WHEN age BETWEEN 45 AND 54 THEN '45-54' WHEN age BETWEEN 55 AND 64 THEN '55-64'
//           ELSE '65+' END as age_group, COUNT(*) as count
//         FROM votteryy_votes v JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY age_group
//       `, [electionId]);

//       const genderResult = await pool.query(`
//         SELECT ud.gender, COUNT(*) as count FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY ud.gender
//       `, [electionId]);

//       const countryResult = await pool.query(`
//         SELECT ud.country, COUNT(*) as count FROM votteryy_votes v
//         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//         WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY ud.country ORDER BY count DESC LIMIT 10
//       `, [electionId]);

//       res.json({ success: true, ageDistribution: ageResult.rows, genderDistribution: genderResult.rows, topCountries: countryResult.rows });
//     } catch (error) {
//       console.error('Get voter demographics error:', error);
//       res.status(500).json({ success: false, error: 'Failed to retrieve voter demographics' });
//     }
//   }
// }

// export default new AnalyticsController();