import pool from '../config/database.js';
import ballotService from '../services/ballot.service.js';

class AnalyticsController {

  // Get election analytics
  async getElectionAnalytics(req, res) {
    try {
      const { electionId } = req.params;

      // Get basic stats
      const statsResult = await pool.query(
        `SELECT 
           e.*,
           COUNT(DISTINCT v.user_id) as unique_voters,
           COUNT(v.id) as total_votes
         FROM votteryyy_elections e
         LEFT JOIN votteryy_votes v ON e.id = v.election_id AND v.status = 'valid'
         WHERE e.id = $1
         GROUP BY e.id`,
        [electionId]
      );

      if (statsResult.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = statsResult.rows[0];

      // Get vote distribution by question
      const voteDistResult = await pool.query(
        `SELECT 
           eq.id as question_id,
           eq.question_text,
           COUNT(v.id) as vote_count
         FROM votteryy_election_questions eq
         LEFT JOIN votteryy_votes v ON v.election_id = $1 AND v.status = 'valid'
         WHERE eq.election_id = $1
         GROUP BY eq.id, eq.question_text`,
        [electionId]
      );

      // Get geographic distribution
      const geoResult = await pool.query(
        `SELECT 
           ud.country,
           COUNT(DISTINCT v.user_id) as voter_count
         FROM votteryy_votes v
         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
         WHERE v.election_id = $1 AND v.status = 'valid'
         GROUP BY ud.country
         ORDER BY voter_count DESC`,
        [electionId]
      );

      // Get time series data (votes per hour)
      const timeSeriesResult = await pool.query(
        `SELECT 
           DATE_TRUNC('hour', created_at) as hour,
           COUNT(*) as vote_count
         FROM votteryy_votes
         WHERE election_id = $1 AND status = 'valid'
         GROUP BY hour
         ORDER BY hour ASC`,
        [electionId]
      );

      // Get abstention stats
      const abstentionResult = await pool.query(
        `SELECT COUNT(*) as abstention_count
         FROM votteryy_abstentions
         WHERE election_id = $1`,
        [electionId]
      );

      // Calculate participation rate
      const viewCount = parseInt(election.view_count) || 0;
      const uniqueVoters = parseInt(election.unique_voters) || 0;
      const participationRate = viewCount > 0 ? ((uniqueVoters / viewCount) * 100).toFixed(2) : 0;

      res.json({
        election: {
          id: election.id,
          title: election.title,
          status: election.status,
          votingType: election.voting_type,
          startDate: election.start_date,
          endDate: election.end_date
        },
        stats: {
          viewCount,
          uniqueVoters,
          totalVotes: parseInt(election.total_votes),
          participationRate: parseFloat(participationRate),
          abstentionCount: parseInt(abstentionResult.rows[0].abstention_count)
        },
        voteDistribution: voteDistResult.rows,
        geographicDistribution: geoResult.rows,
        timeSeries: timeSeriesResult.rows
      });

    } catch (error) {
      console.error('Get election analytics error:', error);
      res.status(500).json({ error: 'Failed to retrieve election analytics' });
    }
  }

  // Get real-time election results
  async getElectionResults(req, res) {
    try {
      const { electionId } = req.params;

      const results = await ballotService.getLiveResults(electionId);

      res.json(results);

    } catch (error) {
      console.error('Get election results error:', error);
      res.status(500).json({ error: 'Failed to retrieve election results' });
    }
  }

  // Get platform analytics (admin only)
  async getPlatformAnalytics(req, res) {
    try {
      // Verify admin role
      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { dateFrom, dateTo } = req.query;

      // Total elections
      const electionsResult = await pool.query(
        `SELECT 
           COUNT(*) as total_elections,
           COUNT(*) FILTER (WHERE status = 'active') as active_elections,
           COUNT(*) FILTER (WHERE status = 'completed') as completed_elections
         FROM votteryyy_elections`
      );

      // Total votes
      const votesResult = await pool.query(
        `SELECT COUNT(*) as total_votes FROM votteryy_votes WHERE status = 'valid'`
      );

      // Total users
      const usersResult = await pool.query(
        `SELECT COUNT(DISTINCT user_id) as total_voters FROM votteryy_votes`
      );

      // Total revenue
      const revenueResult = await pool.query(
        `SELECT 
           COALESCE(SUM(amount), 0) as total_revenue,
           COALESCE(SUM(platform_fee), 0) as platform_fees
         FROM votteryy_election_payments
         WHERE status = 'succeeded'`
      );

      // Lottery stats
      const lotteryResult = await pool.query(
        `SELECT 
           COUNT(*) as total_lotteries,
           COUNT(*) FILTER (WHERE lottery_enabled = true) as enabled_lotteries,
           COALESCE(SUM(lottery_total_prize_pool), 0) as total_prize_pool
         FROM votteryyy_elections`
      );

      // Recent activity
      const activityResult = await pool.query(
        `SELECT 
           DATE(created_at) as date,
           COUNT(*) as vote_count
         FROM votteryy_votes
         WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY DATE(created_at)
         ORDER BY date DESC`
      );

      res.json({
        elections: electionsResult.rows[0],
        votes: {
          totalVotes: parseInt(votesResult.rows[0].total_votes),
          uniqueVoters: parseInt(usersResult.rows[0].total_voters)
        },
        revenue: {
          totalRevenue: parseFloat(revenueResult.rows[0].total_revenue),
          platformFees: parseFloat(revenueResult.rows[0].platform_fees)
        },
        lottery: {
          totalLotteries: parseInt(lotteryResult.rows[0].total_lotteries),
          enabledLotteries: parseInt(lotteryResult.rows[0].enabled_lotteries),
          totalPrizePool: parseFloat(lotteryResult.rows[0].total_prize_pool)
        },
        recentActivity: activityResult.rows
      });

    } catch (error) {
      console.error('Get platform analytics error:', error);
      res.status(500).json({ error: 'Failed to retrieve platform analytics' });
    }
  }

  // Get user voting history
  async getUserVotingHistory(req, res) {
    try {
      const userId = req.user.userId;
      const { page = 1, limit = 20 } = req.query;

      const offset = (page - 1) * limit;

      const result = await pool.query(
        `SELECT 
           v.voting_id,
           v.election_id,
           v.created_at,
           v.is_edited,
           e.title as election_title,
           e.status as election_status,
           vr.receipt_id
         FROM votteryy_votes v
         JOIN votteryyy_elections e ON v.election_id = e.id
         LEFT JOIN votteryy_vote_receipts vr ON v.voting_id = vr.voting_id
         WHERE v.user_id = $1 AND v.status = 'valid'
         ORDER BY v.created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM votteryy_votes WHERE user_id = $1 AND status = 'valid'`,
        [userId]
      );

      res.json({
        votingHistory: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalCount: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
        }
      });

    } catch (error) {
      console.error('Get user voting history error:', error);
      res.status(500).json({ error: 'Failed to retrieve voting history' });
    }
  }

