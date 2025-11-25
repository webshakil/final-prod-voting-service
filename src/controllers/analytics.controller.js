// src/controllers/analytics.controller.js
// VOTING-SERVICE (3007) - Platform analytics data

import pool from '../config/database.js';

class AnalyticsController {

  async getComprehensivePlatformReport(req, res) {
    try {
      const { period = '30' } = req.query;
      const periodDays = Math.min(365, Math.max(1, parseInt(period) || 30));

      const overviewResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
          (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
          (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
          (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
          (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
          (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE lottery_enabled = true) as lottery_elections,
          (SELECT COALESCE(SUM(lottery_total_prize_pool), 0) FROM votteryyy_elections WHERE lottery_enabled = true) as total_prize_pool
      `);

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
        FROM votteryy_user_details WHERE country IS NOT NULL
        GROUP BY country ORDER BY count DESC LIMIT 10
      `);

      const usersByGenderResult = await pool.query(`
        SELECT COALESCE(gender, 'Not Specified') as gender, COUNT(*) as count
        FROM votteryy_user_details GROUP BY gender
      `);

      const userTrendResult = await pool.query(`
        SELECT DATE(collected_at) as date, COUNT(*) as count
        FROM votteryy_user_details
        WHERE collected_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE(collected_at) ORDER BY date ASC
      `);

      const electionStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'draft') as draft,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
          COUNT(*) FILTER (WHERE voting_type = 'plurality') as plurality,
          COUNT(*) FILTER (WHERE voting_type = 'ranked_choice') as ranked_choice,
          COUNT(*) FILTER (WHERE voting_type = 'approval') as approval,
          COUNT(*) FILTER (WHERE is_paid = true) as paid_elections,
          COUNT(*) FILTER (WHERE is_paid = false OR is_paid IS NULL) as free_elections,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as new_period
        FROM votteryyy_elections
      `);

      const electionTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM votteryyy_elections
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE(created_at) ORDER BY date ASC
      `);

      const voteStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_votes,
          COUNT(*) FILTER (WHERE status = 'valid') as valid_votes,
          COUNT(*) FILTER (WHERE status = 'invalid') as invalid_votes,
          COUNT(*) FILTER (WHERE is_edited = true) as edited_votes,
          COUNT(DISTINCT user_id) as unique_voters,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as votes_period,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day') as votes_today
        FROM votteryy_votes
      `);

      const voteTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM votteryy_votes
        WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid'
        GROUP BY DATE(created_at) ORDER BY date ASC
      `);

      const abstentionResult = await pool.query(`SELECT COUNT(*) as total FROM votteryy_abstentions`);

      const revenueStatsResult = await pool.query(`
        SELECT
          COALESCE(SUM(amount), 0) as total_revenue,
          COALESCE(SUM(platform_fee), 0) as total_platform_fees,
          COALESCE(SUM(stripe_fee), 0) as total_stripe_fees,
          COALESCE(SUM(paddle_fee), 0) as total_paddle_fees,
          COALESCE(SUM(net_amount), 0) as total_net_to_creators,
          COUNT(*) as total_transactions,
          COUNT(*) FILTER (WHERE gateway_used = 'stripe') as stripe_transactions,
          COUNT(*) FILTER (WHERE gateway_used = 'paddle') as paddle_transactions,
          COALESCE(SUM(amount) FILTER (WHERE gateway_used = 'stripe'), 0) as stripe_revenue,
          COALESCE(SUM(amount) FILTER (WHERE gateway_used = 'paddle'), 0) as paddle_revenue,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '${periodDays} days'), 0) as revenue_period,
          COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0) as revenue_today,
          COALESCE(AVG(amount), 0) as avg_transaction_amount
        FROM votteryy_election_payments WHERE status = 'succeeded'
      `);

      const revenueByGatewayResult = await pool.query(`
        SELECT COALESCE(gateway_used, 'unknown') as gateway, COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
        FROM votteryy_election_payments WHERE status = 'succeeded'
        GROUP BY gateway_used
      `);

      const revenueTrendResult = await pool.query(`
        SELECT DATE(created_at) as date, COALESCE(SUM(amount), 0) as revenue, 
               COALESCE(SUM(platform_fee), 0) as platform_fees, COUNT(*) as transactions
        FROM votteryy_election_payments
        WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '${periodDays} days'
        GROUP BY DATE(created_at) ORDER BY date ASC
      `);

      const revenueByRegionResult = await pool.query(`
        SELECT COALESCE(region_code, 'unknown') as region, COALESCE(SUM(amount), 0) as amount, COUNT(*) as count
        FROM votteryy_election_payments WHERE status = 'succeeded'
        GROUP BY region_code ORDER BY amount DESC LIMIT 10
      `);

      const subscriptionStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_subscriptions,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled,
          COUNT(*) FILTER (WHERE gateway_used = 'stripe' OR gateway = 'stripe') as stripe_subs,
          COUNT(*) FILTER (WHERE gateway_used = 'paddle' OR gateway = 'paddle') as paddle_subs,
          COUNT(*) FILTER (WHERE payment_type = 'recurring') as recurring,
          COUNT(*) FILTER (WHERE payment_type = 'one_time') as one_time,
          COUNT(*) FILTER (WHERE payment_type = 'pay_as_you_go') as pay_as_you_go
        FROM votteryy_user_subscriptions
      `);

      const subscriptionsByPlanResult = await pool.query(`
        SELECT sp.plan_name, sp.plan_type, COUNT(us.id) as count, sp.price
        FROM votteryy_user_subscriptions us
        JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
        WHERE us.status = 'active'
        GROUP BY sp.id, sp.plan_name, sp.plan_type, sp.price ORDER BY count DESC
      `);

      const walletStatsResult = await pool.query(`
        SELECT
          COALESCE(SUM(balance), 0) as total_available_balance,
          COALESCE(SUM(blocked_balance), 0) as total_blocked_balance,
          COUNT(*) as total_wallets
        FROM votteryy_wallets
      `);

      const transactionTypesResult = await pool.query(`
        SELECT transaction_type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total_amount
        FROM votteryy_transactions WHERE status = 'success'
        GROUP BY transaction_type ORDER BY total_amount DESC
      `);

      const lotteryStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_lottery_elections,
          COUNT(*) FILTER (WHERE status = 'active') as active_lotteries,
          COUNT(*) FILTER (WHERE status = 'completed') as completed_lotteries,
          COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool,
          COALESCE(AVG(lottery_total_prize_pool), 0) as avg_prize_pool
        FROM votteryyy_elections WHERE lottery_enabled = true
      `);

      const growthResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '${periodDays} days') as users_current,
          (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '${periodDays * 2} days' AND collected_at < NOW() - INTERVAL '${periodDays} days') as users_previous,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE created_at >= NOW() - INTERVAL '${periodDays} days') as elections_current,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days') as elections_previous,
          (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'valid') as votes_current,
          (SELECT COUNT(*) FROM votteryy_votes WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days' AND status = 'valid') as votes_previous,
          (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE created_at >= NOW() - INTERVAL '${periodDays} days' AND status = 'succeeded') as revenue_current,
          (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE created_at >= NOW() - INTERVAL '${periodDays * 2} days' AND created_at < NOW() - INTERVAL '${periodDays} days' AND status = 'succeeded') as revenue_previous
      `);

      const calculateGrowth = (current, previous) => {
        const curr = parseFloat(current) || 0;
        const prev = parseFloat(previous) || 0;
        if (prev === 0) return curr > 0 ? 100 : 0;
        return ((curr - prev) / prev * 100).toFixed(2);
      };

      const topElectionsResult = await pool.query(`
        SELECT e.id, e.title, e.status, COUNT(v.id) as vote_count, e.view_count
        FROM votteryyy_elections e
        LEFT JOIN votteryy_votes v ON e.id = v.election_id AND v.status = 'valid'
        GROUP BY e.id ORDER BY vote_count DESC LIMIT 5
      `);

      const topRevenueElectionsResult = await pool.query(`
        SELECT e.id, e.title, COALESCE(SUM(p.amount), 0) as total_revenue, COUNT(p.id) as payment_count
        FROM votteryyy_elections e
        JOIN votteryy_election_payments p ON e.id = p.election_id AND p.status = 'succeeded'
        GROUP BY e.id, e.title ORDER BY total_revenue DESC LIMIT 5
      `);

      const overview = overviewResult.rows[0];
      const userStats = userStatsResult.rows[0];
      const electionStats = electionStatsResult.rows[0];
      const voteStats = voteStatsResult.rows[0];
      const revenueStats = revenueStatsResult.rows[0];
      const subscriptionStats = subscriptionStatsResult.rows[0];
      const walletStats = walletStatsResult.rows[0];
      const lotteryStats = lotteryStatsResult.rows[0];
      const growth = growthResult.rows[0];

      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        period: `${periodDays} days`,
        
        overview: {
          totalUsers: parseInt(overview.total_users),
          totalElections: parseInt(overview.total_elections),
          totalVotes: parseInt(overview.total_votes),
          totalRevenue: parseFloat(overview.total_revenue),
          totalPlatformFees: parseFloat(overview.total_platform_fees),
          activeSubscriptions: parseInt(overview.active_subscriptions),
          lotteryElections: parseInt(overview.lottery_elections),
          totalPrizePool: parseFloat(overview.total_prize_pool)
        },

        users: {
          total: parseInt(userStats.total_registered),
          newThisPeriod: parseInt(userStats.new_users_period),
          newThisWeek: parseInt(userStats.new_users_week),
          newToday: parseInt(userStats.new_users_today),
          byCountry: usersByCountryResult.rows,
          byGender: usersByGenderResult.rows,
          trend: userTrendResult.rows
        },

        elections: {
          total: parseInt(electionStats.total),
          byStatus: {
            draft: parseInt(electionStats.draft),
            active: parseInt(electionStats.active),
            completed: parseInt(electionStats.completed),
            cancelled: parseInt(electionStats.cancelled)
          },
          byType: {
            plurality: parseInt(electionStats.plurality),
            rankedChoice: parseInt(electionStats.ranked_choice),
            approval: parseInt(electionStats.approval)
          },
          paidVsFree: {
            paid: parseInt(electionStats.paid_elections),
            free: parseInt(electionStats.free_elections)
          },
          newThisPeriod: parseInt(electionStats.new_period),
          trend: electionTrendResult.rows
        },

        votes: {
          total: parseInt(voteStats.total_votes),
          valid: parseInt(voteStats.valid_votes),
          invalid: parseInt(voteStats.invalid_votes),
          edited: parseInt(voteStats.edited_votes),
          uniqueVoters: parseInt(voteStats.unique_voters),
          abstentions: parseInt(abstentionResult.rows[0].total),
          thisPeriod: parseInt(voteStats.votes_period),
          today: parseInt(voteStats.votes_today),
          trend: voteTrendResult.rows
        },

        revenue: {
          total: parseFloat(revenueStats.total_revenue),
          platformFees: parseFloat(revenueStats.total_platform_fees),
          stripeFees: parseFloat(revenueStats.total_stripe_fees),
          paddleFees: parseFloat(revenueStats.total_paddle_fees),
          netToCreators: parseFloat(revenueStats.total_net_to_creators),
          totalTransactions: parseInt(revenueStats.total_transactions),
          avgTransactionAmount: parseFloat(revenueStats.avg_transaction_amount),
          byGateway: {
            stripe: { amount: parseFloat(revenueStats.stripe_revenue), count: parseInt(revenueStats.stripe_transactions) },
            paddle: { amount: parseFloat(revenueStats.paddle_revenue), count: parseInt(revenueStats.paddle_transactions) }
          },
          byGatewayChart: revenueByGatewayResult.rows,
          byRegion: revenueByRegionResult.rows,
          thisPeriod: parseFloat(revenueStats.revenue_period),
          today: parseFloat(revenueStats.revenue_today),
          trend: revenueTrendResult.rows
        },

        subscriptions: {
          total: parseInt(subscriptionStats.total_subscriptions),
          active: parseInt(subscriptionStats.active),
          cancelled: parseInt(subscriptionStats.cancelled),
          byGateway: { stripe: parseInt(subscriptionStats.stripe_subs), paddle: parseInt(subscriptionStats.paddle_subs) },
          byPaymentType: {
            recurring: parseInt(subscriptionStats.recurring),
            oneTime: parseInt(subscriptionStats.one_time),
            payAsYouGo: parseInt(subscriptionStats.pay_as_you_go)
          },
          byPlan: subscriptionsByPlanResult.rows
        },

        wallets: {
          totalAvailableBalance: parseFloat(walletStats.total_available_balance),
          totalBlockedBalance: parseFloat(walletStats.total_blocked_balance),
          totalWallets: parseInt(walletStats.total_wallets),
          transactionTypes: transactionTypesResult.rows
        },

        lottery: {
          totalElections: parseInt(lotteryStats.total_lottery_elections),
          active: parseInt(lotteryStats.active_lotteries),
          completed: parseInt(lotteryStats.completed_lotteries),
          totalPrizePool: parseFloat(lotteryStats.total_prize_pool),
          avgPrizePool: parseFloat(lotteryStats.avg_prize_pool)
        },

        growth: {
          users: { current: parseInt(growth.users_current), previous: parseInt(growth.users_previous), percentage: parseFloat(calculateGrowth(growth.users_current, growth.users_previous)) },
          elections: { current: parseInt(growth.elections_current), previous: parseInt(growth.elections_previous), percentage: parseFloat(calculateGrowth(growth.elections_current, growth.elections_previous)) },
          votes: { current: parseInt(growth.votes_current), previous: parseInt(growth.votes_previous), percentage: parseFloat(calculateGrowth(growth.votes_current, growth.votes_previous)) },
          revenue: { current: parseFloat(growth.revenue_current), previous: parseFloat(growth.revenue_previous), percentage: parseFloat(calculateGrowth(growth.revenue_current, growth.revenue_previous)) }
        },

        topPerformers: {
          electionsByVotes: topElectionsResult.rows,
          electionsByRevenue: topRevenueElectionsResult.rows
        }
      });

    } catch (error) {
      console.error('Get comprehensive platform report error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve platform report', details: error.message });
    }
  }

  async getRevenueReport(req, res) {
    try {
      const { dateFrom, dateTo, groupBy = 'day' } = req.query;

      let dateFilter = '';
      const params = [];
      
      if (dateFrom) { params.push(dateFrom); dateFilter += ` AND created_at >= $${params.length}`; }
      if (dateTo) { params.push(dateTo); dateFilter += ` AND created_at <= $${params.length}`; }

      const summaryResult = await pool.query(`
        SELECT
          COALESCE(SUM(amount), 0) as gross_revenue,
          COALESCE(SUM(platform_fee), 0) as platform_fees,
          COALESCE(SUM(stripe_fee), 0) as stripe_fees,
          COALESCE(SUM(paddle_fee), 0) as paddle_fees,
          COALESCE(SUM(net_amount), 0) as net_to_creators,
          COUNT(*) as total_transactions,
          COUNT(DISTINCT user_id) as unique_payers,
          COUNT(DISTINCT election_id) as elections_with_payments,
          COALESCE(AVG(amount), 0) as avg_payment,
          COALESCE(MAX(amount), 0) as max_payment,
          COALESCE(MIN(amount), 0) as min_payment
        FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
      `, params);

      const byGatewayResult = await pool.query(`
        SELECT gateway_used as gateway, COUNT(*) as transactions,
          COALESCE(SUM(amount), 0) as gross_revenue,
          COALESCE(SUM(platform_fee), 0) as platform_fees,
          COALESCE(SUM(net_amount), 0) as net_to_creators
        FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
        GROUP BY gateway_used
      `, params);

      let timeGroup = 'DATE(created_at)';
      if (groupBy === 'week') timeGroup = "DATE_TRUNC('week', created_at)";
      if (groupBy === 'month') timeGroup = "DATE_TRUNC('month', created_at)";

      const timeSeriesResult = await pool.query(`
        SELECT ${timeGroup} as period, COUNT(*) as transactions,
          COALESCE(SUM(amount), 0) as revenue, COALESCE(SUM(platform_fee), 0) as platform_fees
        FROM votteryy_election_payments WHERE status = 'succeeded' ${dateFilter}
        GROUP BY ${timeGroup} ORDER BY period ASC
      `, params);

      const summary = summaryResult.rows[0];

      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        filters: { dateFrom, dateTo, groupBy },
        summary: {
          grossRevenue: parseFloat(summary.gross_revenue),
          platformFees: parseFloat(summary.platform_fees),
          stripeFees: parseFloat(summary.stripe_fees),
          paddleFees: parseFloat(summary.paddle_fees),
          totalGatewayFees: parseFloat(summary.stripe_fees) + parseFloat(summary.paddle_fees),
          netToCreators: parseFloat(summary.net_to_creators),
          totalTransactions: parseInt(summary.total_transactions),
          uniquePayers: parseInt(summary.unique_payers),
          electionsWithPayments: parseInt(summary.elections_with_payments),
          avgPayment: parseFloat(summary.avg_payment),
          maxPayment: parseFloat(summary.max_payment),
          minPayment: parseFloat(summary.min_payment)
        },
        byGateway: byGatewayResult.rows,
        timeSeries: timeSeriesResult.rows
      });
    } catch (error) {
      console.error('Get revenue report error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve revenue report' });
    }
  }

  async getRealTimeStats(req, res) {
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
          (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
          (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
          (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
          (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid' AND created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
          (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
          (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
          (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '24 hours') as revenue_24h,
          (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
          (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h
      `);
      
      const stats = result.rows[0];
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        totalUsers: parseInt(stats.total_users),
        totalElections: parseInt(stats.total_elections),
        activeElections: parseInt(stats.active_elections),
        totalVotes: parseInt(stats.total_votes),
        votesLastHour: parseInt(stats.votes_last_hour),
        totalRevenue: parseFloat(stats.total_revenue),
        totalPlatformFees: parseFloat(stats.total_platform_fees),
        revenue24h: parseFloat(stats.revenue_24h),
        activeSubscriptions: parseInt(stats.active_subscriptions),
        newUsers24h: parseInt(stats.new_users_24h)
      });
    } catch (error) {
      console.error('Get real-time stats error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve real-time stats' });
    }
  }

  async getElectionAnalytics(req, res) {
    try {
      const { electionId } = req.params;

      const statsResult = await pool.query(`
        SELECT e.*, COUNT(DISTINCT v.user_id) as unique_voters, COUNT(v.id) as total_votes
        FROM votteryyy_elections e
        LEFT JOIN votteryy_votes v ON e.id = v.election_id AND v.status = 'valid'
        WHERE e.id = $1 GROUP BY e.id
      `, [electionId]);

      if (statsResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Election not found' });
      }

      const election = statsResult.rows[0];

      const geoResult = await pool.query(`
        SELECT ud.country, COUNT(DISTINCT v.user_id) as voter_count
        FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid'
        GROUP BY ud.country ORDER BY voter_count DESC
      `, [electionId]);

      const timeSeriesResult = await pool.query(`
        SELECT DATE_TRUNC('hour', created_at) as hour, COUNT(*) as vote_count
        FROM votteryy_votes WHERE election_id = $1 AND status = 'valid'
        GROUP BY hour ORDER BY hour ASC
      `, [electionId]);

      const viewCount = parseInt(election.view_count) || 0;
      const uniqueVoters = parseInt(election.unique_voters) || 0;
      const participationRate = viewCount > 0 ? ((uniqueVoters / viewCount) * 100).toFixed(2) : 0;

      res.json({
        success: true,
        election: { id: election.id, title: election.title, status: election.status, votingType: election.voting_type },
        stats: { viewCount, uniqueVoters, totalVotes: parseInt(election.total_votes), participationRate: parseFloat(participationRate) },
        geographicDistribution: geoResult.rows,
        timeSeries: timeSeriesResult.rows
      });
    } catch (error) {
      console.error('Get election analytics error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve election analytics' });
    }
  }

  async getVoterDemographics(req, res) {
    try {
      const { electionId } = req.params;

      const ageResult = await pool.query(`
        SELECT CASE 
          WHEN age < 18 THEN 'Under 18' WHEN age BETWEEN 18 AND 24 THEN '18-24'
          WHEN age BETWEEN 25 AND 34 THEN '25-34' WHEN age BETWEEN 35 AND 44 THEN '35-44'
          WHEN age BETWEEN 45 AND 54 THEN '45-54' WHEN age BETWEEN 55 AND 64 THEN '55-64'
          ELSE '65+' END as age_group, COUNT(*) as count
        FROM votteryy_votes v JOIN votteryy_user_details ud ON v.user_id = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY age_group
      `, [electionId]);

      const genderResult = await pool.query(`
        SELECT ud.gender, COUNT(*) as count FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY ud.gender
      `, [electionId]);

      const countryResult = await pool.query(`
        SELECT ud.country, COUNT(*) as count FROM votteryy_votes v
        JOIN votteryy_user_details ud ON v.user_id = ud.user_id
        WHERE v.election_id = $1 AND v.status = 'valid' GROUP BY ud.country ORDER BY count DESC LIMIT 10
      `, [electionId]);

      res.json({ success: true, ageDistribution: ageResult.rows, genderDistribution: genderResult.rows, topCountries: countryResult.rows });
    } catch (error) {
      console.error('Get voter demographics error:', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve voter demographics' });
    }
  }
}

export default new AnalyticsController();