  // Get voter demographics for election (admin only)
  async getVoterDemographics(req, res) {
    try {
      const { electionId } = req.params;

      // Verify admin or election creator
      const electionResult = await pool.query(
        `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const isCreator = electionResult.rows[0].creator_id === req.user.userId;
      const isAdmin = req.user.roles.includes('admin') || req.user.roles.includes('manager');

      if (!isCreator && !isAdmin) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Age distribution
      const ageResult = await pool.query(
        `SELECT 
           CASE 
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) < 18 THEN 'Under 18'
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 18 AND 24 THEN '18-24'
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 25 AND 34 THEN '25-34'
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 35 AND 44 THEN '35-44'
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 45 AND 54 THEN '45-54'
             WHEN EXTRACT(YEAR FROM AGE(ud.date_of_birth)) BETWEEN 55 AND 64 THEN '55-64'
             ELSE '65+'
           END as age_group,
           COUNT(*) as count
         FROM votteryy_votes v
         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
         WHERE v.election_id = $1 AND v.status = 'valid'
         GROUP BY age_group`,
        [electionId]
      );

      // Gender distribution
      const genderResult = await pool.query(
        `SELECT 
           ud.gender,
           COUNT(*) as count
         FROM votteryy_votes v
         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
         WHERE v.election_id = $1 AND v.status = 'valid'
         GROUP BY ud.gender`,
        [electionId]
      );

      // Country distribution
      const countryResult = await pool.query(
        `SELECT 
           ud.country,
           COUNT(*) as count
         FROM votteryy_votes v
         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
         WHERE v.election_id = $1 AND v.status = 'valid'
         GROUP BY ud.country
         ORDER BY count DESC
         LIMIT 10`,
        [electionId]
      );

      res.json({
        ageDistribution: ageResult.rows,
        genderDistribution: genderResult.rows,
        topCountries: countryResult.rows
      });

    } catch (error) {
      console.error('Get voter demographics error:', error);
      res.status(500).json({ error: 'Failed to retrieve voter demographics' });
    }
  }
}

export default new AnalyticsController();