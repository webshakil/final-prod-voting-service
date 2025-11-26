import pool from '../config/database.js';
import rngService from '../services/rng.service.js';
import auditService from '../services/audit.service.js';
import notificationService from '../services/notification.service.js';

// =====================================================
// DISBURSEMENT CONFIGURATION
// Priority: Database > ENV > Hardcoded defaults
// =====================================================
const DISBURSEMENT_CONFIG = {
  // Use your existing ENV as defaults, fallback to hardcoded
  AUTO_DISBURSE_THRESHOLD: parseFloat(process.env.WALLET_AUTO_PAYOUT_THRESHOLD) || 1000,
  LARGE_AMOUNT_THRESHOLD: parseFloat(process.env.WALLET_LARGE_PAYOUT_THRESHOLD) || 10000,
  MAX_AUTO_DISBURSE_DAILY: parseFloat(process.env.WALLET_MAX_AUTO_DAILY) || 50000,
  CURRENCY: process.env.WALLET_CURRENCY || 'USD',
};

async function loadDisbursementConfig() {
  try {
    const result = await pool.query(
      `SELECT config_key, config_value FROM votteryy_disbursement_config`
    );
    // Database values override ENV values
    result.rows.forEach(row => {
      if (DISBURSEMENT_CONFIG.hasOwnProperty(row.config_key)) {
        DISBURSEMENT_CONFIG[row.config_key] = parseFloat(row.config_value);
      }
    });
    console.log('✅ Disbursement config loaded:', DISBURSEMENT_CONFIG);
  } catch (error) {
    console.log('⚠️ Using ENV/default disbursement config:', DISBURSEMENT_CONFIG);
  }
}
loadDisbursementConfig();

class LotteryController {

  _maskWinnerName(firstName, lastName, odayuserId) {
    if (!firstName && !lastName) {
      return `Winner #${odayuserId}`;
    }
    const first = firstName ? `${firstName.charAt(0)}***` : '';
    const last = lastName ? `${lastName.charAt(0)}***` : '';
    return `${first} ${last}`.trim() || `Winner #${odayuserId}`;
  }

  // GET LOTTERY INFO
  async getLotteryInfo(req, res) {
    try {
      const { electionId } = req.params;
      const userId = req.user?.userId;

      console.log(`🎰 Getting lottery info for election ${electionId}`);

      const result = await pool.query(
        `SELECT 
           e.id, e.title, e.lottery_enabled, e.lottery_prize_funding_source,
           e.lottery_reward_type, e.lottery_total_prize_pool, e.lottery_prize_description,
           e.lottery_estimated_value, e.lottery_projected_revenue,
           e.lottery_revenue_share_percentage, e.lottery_winner_count,
           e.lottery_prize_distribution, e.end_date, e.end_time, e.status
         FROM votteryyy_elections e WHERE e.id = $1`,
        [electionId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = result.rows[0];

      if (!election.lottery_enabled) {
        return res.json({ lotteryEnabled: false, lottery_enabled: false });
      }

      const participantResult = await pool.query(
        `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
        [electionId]
      );
      const participantCount = parseInt(participantResult.rows[0].count || 0);

      const drawResult = await pool.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
        [electionId]
      );

      const hasBeenDrawn = drawResult.rows.length > 0;
      const drawInfo = hasBeenDrawn ? drawResult.rows[0] : null;
      let winners = [];
      let currentUserWinner = null;

      if (hasBeenDrawn) {
        const winnersResult = await pool.query(
          `SELECT 
             lw.winner_id, lw.user_id, lw.rank, lw.prize_amount, lw.prize_percentage,
             lw.prize_description, lw.prize_type, lw.claimed, lw.claimed_at,
             lw.disbursement_status, lw.disbursed_at, lw.admin_approved_by,
             lw.admin_approved_at, lw.rejection_reason, lt.ball_number,
             lt.ticket_number, ud.first_name, ud.last_name
           FROM votteryy_lottery_winners lw
           LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
           LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
           WHERE lw.election_id = $1 ORDER BY lw.rank ASC`,
          [electionId]
        );

        winners = winnersResult.rows.map(w => {
          const fullName = `${w.first_name || ''} ${w.last_name || ''}`.trim();
          const winnerData = {
            id: w.winner_id,
            winner_id: w.winner_id,
            user_id: w.user_id,
            rank: w.rank,
            prize_amount: parseFloat(w.prize_amount || 0),
            prize_percentage: parseFloat(w.prize_percentage || 0),
            prize_description: w.prize_description,
            prize_type: w.prize_type,
            claimed: w.claimed,
            claimed_at: w.claimed_at,
            disbursement_status: w.disbursement_status || 'pending_claim',
            disbursed_at: w.disbursed_at,
            ball_number: w.ball_number,
            ticket_number: w.ticket_number,
            winner_name: fullName || `Winner #${w.rank}`,
            display_name: this._maskWinnerName(w.first_name, w.last_name, w.user_id),
          };

          if (userId && w.user_id === String(userId)) {
            currentUserWinner = {
              ...winnerData,
              winner_name: fullName || `User #${w.user_id}`,
              display_name: fullName || `User #${w.user_id}`,
              isCurrentUser: true,
              can_claim: !w.claimed && (!w.disbursement_status || w.disbursement_status === 'pending_claim'),
            };
          }

          return winnerData;
        });
      }

      const response = {
        lotteryEnabled: true,
        lottery_enabled: true,
        hasBeenDrawn,
        has_been_drawn: hasBeenDrawn,
        drawTime: drawInfo?.draw_time,
        draw_time: drawInfo?.draw_time,
        electionTitle: election.title,
        election_title: election.title,
        rewardType: election.lottery_reward_type,
        reward_type: election.lottery_reward_type,
        totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
        total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
        prizeDescription: election.lottery_prize_description,
        prize_description: election.lottery_prize_description,
        estimatedValue: parseFloat(election.lottery_estimated_value || 0),
        estimated_value: parseFloat(election.lottery_estimated_value || 0),
        winnerCount: winners.length > 0 ? winners.length : election.lottery_winner_count,
        winner_count: winners.length > 0 ? winners.length : election.lottery_winner_count,
        prizeDistribution: election.lottery_prize_distribution || [],
        prize_distribution: election.lottery_prize_distribution || [],
        participantCount,
        participant_count: participantCount,
        winners,
        currentUserWinner,
        current_user_winner: currentUserWinner,
      };

      res.json(response);

    } catch (error) {
      console.error('❌ Get lottery info error:', error);
      res.status(500).json({ error: 'Failed to retrieve lottery information' });
    }
  }

  // GET PUBLIC WINNERS ANNOUNCEMENT
  async getWinnersAnnouncement(req, res) {
    try {
      const { electionId } = req.params;

      const electionResult = await pool.query(
        `SELECT id, title, lottery_enabled, lottery_reward_type,
                lottery_total_prize_pool, lottery_prize_description
         FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = electionResult.rows[0];

      if (!election.lottery_enabled) {
        return res.status(400).json({ error: 'Lottery not enabled for this election' });
      }

      const drawResult = await pool.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
        [electionId]
      );

      if (drawResult.rows.length === 0) {
        return res.json({
          announced: false,
          message: 'Lottery has not been drawn yet',
          electionTitle: election.title,
        });
      }

      const draw = drawResult.rows[0];

      const winnersResult = await pool.query(
        `SELECT 
           lw.winner_id, lw.rank, lw.prize_amount, lw.prize_percentage,
           lw.prize_description, lw.prize_type, lw.claimed, lw.disbursement_status,
           lt.ball_number, ud.first_name, ud.last_name
         FROM votteryy_lottery_winners lw
         LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
         LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
         WHERE lw.election_id = $1 ORDER BY lw.rank ASC`,
        [electionId]
      );

      const winners = winnersResult.rows.map(w => ({
        rank: w.rank,
        prize_amount: parseFloat(w.prize_amount || 0),
        prize_percentage: parseFloat(w.prize_percentage || 0),
        prize_description: w.prize_description,
        prize_type: w.prize_type,
        ball_number: w.ball_number,
        display_name: this._maskWinnerName(w.first_name, w.last_name, w.winner_id),
        claimed: w.claimed,
        disbursement_status: w.disbursement_status || 'pending_claim',
      }));

      res.json({
        announced: true,
        electionId: election.id,
        electionTitle: election.title,
        drawTime: draw.draw_time,
        totalParticipants: draw.total_participants,
        totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
        rewardType: election.lottery_reward_type,
        prizeDescription: election.lottery_prize_description,
        winners,
        randomSeed: draw.random_seed,
      });

    } catch (error) {
      console.error('❌ Get winners announcement error:', error);
      res.status(500).json({ error: 'Failed to retrieve winners announcement' });
    }
  }

  // ============================================
  // CLAIM LOTTERY PRIZE (Main Feature)
  // ============================================
  async claimPrize(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { winnerId } = req.params;
      const userId = req.user.userId;

      console.log(`🎁 Claim prize request: winnerId=${winnerId}, userId=${userId}`);

      const winnerResult = await client.query(
        `SELECT lw.*, e.title as election_title, e.lottery_reward_type
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         WHERE lw.winner_id = $1`,
        [winnerId]
      );

      if (winnerResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Winner record not found' });
      }

      const winner = winnerResult.rows[0];

      if (winner.user_id !== String(userId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You are not authorized to claim this prize' });
      }

      if (winner.claimed) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'Prize already claimed',
          disbursement_status: winner.disbursement_status 
        });
      }

      const prizeAmount = parseFloat(winner.prize_amount || 0);
      const rewardType = winner.lottery_reward_type || winner.prize_type;
      let disbursementStatus = 'pending_claim';
      let requiresApproval = false;
      let autoDisbursed = false;

      if (rewardType === 'monetary' && prizeAmount > 0) {
        if (prizeAmount >= DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD) {
          disbursementStatus = 'pending_senior_approval';
          requiresApproval = true;
          console.log(`💰 Large amount ($${prizeAmount}) - requires senior approval`);
        } else if (prizeAmount >= DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD) {
          disbursementStatus = 'pending_approval';
          requiresApproval = true;
          console.log(`💰 Medium amount ($${prizeAmount}) - requires admin approval`);
        } else {
          disbursementStatus = 'disbursed';
          autoDisbursed = true;
          console.log(`💰 Small amount ($${prizeAmount}) - auto disbursing`);
          
          await client.query(
            `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
             VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
             ON CONFLICT (user_id)
             DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
            [userId, prizeAmount]
          );

          await client.query(
            `INSERT INTO votteryy_wallet_transactions
             (user_id, transaction_type, amount, election_id, status, description, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              userId,
              'prize_won',
              prizeAmount,
              winner.election_id,
              'success',
              `Lottery Prize Rank #${winner.rank} - ${winner.election_title}`,
              JSON.stringify({ winner_id: winnerId, auto_disbursed: true })
            ]
          );
        }
      } else if (rewardType === 'non_monetary' || rewardType === 'projected_revenue') {
        disbursementStatus = 'pending_approval';
        requiresApproval = true;
      }

      await client.query(
        `UPDATE votteryy_lottery_winners
         SET claimed = true, claimed_at = CURRENT_TIMESTAMP,
             disbursement_status = $2,
             disbursed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE winner_id = $1`,
        [winnerId, disbursementStatus, autoDisbursed]
      );

      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'PRIZE_CLAIMED',
          'lottery_winner',
          winnerId,
          userId,
          JSON.stringify({
            prize_amount: prizeAmount,
            reward_type: rewardType,
            disbursement_status: disbursementStatus,
            requires_approval: requiresApproval,
            auto_disbursed: autoDisbursed
          })
        ]
      );

      await client.query('COMMIT');

      let newBalance = null;
      if (autoDisbursed) {
        const walletResult = await pool.query(
          `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
          [userId]
        );
        newBalance = walletResult.rows[0]?.balance;
      }

      res.json({
        success: true,
        message: requiresApproval 
          ? 'Prize claimed successfully. Awaiting admin approval for disbursement.'
          : 'Prize claimed and disbursed to your wallet!',
        winner_id: winnerId,
        prize_amount: prizeAmount,
        disbursement_status: disbursementStatus,
        requires_approval: requiresApproval,
        auto_disbursed: autoDisbursed,
        new_balance: newBalance,
        thresholds: {
          auto_threshold: DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD,
          large_threshold: DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD,
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Claim prize error:', error);
      res.status(500).json({ error: 'Failed to claim prize' });
    } finally {
      client.release();
    }
  }

  // GET USER'S WINNING HISTORY
  async getUserWinningHistory(req, res) {
    try {
      const userId = req.user.userId;

      const result = await pool.query(
        `SELECT lw.*, e.title as election_title, e.lottery_reward_type,
                lt.ticket_number, lt.ball_number
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
         WHERE lw.user_id = $1 ORDER BY lw.created_at DESC`,
        [userId]
      );

      const winnings = result.rows.map(row => ({
        winner_id: row.winner_id,
        election_id: row.election_id,
        election_title: row.election_title,
        rank: row.rank,
        prize_amount: parseFloat(row.prize_amount || 0),
        prize_type: row.prize_type || row.lottery_reward_type,
        prize_description: row.prize_description,
        ticket_number: row.ticket_number,
        ball_number: row.ball_number,
        claimed: row.claimed,
        claimed_at: row.claimed_at,
        disbursement_status: row.disbursement_status || 'pending_claim',
        disbursed_at: row.disbursed_at,
        rejection_reason: row.rejection_reason,
        can_claim: !row.claimed,
        created_at: row.created_at,
      }));

      const summary = {
        total_wins: winnings.length,
        total_won: winnings.reduce((sum, w) => sum + w.prize_amount, 0),
        claimed: winnings.filter(w => w.claimed).length,
        disbursed: winnings.filter(w => w.disbursement_status === 'disbursed').length,
        pending: winnings.filter(w => ['pending_approval', 'pending_senior_approval'].includes(w.disbursement_status)).length,
        unclaimed: winnings.filter(w => !w.claimed).length,
        rejected: winnings.filter(w => w.disbursement_status === 'rejected').length,
      };

      res.json({ winnings, summary });

    } catch (error) {
      console.error('❌ Get user winning history error:', error);
      res.status(500).json({ error: 'Failed to retrieve winning history' });
    }
  }

  // ADMIN: GET PENDING APPROVALS
  async getPendingApprovals(req, res) {
    try {
      const { status, minAmount, maxAmount } = req.query;

      let whereClause = `WHERE lw.disbursement_status IN ('pending_approval', 'pending_senior_approval')`;
      const params = [];
      let paramIndex = 1;

      if (status) {
        whereClause = `WHERE lw.disbursement_status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (minAmount) {
        whereClause += ` AND lw.prize_amount >= $${paramIndex}`;
        params.push(parseFloat(minAmount));
        paramIndex++;
      }

      if (maxAmount) {
        whereClause += ` AND lw.prize_amount <= $${paramIndex}`;
        params.push(parseFloat(maxAmount));
        paramIndex++;
      }

      const result = await pool.query(
        `SELECT lw.*, e.title as election_title, ud.first_name, ud.last_name,
                CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_full_name,
                lt.ticket_number, lt.ball_number, uw.balance as user_balance
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
         LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
         LEFT JOIN votteryy_user_wallets uw ON lw.user_id = uw.user_id
         ${whereClause}
         ORDER BY lw.prize_amount DESC, lw.claimed_at ASC`,
        params
      );

      const pendingApprovals = result.rows.map(row => ({
        winner_id: row.winner_id,
        election_id: row.election_id,
        election_title: row.election_title,
        user_id: row.user_id,
        winner_name: row.winner_full_name?.trim() || `User #${row.user_id}`,
        first_name: row.first_name,
        last_name: row.last_name,
        rank: row.rank,
        prize_amount: parseFloat(row.prize_amount || 0),
        prize_type: row.prize_type,
        prize_description: row.prize_description,
        ticket_number: row.ticket_number,
        ball_number: row.ball_number,
        claimed_at: row.claimed_at,
        disbursement_status: row.disbursement_status,
        requires_senior_approval: row.disbursement_status === 'pending_senior_approval',
        user_current_balance: parseFloat(row.user_balance || 0),
      }));

      const stats = {
        total_pending: pendingApprovals.length,
        total_amount: pendingApprovals.reduce((sum, p) => sum + p.prize_amount, 0),
        pending_approval: pendingApprovals.filter(p => p.disbursement_status === 'pending_approval').length,
        pending_senior_approval: pendingApprovals.filter(p => p.disbursement_status === 'pending_senior_approval').length,
      };

      res.json({
        pendingApprovals,
        pending_approvals: pendingApprovals,
        stats,
        thresholds: {
          auto_disburse: DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD,
          large_amount: DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD,
        }
      });

    } catch (error) {
      console.error('❌ Get pending approvals error:', error);
      res.status(500).json({ error: 'Failed to retrieve pending approvals' });
    }
  }

  // ADMIN: APPROVE DISBURSEMENT
  async approveDisbursement(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { winnerId } = req.params;
      const adminId = req.user.userId;
      const adminRoles = req.user.roles || [];
      const { notes } = req.body;

      console.log(`✅ Approve disbursement: winnerId=${winnerId}, adminId=${adminId}`);

      const winnerResult = await client.query(
        `SELECT lw.*, e.title as election_title
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         WHERE lw.winner_id = $1`,
        [winnerId]
      );

      if (winnerResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Winner record not found' });
      }

      const winner = winnerResult.rows[0];
      const prizeAmount = parseFloat(winner.prize_amount || 0);

      if (winner.disbursement_status === 'pending_senior_approval') {
        if (!adminRoles.includes('manager')) {
          await client.query('ROLLBACK');
          return res.status(403).json({ 
            error: 'This disbursement requires Manager approval due to large amount',
            required_role: 'manager',
            prize_amount: prizeAmount
          });
        }
      }

      if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Cannot approve disbursement with status: ${winner.disbursement_status}` 
        });
      }

      await client.query(
        `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
         VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
         ON CONFLICT (user_id)
         DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
        [winner.user_id, prizeAmount]
      );

      await client.query(
        `INSERT INTO votteryy_wallet_transactions
         (user_id, transaction_type, amount, election_id, status, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          winner.user_id,
          'prize_won',
          prizeAmount,
          winner.election_id,
          'success',
          `Lottery Prize Rank #${winner.rank} - ${winner.election_title} (Admin Approved)`,
          JSON.stringify({ winner_id: winnerId, approved_by: adminId, notes })
        ]
      );

      await client.query(
        `UPDATE votteryy_lottery_winners
         SET disbursement_status = 'disbursed', disbursed_at = CURRENT_TIMESTAMP,
             admin_approved_by = $2, admin_approved_at = CURRENT_TIMESTAMP, admin_notes = $3
         WHERE winner_id = $1`,
        [winnerId, adminId, notes]
      );

      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'PRIZE_DISBURSEMENT_APPROVED',
          'lottery_winner',
          winnerId,
          adminId,
          JSON.stringify({
            winner_user_id: winner.user_id,
            prize_amount: prizeAmount,
            election_id: winner.election_id,
            notes
          })
        ]
      );

      await client.query('COMMIT');

      const walletResult = await pool.query(
        `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
        [winner.user_id]
      );

      res.json({
        success: true,
        message: 'Prize disbursement approved and funds transferred to winner wallet',
        winner_id: winnerId,
        user_id: winner.user_id,
        prize_amount: prizeAmount,
        disbursement_status: 'disbursed',
        approved_by: adminId,
        approved_at: new Date().toISOString(),
        new_balance: parseFloat(walletResult.rows[0]?.balance || 0),
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Approve disbursement error:', error);
      res.status(500).json({ error: 'Failed to approve disbursement' });
    } finally {
      client.release();
    }
  }

  // ADMIN: REJECT DISBURSEMENT
  async rejectDisbursement(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { winnerId } = req.params;
      const adminId = req.user.userId;
      const { reason } = req.body;

      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Rejection reason is required' });
      }

      const winnerResult = await client.query(
        `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
        [winnerId]
      );

      if (winnerResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Winner record not found' });
      }

      const winner = winnerResult.rows[0];

      if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Cannot reject disbursement with status: ${winner.disbursement_status}` 
        });
      }

      await client.query(
        `UPDATE votteryy_lottery_winners
         SET disbursement_status = 'rejected', rejection_reason = $2,
             admin_approved_by = $3, admin_approved_at = CURRENT_TIMESTAMP
         WHERE winner_id = $1`,
        [winnerId, reason, adminId]
      );

      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'PRIZE_DISBURSEMENT_REJECTED',
          'lottery_winner',
          winnerId,
          adminId,
          JSON.stringify({
            winner_user_id: winner.user_id,
            prize_amount: winner.prize_amount,
            reason
          })
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Prize disbursement rejected',
        winner_id: winnerId,
        disbursement_status: 'rejected',
        rejection_reason: reason,
        rejected_by: adminId,
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Reject disbursement error:', error);
      res.status(500).json({ error: 'Failed to reject disbursement' });
    } finally {
      client.release();
    }
  }

  // ADMIN: BULK APPROVE DISBURSEMENTS
  async bulkApproveDisbursements(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { winnerIds } = req.body;
      const adminId = req.user.userId;
      const adminRoles = req.user.roles || [];

      if (!Array.isArray(winnerIds) || winnerIds.length === 0) {
        return res.status(400).json({ error: 'Winner IDs array is required' });
      }

      const results = { approved: [], failed: [], skipped: [] };

      for (const winnerId of winnerIds) {
        try {
          const winnerResult = await client.query(
            `SELECT lw.*, e.title as election_title
             FROM votteryy_lottery_winners lw
             JOIN votteryyy_elections e ON lw.election_id = e.id
             WHERE lw.winner_id = $1`,
            [winnerId]
          );

          if (winnerResult.rows.length === 0) {
            results.failed.push({ winner_id: winnerId, reason: 'Not found' });
            continue;
          }

          const winner = winnerResult.rows[0];
          const prizeAmount = parseFloat(winner.prize_amount || 0);

          if (winner.disbursement_status === 'pending_senior_approval' && !adminRoles.includes('manager')) {
            results.skipped.push({ winner_id: winnerId, reason: 'Requires manager approval', prize_amount: prizeAmount });
            continue;
          }

          if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
            results.skipped.push({ winner_id: winnerId, reason: `Invalid status: ${winner.disbursement_status}` });
            continue;
          }

          await client.query(
            `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
             VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
             ON CONFLICT (user_id)
             DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
            [winner.user_id, prizeAmount]
          );

          await client.query(
            `INSERT INTO votteryy_wallet_transactions
             (user_id, transaction_type, amount, election_id, status, description, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              winner.user_id,
              'prize_won',
              prizeAmount,
              winner.election_id,
              'success',
              `Lottery Prize Rank #${winner.rank} - ${winner.election_title} (Bulk Approved)`,
              JSON.stringify({ winner_id: winnerId, approved_by: adminId, bulk: true })
            ]
          );

          await client.query(
            `UPDATE votteryy_lottery_winners
             SET disbursement_status = 'disbursed', disbursed_at = CURRENT_TIMESTAMP,
                 admin_approved_by = $2, admin_approved_at = CURRENT_TIMESTAMP, admin_notes = 'Bulk approved'
             WHERE winner_id = $1`,
            [winnerId, adminId]
          );

          results.approved.push({ winner_id: winnerId, user_id: winner.user_id, prize_amount: prizeAmount });

        } catch (innerError) {
          results.failed.push({ winner_id: winnerId, reason: innerError.message });
        }
      }

      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        ['BULK_PRIZE_DISBURSEMENT', 'lottery_winners', null, adminId, JSON.stringify(results)]
      );

      await client.query('COMMIT');

      const totalDisbursed = results.approved.reduce((sum, a) => sum + a.prize_amount, 0);

      res.json({
        success: true,
        message: `Processed ${winnerIds.length} disbursements`,
        results,
        summary: {
          total: winnerIds.length,
          approved: results.approved.length,
          failed: results.failed.length,
          skipped: results.skipped.length,
          total_amount_disbursed: totalDisbursed,
        }
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Bulk approve error:', error);
      res.status(500).json({ error: 'Failed to process bulk approvals' });
    } finally {
      client.release();
    }
  }

  // ADMIN: GET DISBURSEMENT HISTORY
  async getDisbursementHistory(req, res) {
    try {
      const { electionId, status, fromDate, toDate, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);

      let whereClause = 'WHERE lw.claimed = true';
      const params = [];
      let paramIndex = 1;

      if (electionId) {
        whereClause += ` AND lw.election_id = $${paramIndex}`;
        params.push(electionId);
        paramIndex++;
      }

      if (status) {
        whereClause += ` AND lw.disbursement_status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (fromDate) {
        whereClause += ` AND lw.claimed_at >= $${paramIndex}`;
        params.push(fromDate);
        paramIndex++;
      }

      if (toDate) {
        whereClause += ` AND lw.claimed_at <= $${paramIndex}`;
        params.push(toDate);
        paramIndex++;
      }

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM votteryy_lottery_winners lw ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].total);

      params.push(parseInt(limit), offset);
      const result = await pool.query(
        `SELECT lw.*, e.title as election_title, ud.first_name, ud.last_name,
                CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_full_name,
                admin_ud.first_name as admin_first_name, admin_ud.last_name as admin_last_name
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
         LEFT JOIN votteryy_user_details admin_ud ON lw.admin_approved_by::integer = admin_ud.user_id
         ${whereClause}
         ORDER BY lw.claimed_at DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        params
      );

      const disbursements = result.rows.map(row => ({
        winner_id: row.winner_id,
        election_id: row.election_id,
        election_title: row.election_title,
        user_id: row.user_id,
        winner_name: row.winner_full_name?.trim() || `User #${row.user_id}`,
        rank: row.rank,
        prize_amount: parseFloat(row.prize_amount || 0),
        prize_type: row.prize_type,
        claimed: row.claimed,
        claimed_at: row.claimed_at,
        disbursement_status: row.disbursement_status || 'pending_claim',
        disbursed_at: row.disbursed_at,
        admin_approved_by: row.admin_approved_by,
        admin_name: row.admin_first_name ? `${row.admin_first_name} ${row.admin_last_name}` : null,
        admin_approved_at: row.admin_approved_at,
        rejection_reason: row.rejection_reason,
        admin_notes: row.admin_notes,
      }));

      res.json({
        disbursements,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit)),
        }
      });

    } catch (error) {
      console.error('❌ Get disbursement history error:', error);
      res.status(500).json({ error: 'Failed to retrieve disbursement history' });
    }
  }

  // GET USER'S LOTTERY TICKET
  async getUserTicket(req, res) {
    try {
      const { electionId } = req.params;
      const userId = req.user.userId;

      const result = await pool.query(
        `SELECT * FROM votteryy_lottery_tickets WHERE user_id = $1 AND election_id = $2`,
        [userId, electionId]
      );

      if (result.rows.length === 0) {
        return res.json({
          hasTicket: false,
          has_ticket: false,
          ticket: null,
          message: 'No lottery ticket found. Vote to participate.'
        });
      }

      const ticket = result.rows[0];

      res.json({
        hasTicket: true,
        has_ticket: true,
        ticket: {
          id: ticket.ticket_id,
          ticket_id: ticket.ticket_id,
          ticket_number: ticket.ticket_number,
          ball_number: ticket.ball_number,
          user_id: ticket.user_id,
          election_id: ticket.election_id,
          created_at: ticket.created_at,
        }
      });

    } catch (error) {
      console.error('❌ Get user ticket error:', error);
      res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
    }
  }

  // GET LOTTERY PARTICIPANTS
  async getLotteryParticipants(req, res) {
    try {
      const { electionId } = req.params;

      const result = await pool.query(
        `SELECT lt.ticket_id, lt.ticket_number, lt.ball_number, lt.user_id, lt.created_at,
                ud.first_name, ud.last_name,
                CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as full_name
         FROM votteryy_lottery_tickets lt
         LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
         WHERE lt.election_id = $1 ORDER BY lt.created_at ASC`,
        [electionId]
      );

      const participants = result.rows.map(p => ({
        id: p.ticket_id,
        ticket_id: p.ticket_id,
        ticket_number: p.ticket_number,
        ball_number: p.ball_number,
        user_id: p.user_id,
        full_name: p.full_name?.trim() || `User #${p.user_id}`,
        first_name: p.first_name,
        last_name: p.last_name,
        created_at: p.created_at,
      }));

      res.json({
        participants,
        count: participants.length,
        totalCount: participants.length,
      });

    } catch (error) {
      console.error('❌ Get lottery participants error:', error);
      res.status(500).json({ error: 'Failed to retrieve lottery participants' });
    }
  }

  // DRAW LOTTERY (Manual - Admin Only)
  async drawLottery(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { electionId } = req.params;
      const adminId = req.user.userId;

      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const electionResult = await client.query(
        `SELECT * FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = electionResult.rows[0];

      if (!election.lottery_enabled) {
        return res.status(400).json({ error: 'Lottery not enabled for this election' });
      }

      const existingDrawResult = await client.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
        [electionId]
      );

      if (existingDrawResult.rows.length > 0) {
        return res.status(400).json({ error: 'Lottery already drawn for this election' });
      }

      const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
        await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

      if (winners.length === 0) {
        return res.status(400).json({ error: 'No participants found for lottery' });
      }

      const drawResult = await client.query(
        `INSERT INTO votteryy_lottery_draws
         (election_id, total_participants, winner_count, random_seed, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING draw_id`,
        [
          electionId,
          totalParticipants,
          winners.length,
          randomSeed,
          'completed',
          JSON.stringify({ prizeDistribution, totalPrizePool, drawn_by: adminId })
        ]
      );

      const drawId = drawResult.rows[0].draw_id;
      const prizeDistArray = prizeDistribution || [];
      const winnerRecords = [];

      for (let i = 0; i < winners.length; i++) {
        const winner = winners[i];
        const rank = i + 1;

        let prizeAmount = 0;
        let prizePercentage = 0;

        if (rewardType === 'monetary' && prizeDistArray.length > 0) {
          const distEntry = prizeDistArray.find(d => d.rank === rank);
          if (distEntry) {
            prizePercentage = distEntry.percentage;
            prizeAmount = (totalPrizePool * prizePercentage) / 100;
          } else {
            prizeAmount = totalPrizePool / winners.length;
            prizePercentage = 100 / winners.length;
          }
        }

        const winnerResult = await client.query(
          `INSERT INTO votteryy_lottery_winners
           (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed, disbursement_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            electionId, winner.user_id, winner.ticket_id, rank, prizeAmount, prizePercentage,
            election.lottery_prize_description, rewardType, false, 'pending_claim'
          ]
        );

        winnerRecords.push(winnerResult.rows[0]);
      }

      await client.query(
        `INSERT INTO votteryy_audit_logs 
         (action, entity_type, entity_id, user_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'LOTTERY_DRAWN', 'election', electionId, adminId,
          JSON.stringify({ draw_id: drawId, total_participants: totalParticipants, winner_count: winners.length })
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        drawId,
        draw_id: drawId,
        totalParticipants,
        total_participants: totalParticipants,
        winners: winnerRecords.map(w => ({ ...w, prize_amount: parseFloat(w.prize_amount || 0) })),
        randomSeed,
        random_seed: randomSeed,
        message: 'Lottery drawn successfully. Winners can now claim their prizes.'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Draw lottery error:', error);
      res.status(500).json({ error: 'Failed to draw lottery' });
    } finally {
      client.release();
    }
  }



  // Add this method to your LotteryController class (uncommented and fixed)

async autoDrawLottery(electionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log(`🎰 Auto-draw started for election ${electionId}`);

    const electionResult = await client.query(
      `SELECT * FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      throw new Error('Election not found');
    }

    const election = electionResult.rows[0];
    const now = new Date();
    const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

    if (now < endDate) {
      throw new Error('Election not yet ended');
    }

    if (!election.lottery_enabled) {
      throw new Error('Lottery not enabled');
    }

    // Check if already drawn
    const existingDraw = await client.query(
      `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
      [electionId]
    );

    if (existingDraw.rows.length > 0) {
      throw new Error('Lottery already drawn');
    }

    // Select winners
    const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
      await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

    if (winners.length === 0) {
      throw new Error('No participants found for lottery');
    }

    // Record lottery draw
    const drawResult = await client.query(
      `INSERT INTO votteryy_lottery_draws
       (election_id, total_participants, winner_count, random_seed, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING draw_id`,
      [
        electionId,
        totalParticipants,
        winners.length,
        randomSeed,
        'completed',
        JSON.stringify({ prizeDistribution, totalPrizePool, autoDrawn: true })
      ]
    );

    const drawId = drawResult.rows[0].draw_id;
    const prizeDistArray = prizeDistribution || [];
    const winnerRecords = [];

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const rank = i + 1;

      let prizeAmount = 0;
      let prizePercentage = 0;

      if (rewardType === 'monetary' && prizeDistArray.length > 0) {
        const distEntry = prizeDistArray.find(d => d.rank === rank);
        if (distEntry) {
          prizePercentage = distEntry.percentage;
          prizeAmount = (totalPrizePool * prizePercentage) / 100;
        } else {
          prizeAmount = totalPrizePool / winners.length;
          prizePercentage = 100 / winners.length;
        }
      }

      // FIX: Added disbursement_status column
      const winnerResult = await client.query(
        `INSERT INTO votteryy_lottery_winners
         (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed, disbursement_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          electionId,
          winner.user_id,
          winner.ticket_id,
          rank,
          prizeAmount,
          prizePercentage,
          election.lottery_prize_description,
          rewardType,
          false,
          'pending_claim'  // Added this
        ]
      );

      winnerRecords.push(winnerResult.rows[0]);

      // Log winner
      console.log(`🏆 Winner (Rank ${rank}): User ${winner.user_id} won ${rewardType === 'monetary' ? `$${prizeAmount.toFixed(2)}` : election.lottery_prize_description}`);
    }

    // Audit log
    await client.query(
      `INSERT INTO votteryy_audit_logs 
       (action, entity_type, entity_id, user_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        'LOTTERY_AUTO_DRAWN',
        'election',
        electionId,
        null,  // System/auto draw
        JSON.stringify({ draw_id: drawId, total_participants: totalParticipants, winner_count: winners.length })
      ]
    );

    await client.query('COMMIT');

    console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
    return { success: true, drawId, winners: winnerRecords };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

  // ADMIN: UPDATE DISBURSEMENT CONFIG
  async updateDisbursementConfig(req, res) {
    try {
      const adminId = req.user.userId;
      const { config_key, config_value } = req.body;

      if (!['AUTO_DISBURSE_THRESHOLD', 'LARGE_AMOUNT_THRESHOLD', 'MAX_AUTO_DISBURSE_DAILY'].includes(config_key)) {
        return res.status(400).json({ error: 'Invalid config key' });
      }

      await pool.query(
        `UPDATE votteryy_disbursement_config 
         SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
         WHERE config_key = $3`,
        [config_value, adminId, config_key]
      );

      DISBURSEMENT_CONFIG[config_key] = parseFloat(config_value);

      res.json({ success: true, message: 'Configuration updated', config: DISBURSEMENT_CONFIG });

    } catch (error) {
      console.error('❌ Update config error:', error);
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  }

  // ADMIN: GET DISBURSEMENT CONFIG
  async getDisbursementConfig(req, res) {
    try {
      const result = await pool.query(
        `SELECT * FROM votteryy_disbursement_config ORDER BY config_key`
      );

      res.json({ config: result.rows, current: DISBURSEMENT_CONFIG });

    } catch (error) {
      console.error('❌ Get config error:', error);
      res.status(500).json({ error: 'Failed to get configuration' });
    }
  }
}

export default new LotteryController();





// import pool from '../config/database.js';
// import rngService from '../services/rng.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';

// // =====================================================
// // DISBURSEMENT CONFIGURATION
// // Priority: Database > ENV > Hardcoded defaults
// // =====================================================
// const DISBURSEMENT_CONFIG = {
//   // Use your existing ENV as defaults, fallback to hardcoded
//   AUTO_DISBURSE_THRESHOLD: parseFloat(process.env.WALLET_AUTO_PAYOUT_THRESHOLD) || 1000,
//   LARGE_AMOUNT_THRESHOLD: parseFloat(process.env.WALLET_LARGE_PAYOUT_THRESHOLD) || 10000,
//   MAX_AUTO_DISBURSE_DAILY: parseFloat(process.env.WALLET_MAX_AUTO_DAILY) || 50000,
//   CURRENCY: process.env.WALLET_CURRENCY || 'USD',
// };

// async function loadDisbursementConfig() {
//   try {
//     const result = await pool.query(
//       `SELECT config_key, config_value FROM votteryy_disbursement_config`
//     );
//     // Database values override ENV values
//     result.rows.forEach(row => {
//       if (DISBURSEMENT_CONFIG.hasOwnProperty(row.config_key)) {
//         DISBURSEMENT_CONFIG[row.config_key] = parseFloat(row.config_value);
//       }
//     });
//     console.log('✅ Disbursement config loaded:', DISBURSEMENT_CONFIG);
//   } catch (error) {
//     console.log('⚠️ Using ENV/default disbursement config:', DISBURSEMENT_CONFIG);
//   }
// }
// loadDisbursementConfig();

// class LotteryController {

//   _maskWinnerName(firstName, lastName, odayuserId) {
//     if (!firstName && !lastName) {
//       return `Winner #${odayuserId}`;
//     }
//     const first = firstName ? `${firstName.charAt(0)}***` : '';
//     const last = lastName ? `${lastName.charAt(0)}***` : '';
//     return `${first} ${last}`.trim() || `Winner #${odayuserId}`;
//   }

//   // GET LOTTERY INFO
//   async getLotteryInfo(req, res) {
//     try {
//       const { electionId } = req.params;
//       const userId = req.user?.userId;

//       console.log(`🎰 Getting lottery info for election ${electionId}`);

//       const result = await pool.query(
//         `SELECT 
//            e.id, e.title, e.lottery_enabled, e.lottery_prize_funding_source,
//            e.lottery_reward_type, e.lottery_total_prize_pool, e.lottery_prize_description,
//            e.lottery_estimated_value, e.lottery_projected_revenue,
//            e.lottery_revenue_share_percentage, e.lottery_winner_count,
//            e.lottery_prize_distribution, e.end_date, e.end_time, e.status
//          FROM votteryyy_elections e WHERE e.id = $1`,
//         [electionId]
//       );

//       if (result.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = result.rows[0];

//       if (!election.lottery_enabled) {
//         return res.json({ lotteryEnabled: false, lottery_enabled: false });
//       }

//       const participantResult = await pool.query(
//         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//         [electionId]
//       );
//       const participantCount = parseInt(participantResult.rows[0].count || 0);

//       const drawResult = await pool.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//         [electionId]
//       );

//       const hasBeenDrawn = drawResult.rows.length > 0;
//       const drawInfo = hasBeenDrawn ? drawResult.rows[0] : null;
//       let winners = [];
//       let currentUserWinner = null;

//       if (hasBeenDrawn) {
//         const winnersResult = await pool.query(
//           `SELECT 
//              lw.winner_id, lw.user_id, lw.rank, lw.prize_amount, lw.prize_percentage,
//              lw.prize_description, lw.prize_type, lw.claimed, lw.claimed_at,
//              lw.disbursement_status, lw.disbursed_at, lw.admin_approved_by,
//              lw.admin_approved_at, lw.rejection_reason, lt.ball_number,
//              lt.ticket_number, ud.first_name, ud.last_name
//            FROM votteryy_lottery_winners lw
//            LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
//            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//            WHERE lw.election_id = $1 ORDER BY lw.rank ASC`,
//           [electionId]
//         );

//         winners = winnersResult.rows.map(w => {
//           const fullName = `${w.first_name || ''} ${w.last_name || ''}`.trim();
//           const winnerData = {
//             id: w.winner_id,
//             winner_id: w.winner_id,
//             user_id: w.user_id,
//             rank: w.rank,
//             prize_amount: parseFloat(w.prize_amount || 0),
//             prize_percentage: parseFloat(w.prize_percentage || 0),
//             prize_description: w.prize_description,
//             prize_type: w.prize_type,
//             claimed: w.claimed,
//             claimed_at: w.claimed_at,
//             disbursement_status: w.disbursement_status || 'pending_claim',
//             disbursed_at: w.disbursed_at,
//             ball_number: w.ball_number,
//             ticket_number: w.ticket_number,
//             winner_name: fullName || `Winner #${w.rank}`,
//             display_name: this._maskWinnerName(w.first_name, w.last_name, w.user_id),
//           };

//           if (userId && w.user_id === String(userId)) {
//             currentUserWinner = {
//               ...winnerData,
//               winner_name: fullName || `User #${w.user_id}`,
//               display_name: fullName || `User #${w.user_id}`,
//               isCurrentUser: true,
//               can_claim: !w.claimed && (!w.disbursement_status || w.disbursement_status === 'pending_claim'),
//             };
//           }

//           return winnerData;
//         });
//       }

//       const response = {
//         lotteryEnabled: true,
//         lottery_enabled: true,
//         hasBeenDrawn,
//         has_been_drawn: hasBeenDrawn,
//         drawTime: drawInfo?.draw_time,
//         draw_time: drawInfo?.draw_time,
//         electionTitle: election.title,
//         election_title: election.title,
//         rewardType: election.lottery_reward_type,
//         reward_type: election.lottery_reward_type,
//         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
//         total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
//         prizeDescription: election.lottery_prize_description,
//         prize_description: election.lottery_prize_description,
//         estimatedValue: parseFloat(election.lottery_estimated_value || 0),
//         estimated_value: parseFloat(election.lottery_estimated_value || 0),
//         winnerCount: winners.length > 0 ? winners.length : election.lottery_winner_count,
//         winner_count: winners.length > 0 ? winners.length : election.lottery_winner_count,
//         prizeDistribution: election.lottery_prize_distribution || [],
//         prize_distribution: election.lottery_prize_distribution || [],
//         participantCount,
//         participant_count: participantCount,
//         winners,
//         currentUserWinner,
//         current_user_winner: currentUserWinner,
//       };

//       res.json(response);

//     } catch (error) {
//       console.error('❌ Get lottery info error:', error);
//       res.status(500).json({ error: 'Failed to retrieve lottery information' });
//     }
//   }

//   // GET PUBLIC WINNERS ANNOUNCEMENT
//   async getWinnersAnnouncement(req, res) {
//     try {
//       const { electionId } = req.params;

//       const electionResult = await pool.query(
//         `SELECT id, title, lottery_enabled, lottery_reward_type,
//                 lottery_total_prize_pool, lottery_prize_description
//          FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];

//       if (!election.lottery_enabled) {
//         return res.status(400).json({ error: 'Lottery not enabled for this election' });
//       }

//       const drawResult = await pool.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
//         [electionId]
//       );

//       if (drawResult.rows.length === 0) {
//         return res.json({
//           announced: false,
//           message: 'Lottery has not been drawn yet',
//           electionTitle: election.title,
//         });
//       }

//       const draw = drawResult.rows[0];

//       const winnersResult = await pool.query(
//         `SELECT 
//            lw.winner_id, lw.rank, lw.prize_amount, lw.prize_percentage,
//            lw.prize_description, lw.prize_type, lw.claimed, lw.disbursement_status,
//            lt.ball_number, ud.first_name, ud.last_name
//          FROM votteryy_lottery_winners lw
//          LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
//          LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//          WHERE lw.election_id = $1 ORDER BY lw.rank ASC`,
//         [electionId]
//       );

//       const winners = winnersResult.rows.map(w => ({
//         rank: w.rank,
//         prize_amount: parseFloat(w.prize_amount || 0),
//         prize_percentage: parseFloat(w.prize_percentage || 0),
//         prize_description: w.prize_description,
//         prize_type: w.prize_type,
//         ball_number: w.ball_number,
//         display_name: this._maskWinnerName(w.first_name, w.last_name, w.winner_id),
//         claimed: w.claimed,
//         disbursement_status: w.disbursement_status || 'pending_claim',
//       }));

//       res.json({
//         announced: true,
//         electionId: election.id,
//         electionTitle: election.title,
//         drawTime: draw.draw_time,
//         totalParticipants: draw.total_participants,
//         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
//         rewardType: election.lottery_reward_type,
//         prizeDescription: election.lottery_prize_description,
//         winners,
//         randomSeed: draw.random_seed,
//       });

//     } catch (error) {
//       console.error('❌ Get winners announcement error:', error);
//       res.status(500).json({ error: 'Failed to retrieve winners announcement' });
//     }
//   }

//   // ============================================
//   // CLAIM LOTTERY PRIZE (Main Feature)
//   // ============================================
//   async claimPrize(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { winnerId } = req.params;
//       const userId = req.user.userId;

//       console.log(`🎁 Claim prize request: winnerId=${winnerId}, userId=${userId}`);

//       const winnerResult = await client.query(
//         `SELECT lw.*, e.title as election_title, e.lottery_reward_type
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          WHERE lw.winner_id = $1`,
//         [winnerId]
//       );

//       if (winnerResult.rows.length === 0) {
//         await client.query('ROLLBACK');
//         return res.status(404).json({ error: 'Winner record not found' });
//       }

//       const winner = winnerResult.rows[0];

//       if (winner.user_id !== String(userId)) {
//         await client.query('ROLLBACK');
//         return res.status(403).json({ error: 'You are not authorized to claim this prize' });
//       }

//       if (winner.claimed) {
//         await client.query('ROLLBACK');
//         return res.status(400).json({ 
//           error: 'Prize already claimed',
//           disbursement_status: winner.disbursement_status 
//         });
//       }

//       const prizeAmount = parseFloat(winner.prize_amount || 0);
//       const rewardType = winner.lottery_reward_type || winner.prize_type;
//       let disbursementStatus = 'pending_claim';
//       let requiresApproval = false;
//       let autoDisbursed = false;

//       if (rewardType === 'monetary' && prizeAmount > 0) {
//         if (prizeAmount >= DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD) {
//           disbursementStatus = 'pending_senior_approval';
//           requiresApproval = true;
//           console.log(`💰 Large amount ($${prizeAmount}) - requires senior approval`);
//         } else if (prizeAmount >= DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD) {
//           disbursementStatus = 'pending_approval';
//           requiresApproval = true;
//           console.log(`💰 Medium amount ($${prizeAmount}) - requires admin approval`);
//         } else {
//           disbursementStatus = 'disbursed';
//           autoDisbursed = true;
//           console.log(`💰 Small amount ($${prizeAmount}) - auto disbursing`);
          
//           await client.query(
//             `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
//              VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
//              ON CONFLICT (user_id)
//              DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
//             [userId, prizeAmount]
//           );

//           await client.query(
//             `INSERT INTO votteryy_wallet_transactions
//              (user_id, transaction_type, amount, election_id, status, description, metadata)
//              VALUES ($1, $2, $3, $4, $5, $6, $7)`,
//             [
//               userId,
//               'prize_won',
//               prizeAmount,
//               winner.election_id,
//               'success',
//               `Lottery Prize Rank #${winner.rank} - ${winner.election_title}`,
//               JSON.stringify({ winner_id: winnerId, auto_disbursed: true })
//             ]
//           );
//         }
//       } else if (rewardType === 'non_monetary' || rewardType === 'projected_revenue') {
//         disbursementStatus = 'pending_approval';
//         requiresApproval = true;
//       }

//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET claimed = true, claimed_at = CURRENT_TIMESTAMP,
//              disbursement_status = $2,
//              disbursed_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END
//          WHERE winner_id = $1`,
//         [winnerId, disbursementStatus, autoDisbursed]
//       );

//       await client.query(
//         `INSERT INTO votteryy_audit_logs 
//          (action, entity_type, entity_id, user_id, details)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           'PRIZE_CLAIMED',
//           'lottery_winner',
//           winnerId,
//           userId,
//           JSON.stringify({
//             prize_amount: prizeAmount,
//             reward_type: rewardType,
//             disbursement_status: disbursementStatus,
//             requires_approval: requiresApproval,
//             auto_disbursed: autoDisbursed
//           })
//         ]
//       );

//       await client.query('COMMIT');

//       let newBalance = null;
//       if (autoDisbursed) {
//         const walletResult = await pool.query(
//           `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
//           [userId]
//         );
//         newBalance = walletResult.rows[0]?.balance;
//       }

//       res.json({
//         success: true,
//         message: requiresApproval 
//           ? 'Prize claimed successfully. Awaiting admin approval for disbursement.'
//           : 'Prize claimed and disbursed to your wallet!',
//         winner_id: winnerId,
//         prize_amount: prizeAmount,
//         disbursement_status: disbursementStatus,
//         requires_approval: requiresApproval,
//         auto_disbursed: autoDisbursed,
//         new_balance: newBalance,
//         thresholds: {
//           auto_threshold: DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD,
//           large_threshold: DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD,
//         }
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Claim prize error:', error);
//       res.status(500).json({ error: 'Failed to claim prize' });
//     } finally {
//       client.release();
//     }
//   }

//   // GET USER'S WINNING HISTORY
//   async getUserWinningHistory(req, res) {
//     try {
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT lw.*, e.title as election_title, e.lottery_reward_type,
//                 lt.ticket_number, lt.ball_number
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//          WHERE lw.user_id = $1 ORDER BY lw.created_at DESC`,
//         [userId]
//       );

//       const winnings = result.rows.map(row => ({
//         winner_id: row.winner_id,
//         election_id: row.election_id,
//         election_title: row.election_title,
//         rank: row.rank,
//         prize_amount: parseFloat(row.prize_amount || 0),
//         prize_type: row.prize_type || row.lottery_reward_type,
//         prize_description: row.prize_description,
//         ticket_number: row.ticket_number,
//         ball_number: row.ball_number,
//         claimed: row.claimed,
//         claimed_at: row.claimed_at,
//         disbursement_status: row.disbursement_status || 'pending_claim',
//         disbursed_at: row.disbursed_at,
//         rejection_reason: row.rejection_reason,
//         can_claim: !row.claimed,
//         created_at: row.created_at,
//       }));

//       const summary = {
//         total_wins: winnings.length,
//         total_won: winnings.reduce((sum, w) => sum + w.prize_amount, 0),
//         claimed: winnings.filter(w => w.claimed).length,
//         disbursed: winnings.filter(w => w.disbursement_status === 'disbursed').length,
//         pending: winnings.filter(w => ['pending_approval', 'pending_senior_approval'].includes(w.disbursement_status)).length,
//         unclaimed: winnings.filter(w => !w.claimed).length,
//         rejected: winnings.filter(w => w.disbursement_status === 'rejected').length,
//       };

//       res.json({ winnings, summary });

//     } catch (error) {
//       console.error('❌ Get user winning history error:', error);
//       res.status(500).json({ error: 'Failed to retrieve winning history' });
//     }
//   }

//   // ADMIN: GET PENDING APPROVALS
//   async getPendingApprovals(req, res) {
//     try {
//       const { status, minAmount, maxAmount } = req.query;

//       let whereClause = `WHERE lw.disbursement_status IN ('pending_approval', 'pending_senior_approval')`;
//       const params = [];
//       let paramIndex = 1;

//       if (status) {
//         whereClause = `WHERE lw.disbursement_status = $${paramIndex}`;
//         params.push(status);
//         paramIndex++;
//       }

//       if (minAmount) {
//         whereClause += ` AND lw.prize_amount >= $${paramIndex}`;
//         params.push(parseFloat(minAmount));
//         paramIndex++;
//       }

//       if (maxAmount) {
//         whereClause += ` AND lw.prize_amount <= $${paramIndex}`;
//         params.push(parseFloat(maxAmount));
//         paramIndex++;
//       }

//       const result = await pool.query(
//         `SELECT lw.*, e.title as election_title, ud.first_name, ud.last_name,
//                 CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_full_name,
//                 lt.ticket_number, lt.ball_number, uw.balance as user_balance
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
//          LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//          LEFT JOIN votteryy_user_wallets uw ON lw.user_id = uw.user_id
//          ${whereClause}
//          ORDER BY lw.prize_amount DESC, lw.claimed_at ASC`,
//         params
//       );

//       const pendingApprovals = result.rows.map(row => ({
//         winner_id: row.winner_id,
//         election_id: row.election_id,
//         election_title: row.election_title,
//         user_id: row.user_id,
//         winner_name: row.winner_full_name?.trim() || `User #${row.user_id}`,
//         first_name: row.first_name,
//         last_name: row.last_name,
//         rank: row.rank,
//         prize_amount: parseFloat(row.prize_amount || 0),
//         prize_type: row.prize_type,
//         prize_description: row.prize_description,
//         ticket_number: row.ticket_number,
//         ball_number: row.ball_number,
//         claimed_at: row.claimed_at,
//         disbursement_status: row.disbursement_status,
//         requires_senior_approval: row.disbursement_status === 'pending_senior_approval',
//         user_current_balance: parseFloat(row.user_balance || 0),
//       }));

//       const stats = {
//         total_pending: pendingApprovals.length,
//         total_amount: pendingApprovals.reduce((sum, p) => sum + p.prize_amount, 0),
//         pending_approval: pendingApprovals.filter(p => p.disbursement_status === 'pending_approval').length,
//         pending_senior_approval: pendingApprovals.filter(p => p.disbursement_status === 'pending_senior_approval').length,
//       };

//       res.json({
//         pendingApprovals,
//         pending_approvals: pendingApprovals,
//         stats,
//         thresholds: {
//           auto_disburse: DISBURSEMENT_CONFIG.AUTO_DISBURSE_THRESHOLD,
//           large_amount: DISBURSEMENT_CONFIG.LARGE_AMOUNT_THRESHOLD,
//         }
//       });

//     } catch (error) {
//       console.error('❌ Get pending approvals error:', error);
//       res.status(500).json({ error: 'Failed to retrieve pending approvals' });
//     }
//   }

//   // ADMIN: APPROVE DISBURSEMENT
//   async approveDisbursement(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { winnerId } = req.params;
//       const adminId = req.user.userId;
//       const adminRoles = req.user.roles || [];
//       const { notes } = req.body;

//       console.log(`✅ Approve disbursement: winnerId=${winnerId}, adminId=${adminId}`);

//       const winnerResult = await client.query(
//         `SELECT lw.*, e.title as election_title
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          WHERE lw.winner_id = $1`,
//         [winnerId]
//       );

//       if (winnerResult.rows.length === 0) {
//         await client.query('ROLLBACK');
//         return res.status(404).json({ error: 'Winner record not found' });
//       }

//       const winner = winnerResult.rows[0];
//       const prizeAmount = parseFloat(winner.prize_amount || 0);

//       if (winner.disbursement_status === 'pending_senior_approval') {
//         if (!adminRoles.includes('manager')) {
//           await client.query('ROLLBACK');
//           return res.status(403).json({ 
//             error: 'This disbursement requires Manager approval due to large amount',
//             required_role: 'manager',
//             prize_amount: prizeAmount
//           });
//         }
//       }

//       if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
//         await client.query('ROLLBACK');
//         return res.status(400).json({ 
//           error: `Cannot approve disbursement with status: ${winner.disbursement_status}` 
//         });
//       }

//       await client.query(
//         `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
//          ON CONFLICT (user_id)
//          DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
//         [winner.user_id, prizeAmount]
//       );

//       await client.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, election_id, status, description, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
//         [
//           winner.user_id,
//           'prize_won',
//           prizeAmount,
//           winner.election_id,
//           'success',
//           `Lottery Prize Rank #${winner.rank} - ${winner.election_title} (Admin Approved)`,
//           JSON.stringify({ winner_id: winnerId, approved_by: adminId, notes })
//         ]
//       );

//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET disbursement_status = 'disbursed', disbursed_at = CURRENT_TIMESTAMP,
//              admin_approved_by = $2, admin_approved_at = CURRENT_TIMESTAMP, admin_notes = $3
//          WHERE winner_id = $1`,
//         [winnerId, adminId, notes]
//       );

//       await client.query(
//         `INSERT INTO votteryy_audit_logs 
//          (action, entity_type, entity_id, user_id, details)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           'PRIZE_DISBURSEMENT_APPROVED',
//           'lottery_winner',
//           winnerId,
//           adminId,
//           JSON.stringify({
//             winner_user_id: winner.user_id,
//             prize_amount: prizeAmount,
//             election_id: winner.election_id,
//             notes
//           })
//         ]
//       );

//       await client.query('COMMIT');

//       const walletResult = await pool.query(
//         `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
//         [winner.user_id]
//       );

//       res.json({
//         success: true,
//         message: 'Prize disbursement approved and funds transferred to winner wallet',
//         winner_id: winnerId,
//         user_id: winner.user_id,
//         prize_amount: prizeAmount,
//         disbursement_status: 'disbursed',
//         approved_by: adminId,
//         approved_at: new Date().toISOString(),
//         new_balance: parseFloat(walletResult.rows[0]?.balance || 0),
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Approve disbursement error:', error);
//       res.status(500).json({ error: 'Failed to approve disbursement' });
//     } finally {
//       client.release();
//     }
//   }

//   // ADMIN: REJECT DISBURSEMENT
//   async rejectDisbursement(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { winnerId } = req.params;
//       const adminId = req.user.userId;
//       const { reason } = req.body;

//       if (!reason || !reason.trim()) {
//         return res.status(400).json({ error: 'Rejection reason is required' });
//       }

//       const winnerResult = await client.query(
//         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
//         [winnerId]
//       );

//       if (winnerResult.rows.length === 0) {
//         await client.query('ROLLBACK');
//         return res.status(404).json({ error: 'Winner record not found' });
//       }

//       const winner = winnerResult.rows[0];

//       if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
//         await client.query('ROLLBACK');
//         return res.status(400).json({ 
//           error: `Cannot reject disbursement with status: ${winner.disbursement_status}` 
//         });
//       }

//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET disbursement_status = 'rejected', rejection_reason = $2,
//              admin_approved_by = $3, admin_approved_at = CURRENT_TIMESTAMP
//          WHERE winner_id = $1`,
//         [winnerId, reason, adminId]
//       );

//       await client.query(
//         `INSERT INTO votteryy_audit_logs 
//          (action, entity_type, entity_id, user_id, details)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           'PRIZE_DISBURSEMENT_REJECTED',
//           'lottery_winner',
//           winnerId,
//           adminId,
//           JSON.stringify({
//             winner_user_id: winner.user_id,
//             prize_amount: winner.prize_amount,
//             reason
//           })
//         ]
//       );

//       await client.query('COMMIT');

//       res.json({
//         success: true,
//         message: 'Prize disbursement rejected',
//         winner_id: winnerId,
//         disbursement_status: 'rejected',
//         rejection_reason: reason,
//         rejected_by: adminId,
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Reject disbursement error:', error);
//       res.status(500).json({ error: 'Failed to reject disbursement' });
//     } finally {
//       client.release();
//     }
//   }

//   // ADMIN: BULK APPROVE DISBURSEMENTS
//   async bulkApproveDisbursements(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { winnerIds } = req.body;
//       const adminId = req.user.userId;
//       const adminRoles = req.user.roles || [];

//       if (!Array.isArray(winnerIds) || winnerIds.length === 0) {
//         return res.status(400).json({ error: 'Winner IDs array is required' });
//       }

//       const results = { approved: [], failed: [], skipped: [] };

//       for (const winnerId of winnerIds) {
//         try {
//           const winnerResult = await client.query(
//             `SELECT lw.*, e.title as election_title
//              FROM votteryy_lottery_winners lw
//              JOIN votteryyy_elections e ON lw.election_id = e.id
//              WHERE lw.winner_id = $1`,
//             [winnerId]
//           );

//           if (winnerResult.rows.length === 0) {
//             results.failed.push({ winner_id: winnerId, reason: 'Not found' });
//             continue;
//           }

//           const winner = winnerResult.rows[0];
//           const prizeAmount = parseFloat(winner.prize_amount || 0);

//           if (winner.disbursement_status === 'pending_senior_approval' && !adminRoles.includes('manager')) {
//             results.skipped.push({ winner_id: winnerId, reason: 'Requires manager approval', prize_amount: prizeAmount });
//             continue;
//           }

//           if (!['pending_approval', 'pending_senior_approval'].includes(winner.disbursement_status)) {
//             results.skipped.push({ winner_id: winnerId, reason: `Invalid status: ${winner.disbursement_status}` });
//             continue;
//           }

//           await client.query(
//             `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
//              VALUES ($1, $2, 0, '${DISBURSEMENT_CONFIG.CURRENCY}')
//              ON CONFLICT (user_id)
//              DO UPDATE SET balance = votteryy_user_wallets.balance + $2, updated_at = CURRENT_TIMESTAMP`,
//             [winner.user_id, prizeAmount]
//           );

//           await client.query(
//             `INSERT INTO votteryy_wallet_transactions
//              (user_id, transaction_type, amount, election_id, status, description, metadata)
//              VALUES ($1, $2, $3, $4, $5, $6, $7)`,
//             [
//               winner.user_id,
//               'prize_won',
//               prizeAmount,
//               winner.election_id,
//               'success',
//               `Lottery Prize Rank #${winner.rank} - ${winner.election_title} (Bulk Approved)`,
//               JSON.stringify({ winner_id: winnerId, approved_by: adminId, bulk: true })
//             ]
//           );

//           await client.query(
//             `UPDATE votteryy_lottery_winners
//              SET disbursement_status = 'disbursed', disbursed_at = CURRENT_TIMESTAMP,
//                  admin_approved_by = $2, admin_approved_at = CURRENT_TIMESTAMP, admin_notes = 'Bulk approved'
//              WHERE winner_id = $1`,
//             [winnerId, adminId]
//           );

//           results.approved.push({ winner_id: winnerId, user_id: winner.user_id, prize_amount: prizeAmount });

//         } catch (innerError) {
//           results.failed.push({ winner_id: winnerId, reason: innerError.message });
//         }
//       }

//       await client.query(
//         `INSERT INTO votteryy_audit_logs 
//          (action, entity_type, entity_id, user_id, details)
//          VALUES ($1, $2, $3, $4, $5)`,
//         ['BULK_PRIZE_DISBURSEMENT', 'lottery_winners', null, adminId, JSON.stringify(results)]
//       );

//       await client.query('COMMIT');

//       const totalDisbursed = results.approved.reduce((sum, a) => sum + a.prize_amount, 0);

//       res.json({
//         success: true,
//         message: `Processed ${winnerIds.length} disbursements`,
//         results,
//         summary: {
//           total: winnerIds.length,
//           approved: results.approved.length,
//           failed: results.failed.length,
//           skipped: results.skipped.length,
//           total_amount_disbursed: totalDisbursed,
//         }
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Bulk approve error:', error);
//       res.status(500).json({ error: 'Failed to process bulk approvals' });
//     } finally {
//       client.release();
//     }
//   }

//   // ADMIN: GET DISBURSEMENT HISTORY
//   async getDisbursementHistory(req, res) {
//     try {
//       const { electionId, status, fromDate, toDate, page = 1, limit = 20 } = req.query;
//       const offset = (parseInt(page) - 1) * parseInt(limit);

//       let whereClause = 'WHERE lw.claimed = true';
//       const params = [];
//       let paramIndex = 1;

//       if (electionId) {
//         whereClause += ` AND lw.election_id = $${paramIndex}`;
//         params.push(electionId);
//         paramIndex++;
//       }

//       if (status) {
//         whereClause += ` AND lw.disbursement_status = $${paramIndex}`;
//         params.push(status);
//         paramIndex++;
//       }

//       if (fromDate) {
//         whereClause += ` AND lw.claimed_at >= $${paramIndex}`;
//         params.push(fromDate);
//         paramIndex++;
//       }

//       if (toDate) {
//         whereClause += ` AND lw.claimed_at <= $${paramIndex}`;
//         params.push(toDate);
//         paramIndex++;
//       }

//       const countResult = await pool.query(
//         `SELECT COUNT(*) as total FROM votteryy_lottery_winners lw ${whereClause}`,
//         params
//       );
//       const total = parseInt(countResult.rows[0].total);

//       params.push(parseInt(limit), offset);
//       const result = await pool.query(
//         `SELECT lw.*, e.title as election_title, ud.first_name, ud.last_name,
//                 CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_full_name,
//                 admin_ud.first_name as admin_first_name, admin_ud.last_name as admin_last_name
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          LEFT JOIN votteryy_user_details ud ON lw.user_id::integer = ud.user_id
//          LEFT JOIN votteryy_user_details admin_ud ON lw.admin_approved_by::integer = admin_ud.user_id
//          ${whereClause}
//          ORDER BY lw.claimed_at DESC
//          LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
//         params
//       );

//       const disbursements = result.rows.map(row => ({
//         winner_id: row.winner_id,
//         election_id: row.election_id,
//         election_title: row.election_title,
//         user_id: row.user_id,
//         winner_name: row.winner_full_name?.trim() || `User #${row.user_id}`,
//         rank: row.rank,
//         prize_amount: parseFloat(row.prize_amount || 0),
//         prize_type: row.prize_type,
//         claimed: row.claimed,
//         claimed_at: row.claimed_at,
//         disbursement_status: row.disbursement_status || 'pending_claim',
//         disbursed_at: row.disbursed_at,
//         admin_approved_by: row.admin_approved_by,
//         admin_name: row.admin_first_name ? `${row.admin_first_name} ${row.admin_last_name}` : null,
//         admin_approved_at: row.admin_approved_at,
//         rejection_reason: row.rejection_reason,
//         admin_notes: row.admin_notes,
//       }));

//       res.json({
//         disbursements,
//         pagination: {
//           page: parseInt(page),
//           limit: parseInt(limit),
//           total,
//           totalPages: Math.ceil(total / parseInt(limit)),
//         }
//       });

//     } catch (error) {
//       console.error('❌ Get disbursement history error:', error);
//       res.status(500).json({ error: 'Failed to retrieve disbursement history' });
//     }
//   }

//   // GET USER'S LOTTERY TICKET
//   async getUserTicket(req, res) {
//     try {
//       const { electionId } = req.params;
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT * FROM votteryy_lottery_tickets WHERE user_id = $1 AND election_id = $2`,
//         [userId, electionId]
//       );

//       if (result.rows.length === 0) {
//         return res.json({
//           hasTicket: false,
//           has_ticket: false,
//           ticket: null,
//           message: 'No lottery ticket found. Vote to participate.'
//         });
//       }

//       const ticket = result.rows[0];

//       res.json({
//         hasTicket: true,
//         has_ticket: true,
//         ticket: {
//           id: ticket.ticket_id,
//           ticket_id: ticket.ticket_id,
//           ticket_number: ticket.ticket_number,
//           ball_number: ticket.ball_number,
//           user_id: ticket.user_id,
//           election_id: ticket.election_id,
//           created_at: ticket.created_at,
//         }
//       });

//     } catch (error) {
//       console.error('❌ Get user ticket error:', error);
//       res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
//     }
//   }

//   // GET LOTTERY PARTICIPANTS
//   async getLotteryParticipants(req, res) {
//     try {
//       const { electionId } = req.params;

//       const result = await pool.query(
//         `SELECT lt.ticket_id, lt.ticket_number, lt.ball_number, lt.user_id, lt.created_at,
//                 ud.first_name, ud.last_name,
//                 CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as full_name
//          FROM votteryy_lottery_tickets lt
//          LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
//          WHERE lt.election_id = $1 ORDER BY lt.created_at ASC`,
//         [electionId]
//       );

//       const participants = result.rows.map(p => ({
//         id: p.ticket_id,
//         ticket_id: p.ticket_id,
//         ticket_number: p.ticket_number,
//         ball_number: p.ball_number,
//         user_id: p.user_id,
//         full_name: p.full_name?.trim() || `User #${p.user_id}`,
//         first_name: p.first_name,
//         last_name: p.last_name,
//         created_at: p.created_at,
//       }));

//       res.json({
//         participants,
//         count: participants.length,
//         totalCount: participants.length,
//       });

//     } catch (error) {
//       console.error('❌ Get lottery participants error:', error);
//       res.status(500).json({ error: 'Failed to retrieve lottery participants' });
//     }
//   }

//   // DRAW LOTTERY (Manual - Admin Only)
//   async drawLottery(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { electionId } = req.params;
//       const adminId = req.user.userId;

//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
//       }

//       const electionResult = await client.query(
//         `SELECT * FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];

//       if (!election.lottery_enabled) {
//         return res.status(400).json({ error: 'Lottery not enabled for this election' });
//       }

//       const existingDrawResult = await client.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
//         [electionId]
//       );

//       if (existingDrawResult.rows.length > 0) {
//         return res.status(400).json({ error: 'Lottery already drawn for this election' });
//       }

//       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
//         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

//       if (winners.length === 0) {
//         return res.status(400).json({ error: 'No participants found for lottery' });
//       }

//       const drawResult = await client.query(
//         `INSERT INTO votteryy_lottery_draws
//          (election_id, total_participants, winner_count, random_seed, status, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6)
//          RETURNING draw_id`,
//         [
//           electionId,
//           totalParticipants,
//           winners.length,
//           randomSeed,
//           'completed',
//           JSON.stringify({ prizeDistribution, totalPrizePool, drawn_by: adminId })
//         ]
//       );

//       const drawId = drawResult.rows[0].draw_id;
//       const prizeDistArray = prizeDistribution || [];
//       const winnerRecords = [];

//       for (let i = 0; i < winners.length; i++) {
//         const winner = winners[i];
//         const rank = i + 1;

//         let prizeAmount = 0;
//         let prizePercentage = 0;

//         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
//           const distEntry = prizeDistArray.find(d => d.rank === rank);
//           if (distEntry) {
//             prizePercentage = distEntry.percentage;
//             prizeAmount = (totalPrizePool * prizePercentage) / 100;
//           } else {
//             prizeAmount = totalPrizePool / winners.length;
//             prizePercentage = 100 / winners.length;
//           }
//         }

//         const winnerResult = await client.query(
//           `INSERT INTO votteryy_lottery_winners
//            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed, disbursement_status)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
//            RETURNING *`,
//           [
//             electionId, winner.user_id, winner.ticket_id, rank, prizeAmount, prizePercentage,
//             election.lottery_prize_description, rewardType, false, 'pending_claim'
//           ]
//         );

//         winnerRecords.push(winnerResult.rows[0]);
//       }

//       await client.query(
//         `INSERT INTO votteryy_audit_logs 
//          (action, entity_type, entity_id, user_id, details)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           'LOTTERY_DRAWN', 'election', electionId, adminId,
//           JSON.stringify({ draw_id: drawId, total_participants: totalParticipants, winner_count: winners.length })
//         ]
//       );

//       await client.query('COMMIT');

//       res.json({
//         success: true,
//         drawId,
//         draw_id: drawId,
//         totalParticipants,
//         total_participants: totalParticipants,
//         winners: winnerRecords.map(w => ({ ...w, prize_amount: parseFloat(w.prize_amount || 0) })),
//         randomSeed,
//         random_seed: randomSeed,
//         message: 'Lottery drawn successfully. Winners can now claim their prizes.'
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Draw lottery error:', error);
//       res.status(500).json({ error: 'Failed to draw lottery' });
//     } finally {
//       client.release();
//     }
//   }

//   // ADMIN: UPDATE DISBURSEMENT CONFIG
//   async updateDisbursementConfig(req, res) {
//     try {
//       const adminId = req.user.userId;
//       const { config_key, config_value } = req.body;

//       if (!['AUTO_DISBURSE_THRESHOLD', 'LARGE_AMOUNT_THRESHOLD', 'MAX_AUTO_DISBURSE_DAILY'].includes(config_key)) {
//         return res.status(400).json({ error: 'Invalid config key' });
//       }

//       await pool.query(
//         `UPDATE votteryy_disbursement_config 
//          SET config_value = $1, updated_at = CURRENT_TIMESTAMP, updated_by = $2
//          WHERE config_key = $3`,
//         [config_value, adminId, config_key]
//       );

//       DISBURSEMENT_CONFIG[config_key] = parseFloat(config_value);

//       res.json({ success: true, message: 'Configuration updated', config: DISBURSEMENT_CONFIG });

//     } catch (error) {
//       console.error('❌ Update config error:', error);
//       res.status(500).json({ error: 'Failed to update configuration' });
//     }
//   }

//   // ADMIN: GET DISBURSEMENT CONFIG
//   async getDisbursementConfig(req, res) {
//     try {
//       const result = await pool.query(
//         `SELECT * FROM votteryy_disbursement_config ORDER BY config_key`
//       );

//       res.json({ config: result.rows, current: DISBURSEMENT_CONFIG });

//     } catch (error) {
//       console.error('❌ Get config error:', error);
//       res.status(500).json({ error: 'Failed to get configuration' });
//     }
//   }
// }

// export default new LotteryController();
// import pool from '../config/database.js';
// import rngService from '../services/rng.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';

// class LotteryController {

//   // Get lottery info for election
//   async getLotteryInfo(req, res) {
//     try {
//       const { electionId } = req.params;

//       console.log(`🎰 Getting lottery info for election ${electionId}`);

//       const result = await pool.query(
//         `SELECT 
//            lottery_enabled,
//            lottery_prize_funding_source,
//            lottery_reward_type,
//            lottery_total_prize_pool,
//            lottery_prize_description,
//            lottery_estimated_value,
//            lottery_projected_revenue,
//            lottery_revenue_share_percentage,
//            lottery_winner_count,
//            lottery_prize_distribution
//          FROM votteryyy_elections
//          WHERE id = $1`,
//         [electionId]
//       );

//       if (result.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = result.rows[0];

//       if (!election.lottery_enabled) {
//         return res.json({ lotteryEnabled: false });
//       }

//       // Get participant count
//       const participantResult = await pool.query(
//         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//         [electionId]
//       );

//       const participantCount = parseInt(participantResult.rows[0].count || 0);

//       // ✅ FIX: Check if lottery has been drawn - use draw_id instead of draw_time
//       const drawResult = await pool.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//         [electionId]
//       );

//       const hasBeenDrawn = drawResult.rows.length > 0;
//       let winners = [];

//       console.log(`✅ Lottery draw check for election ${electionId}: hasBeenDrawn=${hasBeenDrawn}`);

//       if (hasBeenDrawn) {
//         // ✅ FIX: Cast user_id to integer using CAST() function, remove username column
//         const winnersResult = await pool.query(
//           `SELECT 
//              lw.winner_id,
//              lw.user_id,
//              lw.rank,
//              lw.prize_amount,
//              lw.prize_percentage,
//              lw.prize_description,
//              lw.prize_type,
//              lw.claimed,
//              lw.claimed_at,
//              lt.ball_number,
//              lt.ticket_number,
//              CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_name,
//              CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as full_name,
//              ud.first_name,
//              ud.last_name
//            FROM votteryy_lottery_winners lw
//            LEFT JOIN votteryy_user_details ud ON CAST(lw.user_id AS INTEGER) = ud.user_id
//            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//            WHERE lw.election_id = $1
//            ORDER BY lw.rank ASC`,
//           [electionId]
//         );

//         winners = winnersResult.rows.map(w => ({
//           id: w.winner_id,
//           winner_id: w.winner_id,
//           user_id: w.user_id,
//           rank: w.rank,
//           prize_amount: w.prize_amount,
//           prize_percentage: w.prize_percentage,
//           prize_description: w.prize_description,
//           prize_type: w.prize_type,
//           claimed: w.claimed,
//           claimed_at: w.claimed_at,
//           ball_number: w.ball_number,
//           ticket_number: w.ticket_number,
//           winner_name: w.winner_name?.trim() || `User #${w.user_id}`,
//           full_name: w.full_name?.trim() || `User #${w.user_id}`,
//           first_name: w.first_name,
//           last_name: w.last_name,
//         }));

//         console.log(`✅ Found ${winners.length} winners for election ${electionId}:`, winners);
//       }

//       const response = {
//         lotteryEnabled: true,
//         lottery_enabled: true,
//         hasBeenDrawn,
//         has_been_drawn: hasBeenDrawn,
//         rewardType: election.lottery_reward_type,
//         reward_type: election.lottery_reward_type,
//         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
//         total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
//         prizeDescription: election.lottery_prize_description,
//         prize_description: election.lottery_prize_description,
//         estimatedValue: parseFloat(election.lottery_estimated_value || 0),
//         estimated_value: parseFloat(election.lottery_estimated_value || 0),
//         projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
//         projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
//         revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
//         revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
//         winnerCount: winners.length > 0 ? winners.length : election.lottery_winner_count,
//         winner_count: winners.length > 0 ? winners.length : election.lottery_winner_count,
//         prizeDistribution: election.lottery_prize_distribution || [],
//         prize_distribution: election.lottery_prize_distribution || [],
//         participantCount,
//         participant_count: participantCount,
//         winners: winners,
//       };

//       console.log(`📊 Lottery response for election ${electionId}:`, JSON.stringify(response, null, 2));

//       res.json(response);

//     } catch (error) {
//       console.error('Get lottery info error:', error);
//       res.status(500).json({ error: 'Failed to retrieve lottery information' });
//     }
//   }

//   // Auto-draw lottery (cron job trigger)
// async autoDrawLottery(electionId) {
//   const client = await pool.connect();
//   try {
//     await client.query('BEGIN');

//     console.log(`🎰 Auto-draw started for election ${electionId}`);

//     // Get election
//     const electionResult = await client.query(
//       `SELECT * FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       throw new Error('Election not found');
//     }

//     const election = electionResult.rows[0];
//     const now = new Date();
//     const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//     if (now < endDate) {
//       throw new Error('Election not yet ended');
//     }

//     if (!election.lottery_enabled) {
//       throw new Error('Lottery not enabled');
//     }

//     // Check if already drawn
//     const existingDraw = await client.query(
//       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
//       [electionId]
//     );

//     if (existingDraw.rows.length > 0) {
//       throw new Error('Lottery already drawn');
//     }

//     // Select winners
//     const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
//       await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

//     if (winners.length === 0) {
//       throw new Error('No participants found for lottery');
//     }

//     // Record lottery draw
//     const drawResult = await client.query(
//       `INSERT INTO votteryy_lottery_draws
//        (election_id, total_participants, winner_count, random_seed, status, metadata)
//        VALUES ($1, $2, $3, $4, $5, $6)
//        RETURNING draw_id`,
//       [
//         electionId,
//         totalParticipants,
//         winners.length,
//         randomSeed,
//         'completed',
//         JSON.stringify({ prizeDistribution, totalPrizePool, autoDrawn: true })
//       ]
//     );

//     const drawId = drawResult.rows[0].draw_id;

//     // Calculate prizes and record winners
//     const prizeDistArray = prizeDistribution || [];
//     const winnerRecords = [];

//     for (let i = 0; i < winners.length; i++) {
//       const winner = winners[i];
//       const rank = i + 1;

//       let prizeAmount = 0;
//       let prizePercentage = 0;

//       if (rewardType === 'monetary' && prizeDistArray.length > 0) {
//         const distEntry = prizeDistArray.find(d => d.rank === rank);
//         if (distEntry) {
//           prizePercentage = distEntry.percentage;
//           prizeAmount = (totalPrizePool * prizePercentage) / 100;
//         } else {
//           prizeAmount = totalPrizePool / winners.length;
//           prizePercentage = 100 / winners.length;
//         }
//       }

//       const winnerResult = await client.query(
//         `INSERT INTO votteryy_lottery_winners
//          (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//          RETURNING *`,
//         [
//           electionId,
//           winner.user_id,
//           winner.ticket_id,
//           rank,
//           prizeAmount,
//           prizePercentage,
//           election.lottery_prize_description,
//           rewardType,
//           false
//         ]
//       );

//       winnerRecords.push(winnerResult.rows[0]);

//       // Credit wallet for monetary prizes
//       if (rewardType === 'monetary' && prizeAmount > 0) {
//         await client.query(
//           `INSERT INTO votteryy_user_wallets (user_id, balance)
//            VALUES ($1, $2)
//            ON CONFLICT (user_id)
//            DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
//           [winner.user_id, prizeAmount]
//         );

//         await client.query(
//           `INSERT INTO votteryy_wallet_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [
//             winner.user_id,
//             'prize_won',
//             prizeAmount,
//             electionId,
//             'success',
//             `Auto Lottery Prize - Rank ${rank}`
//           ]
//         );
//       }

//       // Send notification
//       try {
//   const userResult = await client.query(
//   `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
//   [winner.user_id]
// );

// if (userResult.rows.length > 0) {
//   const user = userResult.rows[0];
//   const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
//   const prizeText = rewardType === 'monetary' 
//     ? `$${prizeAmount.toFixed(2)}`
//     : election.lottery_prize_description;

//   // Log winner (email notification disabled until email column added)
//   console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
  
//   // TODO: Enable when email is added to votteryy_user_details
//   // await notificationService.sendLotteryWinnerNotification(
//   //   user.email,
//   //   fullName,
//   //   election.title,
//   //   prizeText,
//   //   rank
//   // );
// }
//       } catch (emailError) {
//         console.error('Winner notification error:', emailError);
//       }
//     }

//     // Log audit (pass null for req since it's auto-draw)
//     await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, null);

//     await client.query('COMMIT');

//     console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
//     return { success: true, drawId, winners: winnerRecords };

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error);
//     throw error;
//   } finally {
//     client.release();
//   }
// }
//   // Get user's lottery ticket
//   async getUserTicket(req, res) {
//     try {
//       const { electionId } = req.params;
//       const userId = req.user.userId;

//       // FIX: Use votteryyy_lottery_tickets (3 y's)
//       const result = await pool.query(
//         `SELECT * FROM votteryy_lottery_tickets
//          WHERE user_id = $1 AND election_id = $2`,
//         [userId, electionId]
//       );

//       //  Don't return 404, return empty state
//       if (result.rows.length === 0) {
//         return res.json({
//           hasTicket: false,
//           has_ticket: false,
//           ticket: null,
//           message: 'No lottery ticket found. Vote to participate.'
//         });
//       }

//       const ticket = result.rows[0];

//       res.json({
//         hasTicket: true,
//         has_ticket: true,
//         ticket: {
//           id: ticket.ticket_id,
//           ticket_id: ticket.ticket_id,
//           ticketId: ticket.ticket_id,
//           ticket_number: ticket.ticket_number,
//           ticketNumber: ticket.ticket_number,
//           ball_number: ticket.ball_number,
//           ballNumber: ticket.ball_number,
//           user_id: ticket.user_id,
//           userId: ticket.user_id,
//           election_id: ticket.election_id,
//           electionId: ticket.election_id,
//           created_at: ticket.created_at,
//           createdAt: ticket.created_at,
//         }
//       });

//     } catch (error) {
//       console.error('Get user ticket error:', error);
//       res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
//     }
//   }

//   // Get all lottery participants

// async getLotteryParticipants(req, res) {
//   try {
//     const { electionId } = req.params;

//     console.log('🔍 Fetching participants for election:', electionId);

//     // ✅ FIX: Correct column names and type casting
//     const result = await pool.query(
//       `SELECT 
//          lt.ticket_id,
//          lt.ticket_number,
//          lt.ball_number,
//          lt.user_id,
//          lt.created_at,
//          ud.first_name,
//          ud.last_name,
//          CONCAT(ud.first_name, ' ', ud.last_name) as full_name
//        FROM votteryy_lottery_tickets lt
//        LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
//        WHERE lt.election_id = $1
//        ORDER BY lt.created_at ASC`,
//       [electionId]
//     );

//     console.log('✅ Found participants:', result.rows.length);

//     const participants = result.rows.map(p => ({
//       id: p.ticket_id,
//       ticket_id: p.ticket_id,
//       ticket_number: p.ticket_number,
//       ticketNumber: p.ticket_number,
//       ball_number: p.ball_number,
//       ballNumber: p.ball_number,
//       user_id: p.user_id,
//       userId: p.user_id,
//       full_name: p.full_name,
//       fullName: p.full_name,
//       first_name: p.first_name,
//       lastName: p.last_name,
//       created_at: p.created_at,
//       createdAt: p.created_at,
//     }));

//     res.json({
//       participants,
//       count: participants.length,
//       totalCount: participants.length,
//     });

//   } catch (error) {
//     console.error('Get lottery participants error:', error);
//     res.status(500).json({ error: 'Failed to retrieve lottery participants' });
//   }
// }


//   // Draw lottery (manual trigger - admin only)
//   async drawLottery(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { electionId } = req.params;
//       const adminId = req.user.userId;

//       // Verify admin role
//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required ' });
//       }

//       // Get election
//       const electionResult = await client.query(
//         `SELECT * FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];

//       if (!election.lottery_enabled) {
//         return res.status(400).json({ error: 'Lottery not enabled for this election' });
//       }

//       // FIX: Use votteryyy_lottery_draws (3 y's)
//       const existingDrawResult = await client.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
//         [electionId]
//       );

//       if (existingDrawResult.rows.length > 0) {
//         return res.status(400).json({ error: 'Lottery already drawn for this election' });
//       }

//       // Select winners
//       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
//         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

//       if (winners.length === 0) {
//         return res.status(400).json({ error: 'No participants found for lottery' });
//       }

//       // Record lottery draw
//       const drawResult = await client.query(
//         `INSERT INTO votteryy_lottery_draws
//          (election_id, total_participants, winner_count, random_seed, status, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6)
//          RETURNING draw_id`,
//         [
//           electionId,
//           totalParticipants,
//           winners.length,
//           randomSeed,
//           'completed',
//           JSON.stringify({ prizeDistribution, totalPrizePool })
//         ]
//       );

//       const drawId = drawResult.rows[0].draw_id;

//       // Calculate prizes and record winners
//       const prizeDistArray = prizeDistribution || [];
//       const winnerRecords = [];

//       for (let i = 0; i < winners.length; i++) {
//         const winner = winners[i];
//         const rank = i + 1;

//         // Calculate prize amount based on distribution
//         let prizeAmount = 0;
//         let prizePercentage = 0;

//         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
//           const distEntry = prizeDistArray.find(d => d.rank === rank);
//           if (distEntry) {
//             prizePercentage = distEntry.percentage;
//             prizeAmount = (totalPrizePool * prizePercentage) / 100;
//           } else {
//             // Equal distribution if not specified
//             prizeAmount = totalPrizePool / winners.length;
//             prizePercentage = 100 / winners.length;
//           }
//         }

//         const winnerResult = await client.query(
//           `INSERT INTO votteryy_lottery_winners
//            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             electionId,
//             winner.user_id,
//             winner.ticket_id,
//             rank,
//             prizeAmount,
//             prizePercentage,
//             election.lottery_prize_description,
//             rewardType,
//             false
//           ]
//         );

//         winnerRecords.push(winnerResult.rows[0]);

//         // Credit wallet for monetary prizes
//         if (rewardType === 'monetary' && prizeAmount > 0) {
//           await client.query(
//             `INSERT INTO votteryy_user_wallets (user_id, balance)
//              VALUES ($1, $2)
//              ON CONFLICT (user_id)
//              DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
//             [winner.user_id, prizeAmount]
//           );

//           await client.query(
//             `INSERT INTO votteryy_wallet_transactions
//              (user_id, transaction_type, amount, election_id, status, description)
//              VALUES ($1, $2, $3, $4, $5, $6)`,
//             [
//               winner.user_id,
//               'prize_won',
//               prizeAmount,
//               electionId,
//               'success',
//               `Lottery prize - Rank ${rank}`
//             ]
//           );
//         }

//         // Send notification
//         try {
//           const userResult = await client.query(
//             `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
//             [winner.user_id]
//           );

//           if (userResult.rows.length > 0) {
//             const user = userResult.rows[0];
//             const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
//             const prizeText = rewardType === 'monetary' 
//               ? `$${prizeAmount.toFixed(2)}`
//               : election.lottery_prize_description;

//             // Log winner (email notification disabled until email column added)
//             console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
            
//             // TODO: Enable when email is added to votteryy_user_details
//             // await notificationService.sendLotteryWinnerNotification(
//             //   user.email,
//             //   fullName,
//             //   election.title,
//             //   prizeText,
//             //   rank
//             // );
//           }
//         } catch (emailError) {
//           console.error('Winner notification error:', emailError);
//         }
//       }

//       // Log audit
//       await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

//       await client.query('COMMIT');

//       res.json({
//         success: true,
//         drawId,
//         totalParticipants,
//         winners: winnerRecords,
//         randomSeed
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Draw lottery error:', error);
//       res.status(500).json({ error: 'Failed to draw lottery' });
//     } finally {
//       client.release();
//     }
//   }

//   // Auto-draw lottery (cron job trigger)
//   async autoDrawLottery(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Check if election ended
//       const electionResult = await client.query(
//         `SELECT * FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const election = electionResult.rows[0];
//       const now = new Date();
//       const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//       if (now < endDate) {
//         throw new Error('Election not yet ended');
//       }

//       if (!election.lottery_enabled) {
//         throw new Error('Lottery not enabled');
//       }

//       // ✅ FIX: Use votteryyy_lottery_draws (3 y's)
//       const existingDraw = await client.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
//         [electionId]
//       );

//       if (existingDraw.rows.length > 0) {
//         throw new Error('Lottery already drawn');
//       }

//       // Execute draw (same logic as manual draw)
//       const { winners, randomSeed, totalParticipants } = 
//         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

//       // Record draw and winners (same as manual)
//       // ... (similar implementation as drawLottery method)

//       await client.query('COMMIT');

//       console.log(`✅ Auto-drew lottery for election ${electionId}`);

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error(`Auto-draw lottery error for election ${electionId}:`, error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Claim lottery prize
//   async claimPrize(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { winnerId } = req.params;
//       const userId = req.user.userId;

//       const winnerResult = await client.query(
//         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
//         [winnerId]
//       );

//       if (winnerResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Winner record not found' });
//       }

//       const winner = winnerResult.rows[0];

//       if (winner.user_id !== userId) {
//         return res.status(403).json({ error: 'Unauthorized' });
//       }

//       if (winner.claimed) {
//         return res.status(400).json({ error: 'Prize already claimed' });
//       }

//       // Mark as claimed
//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET claimed = true, claimed_at = CURRENT_TIMESTAMP
//          WHERE winner_id = $1`,
//         [winnerId]
//       );

//       await client.query('COMMIT');

//       res.json({ success: true, message: 'Prize claimed successfully' });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Claim prize error:', error);
//       res.status(500).json({ error: 'Failed to claim prize' });
//     } finally {
//       client.release();
//     }
//   }
// }

// export default new LotteryController();
// // import pool from '../config/database.js';
// // import rngService from '../services/rng.service.js';
// // import auditService from '../services/audit.service.js';
// // import notificationService from '../services/notification.service.js';

// // class LotteryController {

// //   // Get lottery info for election
// //   async getLotteryInfo(req, res) {
// //     try {
// //       const { electionId } = req.params;

// //       console.log(`🎰 Getting lottery info for election ${electionId}`);

// //       const result = await pool.query(
// //         `SELECT 
// //            lottery_enabled,
// //            lottery_prize_funding_source,
// //            lottery_reward_type,
// //            lottery_total_prize_pool,
// //            lottery_prize_description,
// //            lottery_estimated_value,
// //            lottery_projected_revenue,
// //            lottery_revenue_share_percentage,
// //            lottery_winner_count,
// //            lottery_prize_distribution
// //          FROM votteryyy_elections
// //          WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (result.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = result.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.json({ lotteryEnabled: false });
// //       }

// //       // Get participant count
// //       const participantResult = await pool.query(
// //         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       const participantCount = parseInt(participantResult.rows[0].count || 0);

// //       // ✅ FIX: Check if lottery has been drawn - use draw_id instead of draw_time
// //       const drawResult = await pool.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
// //         [electionId]
// //       );

// //       const hasBeenDrawn = drawResult.rows.length > 0;
// //       let winners = [];

// //       console.log(`✅ Lottery draw check for election ${electionId}: hasBeenDrawn=${hasBeenDrawn}`);

// //       if (hasBeenDrawn) {
// //         // ✅ FIX: Cast user_id to integer using CAST() function
// //         const winnersResult = await pool.query(
// //           `SELECT 
// //              lw.winner_id,
// //              lw.user_id,
// //              lw.rank,
// //              lw.prize_amount,
// //              lw.prize_percentage,
// //              lw.prize_description,
// //              lw.prize_type,
// //              lw.claimed,
// //              lw.claimed_at,
// //              lt.ball_number,
// //              lt.ticket_number,
// //              CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_name,
// //              CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as full_name,
// //              ud.username,
// //              ud.first_name,
// //              ud.last_name
// //            FROM votteryy_lottery_winners lw
// //            LEFT JOIN votteryy_user_details ud ON CAST(lw.user_id AS INTEGER) = ud.user_id
// //            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
// //            WHERE lw.election_id = $1
// //            ORDER BY lw.rank ASC`,
// //           [electionId]
// //         );

// //         winners = winnersResult.rows.map(w => ({
// //           id: w.winner_id,
// //           winner_id: w.winner_id,
// //           user_id: w.user_id,
// //           rank: w.rank,
// //           prize_amount: w.prize_amount,
// //           prize_percentage: w.prize_percentage,
// //           prize_description: w.prize_description,
// //           prize_type: w.prize_type,
// //           claimed: w.claimed,
// //           claimed_at: w.claimed_at,
// //           ball_number: w.ball_number,
// //           ticket_number: w.ticket_number,
// //           winner_name: w.winner_name?.trim() || `User #${w.user_id}`,
// //           full_name: w.full_name?.trim() || `User #${w.user_id}`,
// //           username: w.username,
// //           first_name: w.first_name,
// //           last_name: w.last_name,
// //         }));

// //         console.log(`✅ Found ${winners.length} winners for election ${electionId}`);
// //       }

// //       const response = {
// //         lotteryEnabled: true,
// //         lottery_enabled: true,
// //         hasBeenDrawn,
// //         has_been_drawn: hasBeenDrawn,
// //         rewardType: election.lottery_reward_type,
// //         reward_type: election.lottery_reward_type,
// //         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
// //         total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
// //         prizeDescription: election.lottery_prize_description,
// //         prize_description: election.lottery_prize_description,
// //         estimatedValue: parseFloat(election.lottery_estimated_value || 0),
// //         estimated_value: parseFloat(election.lottery_estimated_value || 0),
// //         projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
// //         projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
// //         revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         winnerCount: winners.length > 0 ? winners.length : election.lottery_winner_count,
// //         winner_count: winners.length > 0 ? winners.length : election.lottery_winner_count,
// //         prizeDistribution: election.lottery_prize_distribution || [],
// //         prize_distribution: election.lottery_prize_distribution || [],
// //         participantCount,
// //         participant_count: participantCount,
// //         winners: winners,
// //       };

// //       console.log(`📊 Lottery response for election ${electionId}:`, JSON.stringify(response, null, 2));

// //       res.json(response);

// //     } catch (error) {
// //       console.error('Get lottery info error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery information' });
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// // async autoDrawLottery(electionId) {
// //   const client = await pool.connect();
// //   try {
// //     await client.query('BEGIN');

// //     console.log(`🎰 Auto-draw started for election ${electionId}`);

// //     // Get election
// //     const electionResult = await client.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       throw new Error('Election not found');
// //     }

// //     const election = electionResult.rows[0];
// //     const now = new Date();
// //     const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //     if (now < endDate) {
// //       throw new Error('Election not yet ended');
// //     }

// //     if (!election.lottery_enabled) {
// //       throw new Error('Lottery not enabled');
// //     }

// //     // Check if already drawn
// //     const existingDraw = await client.query(
// //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //       [electionId]
// //     );

// //     if (existingDraw.rows.length > 0) {
// //       throw new Error('Lottery already drawn');
// //     }

// //     // Select winners
// //     const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //       await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //     if (winners.length === 0) {
// //       throw new Error('No participants found for lottery');
// //     }

// //     // Record lottery draw
// //     const drawResult = await client.query(
// //       `INSERT INTO votteryy_lottery_draws
// //        (election_id, total_participants, winner_count, random_seed, status, metadata)
// //        VALUES ($1, $2, $3, $4, $5, $6)
// //        RETURNING draw_id`,
// //       [
// //         electionId,
// //         totalParticipants,
// //         winners.length,
// //         randomSeed,
// //         'completed',
// //         JSON.stringify({ prizeDistribution, totalPrizePool, autoDrawn: true })
// //       ]
// //     );

// //     const drawId = drawResult.rows[0].draw_id;

// //     // Calculate prizes and record winners
// //     const prizeDistArray = prizeDistribution || [];
// //     const winnerRecords = [];

// //     for (let i = 0; i < winners.length; i++) {
// //       const winner = winners[i];
// //       const rank = i + 1;

// //       let prizeAmount = 0;
// //       let prizePercentage = 0;

// //       if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //         const distEntry = prizeDistArray.find(d => d.rank === rank);
// //         if (distEntry) {
// //           prizePercentage = distEntry.percentage;
// //           prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //         } else {
// //           prizeAmount = totalPrizePool / winners.length;
// //           prizePercentage = 100 / winners.length;
// //         }
// //       }

// //       const winnerResult = await client.query(
// //         `INSERT INTO votteryy_lottery_winners
// //          (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //          RETURNING *`,
// //         [
// //           electionId,
// //           winner.user_id,
// //           winner.ticket_id,
// //           rank,
// //           prizeAmount,
// //           prizePercentage,
// //           election.lottery_prize_description,
// //           rewardType,
// //           false
// //         ]
// //       );

// //       winnerRecords.push(winnerResult.rows[0]);

// //       // Credit wallet for monetary prizes
// //       if (rewardType === 'monetary' && prizeAmount > 0) {
// //         await client.query(
// //           `INSERT INTO votteryy_user_wallets (user_id, balance)
// //            VALUES ($1, $2)
// //            ON CONFLICT (user_id)
// //            DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //           [winner.user_id, prizeAmount]
// //         );

// //         await client.query(
// //           `INSERT INTO votteryy_wallet_transactions
// //            (user_id, transaction_type, amount, election_id, status, description)
// //            VALUES ($1, $2, $3, $4, $5, $6)`,
// //           [
// //             winner.user_id,
// //             'prize_won',
// //             prizeAmount,
// //             electionId,
// //             'success',
// //             `Auto Lottery Prize - Rank ${rank}`
// //           ]
// //         );
// //       }

// //       // Send notification
// //       try {
// //   const userResult = await client.query(
// //   `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
// //   [winner.user_id]
// // );

// // if (userResult.rows.length > 0) {
// //   const user = userResult.rows[0];
// //   const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
// //   const prizeText = rewardType === 'monetary' 
// //     ? `$${prizeAmount.toFixed(2)}`
// //     : election.lottery_prize_description;

// //   // Log winner (email notification disabled until email column added)
// //   console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
  
// //   // TODO: Enable when email is added to votteryy_user_details
// //   // await notificationService.sendLotteryWinnerNotification(
// //   //   user.email,
// //   //   fullName,
// //   //   election.title,
// //   //   prizeText,
// //   //   rank
// //   // );
// // }
// //       } catch (emailError) {
// //         console.error('Winner notification error:', emailError);
// //       }
// //     }

// //     // Log audit (pass null for req since it's auto-draw)
// //     await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, null);

// //     await client.query('COMMIT');

// //     console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
// //     return { success: true, drawId, winners: winnerRecords };

// //   } catch (error) {
// //     await client.query('ROLLBACK');
// //     console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error);
// //     throw error;
// //   } finally {
// //     client.release();
// //   }
// // }
// //   // Get user's lottery ticket
// //   async getUserTicket(req, res) {
// //     try {
// //       const { electionId } = req.params;
// //       const userId = req.user.userId;

// //       // FIX: Use votteryyy_lottery_tickets (3 y's)
// //       const result = await pool.query(
// //         `SELECT * FROM votteryy_lottery_tickets
// //          WHERE user_id = $1 AND election_id = $2`,
// //         [userId, electionId]
// //       );

// //       //  Don't return 404, return empty state
// //       if (result.rows.length === 0) {
// //         return res.json({
// //           hasTicket: false,
// //           has_ticket: false,
// //           ticket: null,
// //           message: 'No lottery ticket found. Vote to participate.'
// //         });
// //       }

// //       const ticket = result.rows[0];

// //       res.json({
// //         hasTicket: true,
// //         has_ticket: true,
// //         ticket: {
// //           id: ticket.ticket_id,
// //           ticket_id: ticket.ticket_id,
// //           ticketId: ticket.ticket_id,
// //           ticket_number: ticket.ticket_number,
// //           ticketNumber: ticket.ticket_number,
// //           ball_number: ticket.ball_number,
// //           ballNumber: ticket.ball_number,
// //           user_id: ticket.user_id,
// //           userId: ticket.user_id,
// //           election_id: ticket.election_id,
// //           electionId: ticket.election_id,
// //           created_at: ticket.created_at,
// //           createdAt: ticket.created_at,
// //         }
// //       });

// //     } catch (error) {
// //       console.error('Get user ticket error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
// //     }
// //   }

// //   // Get all lottery participants

// // async getLotteryParticipants(req, res) {
// //   try {
// //     const { electionId } = req.params;

// //     console.log('🔍 Fetching participants for election:', electionId);

// //     // ✅ FIX: Correct column names and type casting
// //     const result = await pool.query(
// //       `SELECT 
// //          lt.ticket_id,
// //          lt.ticket_number,
// //          lt.ball_number,
// //          lt.user_id,
// //          lt.created_at,
// //          ud.first_name,
// //          ud.last_name,
// //          CONCAT(ud.first_name, ' ', ud.last_name) as full_name
// //        FROM votteryy_lottery_tickets lt
// //        LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
// //        WHERE lt.election_id = $1
// //        ORDER BY lt.created_at ASC`,
// //       [electionId]
// //     );

// //     console.log('✅ Found participants:', result.rows.length);

// //     const participants = result.rows.map(p => ({
// //       id: p.ticket_id,
// //       ticket_id: p.ticket_id,
// //       ticket_number: p.ticket_number,
// //       ticketNumber: p.ticket_number,
// //       ball_number: p.ball_number,
// //       ballNumber: p.ball_number,
// //       user_id: p.user_id,
// //       userId: p.user_id,
// //       full_name: p.full_name,
// //       fullName: p.full_name,
// //       first_name: p.first_name,
// //       lastName: p.last_name,
// //       created_at: p.created_at,
// //       createdAt: p.created_at,
// //     }));

// //     res.json({
// //       participants,
// //       count: participants.length,
// //       totalCount: participants.length,
// //     });

// //   } catch (error) {
// //     console.error('Get lottery participants error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery participants' });
// //   }
// // }


// //   // Draw lottery (manual trigger - admin only)
// //   async drawLottery(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { electionId } = req.params;
// //       const adminId = req.user.userId;

// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required ' });
// //       }

// //       // Get election
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.status(400).json({ error: 'Lottery not enabled for this election' });
// //       }

// //       // FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDrawResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDrawResult.rows.length > 0) {
// //         return res.status(400).json({ error: 'Lottery already drawn for this election' });
// //       }

// //       // Select winners
// //       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       if (winners.length === 0) {
// //         return res.status(400).json({ error: 'No participants found for lottery' });
// //       }

// //       // Record lottery draw
// //       const drawResult = await client.query(
// //         `INSERT INTO votteryy_lottery_draws
// //          (election_id, total_participants, winner_count, random_seed, status, metadata)
// //          VALUES ($1, $2, $3, $4, $5, $6)
// //          RETURNING draw_id`,
// //         [
// //           electionId,
// //           totalParticipants,
// //           winners.length,
// //           randomSeed,
// //           'completed',
// //           JSON.stringify({ prizeDistribution, totalPrizePool })
// //         ]
// //       );

// //       const drawId = drawResult.rows[0].draw_id;

// //       // Calculate prizes and record winners
// //       const prizeDistArray = prizeDistribution || [];
// //       const winnerRecords = [];

// //       for (let i = 0; i < winners.length; i++) {
// //         const winner = winners[i];
// //         const rank = i + 1;

// //         // Calculate prize amount based on distribution
// //         let prizeAmount = 0;
// //         let prizePercentage = 0;

// //         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //           const distEntry = prizeDistArray.find(d => d.rank === rank);
// //           if (distEntry) {
// //             prizePercentage = distEntry.percentage;
// //             prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //           } else {
// //             // Equal distribution if not specified
// //             prizeAmount = totalPrizePool / winners.length;
// //             prizePercentage = 100 / winners.length;
// //           }
// //         }

// //         const winnerResult = await client.query(
// //           `INSERT INTO votteryy_lottery_winners
// //            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //            RETURNING *`,
// //           [
// //             electionId,
// //             winner.user_id,
// //             winner.ticket_id,
// //             rank,
// //             prizeAmount,
// //             prizePercentage,
// //             election.lottery_prize_description,
// //             rewardType,
// //             false
// //           ]
// //         );

// //         winnerRecords.push(winnerResult.rows[0]);

// //         // Credit wallet for monetary prizes
// //         if (rewardType === 'monetary' && prizeAmount > 0) {
// //           await client.query(
// //             `INSERT INTO votteryy_user_wallets (user_id, balance)
// //              VALUES ($1, $2)
// //              ON CONFLICT (user_id)
// //              DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //             [winner.user_id, prizeAmount]
// //           );

// //           await client.query(
// //             `INSERT INTO votteryy_wallet_transactions
// //              (user_id, transaction_type, amount, election_id, status, description)
// //              VALUES ($1, $2, $3, $4, $5, $6)`,
// //             [
// //               winner.user_id,
// //               'prize_won',
// //               prizeAmount,
// //               electionId,
// //               'success',
// //               `Lottery prize - Rank ${rank}`
// //             ]
// //           );
// //         }

// //         // Send notification
// //         try {
// //           const userResult = await client.query(
// //             `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
// //             [winner.user_id]
// //           );

// //           if (userResult.rows.length > 0) {
// //             const user = userResult.rows[0];
// //             const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
// //             const prizeText = rewardType === 'monetary' 
// //               ? `$${prizeAmount.toFixed(2)}`
// //               : election.lottery_prize_description;

// //             // Log winner (email notification disabled until email column added)
// //             console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
            
// //             // TODO: Enable when email is added to votteryy_user_details
// //             // await notificationService.sendLotteryWinnerNotification(
// //             //   user.email,
// //             //   fullName,
// //             //   election.title,
// //             //   prizeText,
// //             //   rank
// //             // );
// //           }
// //         } catch (emailError) {
// //           console.error('Winner notification error:', emailError);
// //         }
// //       }

// //       // Log audit
// //       await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

// //       await client.query('COMMIT');

// //       res.json({
// //         success: true,
// //         drawId,
// //         totalParticipants,
// //         winners: winnerRecords,
// //         randomSeed
// //       });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Draw lottery error:', error);
// //       res.status(500).json({ error: 'Failed to draw lottery' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// //   async autoDrawLottery(electionId) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Check if election ended
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         throw new Error('Election not found');
// //       }

// //       const election = electionResult.rows[0];
// //       const now = new Date();
// //       const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //       if (now < endDate) {
// //         throw new Error('Election not yet ended');
// //       }

// //       if (!election.lottery_enabled) {
// //         throw new Error('Lottery not enabled');
// //       }

// //       // ✅ FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDraw = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDraw.rows.length > 0) {
// //         throw new Error('Lottery already drawn');
// //       }

// //       // Execute draw (same logic as manual draw)
// //       const { winners, randomSeed, totalParticipants } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       // Record draw and winners (same as manual)
// //       // ... (similar implementation as drawLottery method)

// //       await client.query('COMMIT');

// //       console.log(`✅ Auto-drew lottery for election ${electionId}`);

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error(`Auto-draw lottery error for election ${electionId}:`, error);
// //       throw error;
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Claim lottery prize
// //   async claimPrize(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { winnerId } = req.params;
// //       const userId = req.user.userId;

// //       const winnerResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       if (winnerResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Winner record not found' });
// //       }

// //       const winner = winnerResult.rows[0];

// //       if (winner.user_id !== userId) {
// //         return res.status(403).json({ error: 'Unauthorized' });
// //       }

// //       if (winner.claimed) {
// //         return res.status(400).json({ error: 'Prize already claimed' });
// //       }

// //       // Mark as claimed
// //       await client.query(
// //         `UPDATE votteryy_lottery_winners
// //          SET claimed = true, claimed_at = CURRENT_TIMESTAMP
// //          WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       await client.query('COMMIT');

// //       res.json({ success: true, message: 'Prize claimed successfully' });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Claim prize error:', error);
// //       res.status(500).json({ error: 'Failed to claim prize' });
// //     } finally {
// //       client.release();
// //     }
// //   }
// // }

// // export default new LotteryController();
// // import pool from '../config/database.js';
// // import rngService from '../services/rng.service.js';
// // import auditService from '../services/audit.service.js';
// // import notificationService from '../services/notification.service.js';

// // class LotteryController {

// //   // Get lottery info for election
// //   async getLotteryInfo(req, res) {
// //     try {
// //       const { electionId } = req.params;

// //       const result = await pool.query(
// //         `SELECT 
// //            lottery_enabled,
// //            lottery_prize_funding_source,
// //            lottery_reward_type,
// //            lottery_total_prize_pool,
// //            lottery_prize_description,
// //            lottery_estimated_value,
// //            lottery_projected_revenue,
// //            lottery_revenue_share_percentage,
// //            lottery_winner_count,
// //            lottery_prize_distribution
// //          FROM votteryyy_elections
// //          WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (result.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = result.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.json({ lotteryEnabled: false });
// //       }

// //       //  FIX: Use votteryyy_lottery_tickets (3 y's)
// //       const participantResult = await pool.query(
// //         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       const participantCount = parseInt(participantResult.rows[0].count || 0);

// //       //  FIX: Use votteryyy_lottery_draws (3 y's)
// //       const drawResult = await pool.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
// //         [electionId]
// //       );

// //       const hasBeenDrawn = drawResult.rows.length > 0;
// //       let winners = [];

// //       if (hasBeenDrawn) {
// //         const winnersResult = await pool.query(
// //           `SELECT 
// //              lw.winner_id as id,
// //              lw.user_id,
// //              lw.rank,
// //              lw.prize_amount,
// //              lw.claimed,
// //              lt.ball_number,
// //              ud.full_name as winner_name,
// //              ud.username
// //            FROM votteryy_lottery_winners lw
// //            LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
// //            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
// //            WHERE lw.election_id = $1
// //            ORDER BY lw.rank ASC`,
// //           [electionId]
// //         );

// //         winners = winnersResult.rows;
// //       }

// //       res.json({
// //         lotteryEnabled: true,
// //         lottery_enabled: true,
// //         hasBeenDrawn,
// //         has_been_drawn: hasBeenDrawn,
// //         rewardType: election.lottery_reward_type,
// //         reward_type: election.lottery_reward_type,
// //         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
// //         total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
// //         prizeDescription: election.lottery_prize_description,
// //         prize_description: election.lottery_prize_description,
// //         estimatedValue: parseFloat(election.lottery_estimated_value || 0),
// //         estimated_value: parseFloat(election.lottery_estimated_value || 0),
// //         projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
// //         projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
// //         revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         winnerCount: election.lottery_winner_count,
// //         winner_count: election.lottery_winner_count,
// //         prizeDistribution: election.lottery_prize_distribution || [],
// //         prize_distribution: election.lottery_prize_distribution || [],
// //         participantCount,
// //         participant_count: participantCount,
// //         winners: hasBeenDrawn ? winners : [],
// //       });

// //     } catch (error) {
// //       console.error('Get lottery info error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery information' });
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// // async autoDrawLottery(electionId) {
// //   const client = await pool.connect();
// //   try {
// //     await client.query('BEGIN');

// //     console.log(`🎰 Auto-draw started for election ${electionId}`);

// //     // Get election
// //     const electionResult = await client.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       throw new Error('Election not found');
// //     }

// //     const election = electionResult.rows[0];
// //     const now = new Date();
// //     const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //     if (now < endDate) {
// //       throw new Error('Election not yet ended');
// //     }

// //     if (!election.lottery_enabled) {
// //       throw new Error('Lottery not enabled');
// //     }

// //     // Check if already drawn
// //     const existingDraw = await client.query(
// //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //       [electionId]
// //     );

// //     if (existingDraw.rows.length > 0) {
// //       throw new Error('Lottery already drawn');
// //     }

// //     // Select winners
// //     const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //       await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //     if (winners.length === 0) {
// //       throw new Error('No participants found for lottery');
// //     }

// //     // Record lottery draw
// //     const drawResult = await client.query(
// //       `INSERT INTO votteryy_lottery_draws
// //        (election_id, total_participants, winner_count, random_seed, status, metadata)
// //        VALUES ($1, $2, $3, $4, $5, $6)
// //        RETURNING draw_id`,
// //       [
// //         electionId,
// //         totalParticipants,
// //         winners.length,
// //         randomSeed,
// //         'completed',
// //         JSON.stringify({ prizeDistribution, totalPrizePool, autoDrawn: true })
// //       ]
// //     );

// //     const drawId = drawResult.rows[0].draw_id;

// //     // Calculate prizes and record winners
// //     const prizeDistArray = prizeDistribution || [];
// //     const winnerRecords = [];

// //     for (let i = 0; i < winners.length; i++) {
// //       const winner = winners[i];
// //       const rank = i + 1;

// //       let prizeAmount = 0;
// //       let prizePercentage = 0;

// //       if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //         const distEntry = prizeDistArray.find(d => d.rank === rank);
// //         if (distEntry) {
// //           prizePercentage = distEntry.percentage;
// //           prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //         } else {
// //           prizeAmount = totalPrizePool / winners.length;
// //           prizePercentage = 100 / winners.length;
// //         }
// //       }

// //       const winnerResult = await client.query(
// //         `INSERT INTO votteryy_lottery_winners
// //          (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //          RETURNING *`,
// //         [
// //           electionId,
// //           winner.user_id,
// //           winner.ticket_id,
// //           rank,
// //           prizeAmount,
// //           prizePercentage,
// //           election.lottery_prize_description,
// //           rewardType,
// //           false
// //         ]
// //       );

// //       winnerRecords.push(winnerResult.rows[0]);

// //       // Credit wallet for monetary prizes
// //       if (rewardType === 'monetary' && prizeAmount > 0) {
// //         await client.query(
// //           `INSERT INTO votteryy_user_wallets (user_id, balance)
// //            VALUES ($1, $2)
// //            ON CONFLICT (user_id)
// //            DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //           [winner.user_id, prizeAmount]
// //         );

// //         await client.query(
// //           `INSERT INTO votteryy_wallet_transactions
// //            (user_id, transaction_type, amount, election_id, status, description)
// //            VALUES ($1, $2, $3, $4, $5, $6)`,
// //           [
// //             winner.user_id,
// //             'prize_won',
// //             prizeAmount,
// //             electionId,
// //             'success',
// //             `Auto Lottery Prize - Rank ${rank}`
// //           ]
// //         );
// //       }

// //       // Send notification
// //       try {
// //   const userResult = await client.query(
// //   `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
// //   [winner.user_id]
// // );

// // if (userResult.rows.length > 0) {
// //   const user = userResult.rows[0];
// //   const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
// //   const prizeText = rewardType === 'monetary' 
// //     ? `$${prizeAmount.toFixed(2)}`
// //     : election.lottery_prize_description;

// //   // Log winner (email notification disabled until email column added)
// //   console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
  
// //   // TODO: Enable when email is added to votteryy_user_details
// //   // await notificationService.sendLotteryWinnerNotification(
// //   //   user.email,
// //   //   fullName,
// //   //   election.title,
// //   //   prizeText,
// //   //   rank
// //   // );
// // }
// //       } catch (emailError) {
// //         console.error('Winner notification error:', emailError);
// //       }
// //     }

// //     // Log audit (pass null for req since it's auto-draw)
// //     await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, null);

// //     await client.query('COMMIT');

// //     console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
// //     return { success: true, drawId, winners: winnerRecords };

// //   } catch (error) {
// //     await client.query('ROLLBACK');
// //     console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error);
// //     throw error;
// //   } finally {
// //     client.release();
// //   }
// // }
// //   // Get user's lottery ticket
// //   async getUserTicket(req, res) {
// //     try {
// //       const { electionId } = req.params;
// //       const userId = req.user.userId;

// //       // FIX: Use votteryyy_lottery_tickets (3 y's)
// //       const result = await pool.query(
// //         `SELECT * FROM votteryy_lottery_tickets
// //          WHERE user_id = $1 AND election_id = $2`,
// //         [userId, electionId]
// //       );

// //       //  Don't return 404, return empty state
// //       if (result.rows.length === 0) {
// //         return res.json({
// //           hasTicket: false,
// //           has_ticket: false,
// //           ticket: null,
// //           message: 'No lottery ticket found. Vote to participate.'
// //         });
// //       }

// //       const ticket = result.rows[0];

// //       res.json({
// //         hasTicket: true,
// //         has_ticket: true,
// //         ticket: {
// //           id: ticket.ticket_id,
// //           ticket_id: ticket.ticket_id,
// //           ticketId: ticket.ticket_id,
// //           ticket_number: ticket.ticket_number,
// //           ticketNumber: ticket.ticket_number,
// //           ball_number: ticket.ball_number,
// //           ballNumber: ticket.ball_number,
// //           user_id: ticket.user_id,
// //           userId: ticket.user_id,
// //           election_id: ticket.election_id,
// //           electionId: ticket.election_id,
// //           created_at: ticket.created_at,
// //           createdAt: ticket.created_at,
// //         }
// //       });

// //     } catch (error) {
// //       console.error('Get user ticket error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
// //     }
// //   }

// //   // Get all lottery participants

// // async getLotteryParticipants(req, res) {
// //   try {
// //     const { electionId } = req.params;

// //     console.log('🔍 Fetching participants for election:', electionId);

// //     // ✅ FIX: Correct column names and type casting
// //     const result = await pool.query(
// //       `SELECT 
// //          lt.ticket_id,
// //          lt.ticket_number,
// //          lt.ball_number,
// //          lt.user_id,
// //          lt.created_at,
// //          ud.first_name,
// //          ud.last_name,
// //          CONCAT(ud.first_name, ' ', ud.last_name) as full_name
// //        FROM votteryy_lottery_tickets lt
// //        LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
// //        WHERE lt.election_id = $1
// //        ORDER BY lt.created_at ASC`,
// //       [electionId]
// //     );

// //     console.log('✅ Found participants:', result.rows.length);

// //     const participants = result.rows.map(p => ({
// //       id: p.ticket_id,
// //       ticket_id: p.ticket_id,
// //       ticket_number: p.ticket_number,
// //       ticketNumber: p.ticket_number,
// //       ball_number: p.ball_number,
// //       ballNumber: p.ball_number,
// //       user_id: p.user_id,
// //       userId: p.user_id,
// //       full_name: p.full_name,
// //       fullName: p.full_name,
// //       first_name: p.first_name,
// //       lastName: p.last_name,
// //       created_at: p.created_at,
// //       createdAt: p.created_at,
// //     }));

// //     res.json({
// //       participants,
// //       count: participants.length,
// //       totalCount: participants.length,
// //     });

// //   } catch (error) {
// //     console.error('Get lottery participants error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery participants' });
// //   }
// // }


// //   // Draw lottery (manual trigger - admin only)
// //   async drawLottery(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { electionId } = req.params;
// //       const adminId = req.user.userId;

// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required ' });
// //       }

// //       // Get election
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.status(400).json({ error: 'Lottery not enabled for this election' });
// //       }

// //       // FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDrawResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDrawResult.rows.length > 0) {
// //         return res.status(400).json({ error: 'Lottery already drawn for this election' });
// //       }

// //       // Select winners
// //       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       if (winners.length === 0) {
// //         return res.status(400).json({ error: 'No participants found for lottery' });
// //       }

// //       // Record lottery draw
// //       const drawResult = await client.query(
// //         `INSERT INTO votteryy_lottery_draws
// //          (election_id, total_participants, winner_count, random_seed, status, metadata)
// //          VALUES ($1, $2, $3, $4, $5, $6)
// //          RETURNING draw_id`,
// //         [
// //           electionId,
// //           totalParticipants,
// //           winners.length,
// //           randomSeed,
// //           'completed',
// //           JSON.stringify({ prizeDistribution, totalPrizePool })
// //         ]
// //       );

// //       const drawId = drawResult.rows[0].draw_id;

// //       // Calculate prizes and record winners
// //       const prizeDistArray = prizeDistribution || [];
// //       const winnerRecords = [];

// //       for (let i = 0; i < winners.length; i++) {
// //         const winner = winners[i];
// //         const rank = i + 1;

// //         // Calculate prize amount based on distribution
// //         let prizeAmount = 0;
// //         let prizePercentage = 0;

// //         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //           const distEntry = prizeDistArray.find(d => d.rank === rank);
// //           if (distEntry) {
// //             prizePercentage = distEntry.percentage;
// //             prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //           } else {
// //             // Equal distribution if not specified
// //             prizeAmount = totalPrizePool / winners.length;
// //             prizePercentage = 100 / winners.length;
// //           }
// //         }

// //         const winnerResult = await client.query(
// //           `INSERT INTO votteryy_lottery_winners
// //            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //            RETURNING *`,
// //           [
// //             electionId,
// //             winner.user_id,
// //             winner.ticket_id,
// //             rank,
// //             prizeAmount,
// //             prizePercentage,
// //             election.lottery_prize_description,
// //             rewardType,
// //             false
// //           ]
// //         );

// //         winnerRecords.push(winnerResult.rows[0]);

// //         // Credit wallet for monetary prizes
// //         if (rewardType === 'monetary' && prizeAmount > 0) {
// //           await client.query(
// //             `INSERT INTO votteryy_user_wallets (user_id, balance)
// //              VALUES ($1, $2)
// //              ON CONFLICT (user_id)
// //              DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //             [winner.user_id, prizeAmount]
// //           );

// //           await client.query(
// //             `INSERT INTO votteryy_wallet_transactions
// //              (user_id, transaction_type, amount, election_id, status, description)
// //              VALUES ($1, $2, $3, $4, $5, $6)`,
// //             [
// //               winner.user_id,
// //               'prize_won',
// //               prizeAmount,
// //               electionId,
// //               'success',
// //               `Lottery prize - Rank ${rank}`
// //             ]
// //           );
// //         }

// //         // Send notification
// //         try {
// //           const userResult = await client.query(
// //             `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
// //             [winner.user_id]
// //           );

// //           if (userResult.rows.length > 0) {
// //             const user = userResult.rows[0];
// //             const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
// //             const prizeText = rewardType === 'monetary' 
// //               ? `$${prizeAmount.toFixed(2)}`
// //               : election.lottery_prize_description;

// //             // Log winner (email notification disabled until email column added)
// //             console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
            
// //             // TODO: Enable when email is added to votteryy_user_details
// //             // await notificationService.sendLotteryWinnerNotification(
// //             //   user.email,
// //             //   fullName,
// //             //   election.title,
// //             //   prizeText,
// //             //   rank
// //             // );
// //           }
// //         } catch (emailError) {
// //           console.error('Winner notification error:', emailError);
// //         }
// //       }

// //       // Log audit
// //       await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

// //       await client.query('COMMIT');

// //       res.json({
// //         success: true,
// //         drawId,
// //         totalParticipants,
// //         winners: winnerRecords,
// //         randomSeed
// //       });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Draw lottery error:', error);
// //       res.status(500).json({ error: 'Failed to draw lottery' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// //   async autoDrawLottery(electionId) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Check if election ended
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         throw new Error('Election not found');
// //       }

// //       const election = electionResult.rows[0];
// //       const now = new Date();
// //       const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //       if (now < endDate) {
// //         throw new Error('Election not yet ended');
// //       }

// //       if (!election.lottery_enabled) {
// //         throw new Error('Lottery not enabled');
// //       }

// //       // ✅ FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDraw = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDraw.rows.length > 0) {
// //         throw new Error('Lottery already drawn');
// //       }

// //       // Execute draw (same logic as manual draw)
// //       const { winners, randomSeed, totalParticipants } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       // Record draw and winners (same as manual)
// //       // ... (similar implementation as drawLottery method)

// //       await client.query('COMMIT');

// //       console.log(`✅ Auto-drew lottery for election ${electionId}`);

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error(`Auto-draw lottery error for election ${electionId}:`, error);
// //       throw error;
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Claim lottery prize
// //   async claimPrize(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { winnerId } = req.params;
// //       const userId = req.user.userId;

// //       const winnerResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       if (winnerResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Winner record not found' });
// //       }

// //       const winner = winnerResult.rows[0];

// //       if (winner.user_id !== userId) {
// //         return res.status(403).json({ error: 'Unauthorized' });
// //       }

// //       if (winner.claimed) {
// //         return res.status(400).json({ error: 'Prize already claimed' });
// //       }

// //       // Mark as claimed
// //       await client.query(
// //         `UPDATE votteryy_lottery_winners
// //          SET claimed = true, claimed_at = CURRENT_TIMESTAMP
// //          WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       await client.query('COMMIT');

// //       res.json({ success: true, message: 'Prize claimed successfully' });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Claim prize error:', error);
// //       res.status(500).json({ error: 'Failed to claim prize' });
// //     } finally {
// //       client.release();
// //     }
// //   }
// // }

// // export default new LotteryController();
// // import pool from '../config/database.js';
// // import rngService from '../services/rng.service.js';
// // import auditService from '../services/audit.service.js';
// // import notificationService from '../services/notification.service.js';

// // class LotteryController {

// //   // Get lottery info for election
// //   async getLotteryInfo(req, res) {
// //     try {
// //       const { electionId } = req.params;

// //       const result = await pool.query(
// //         `SELECT 
// //            lottery_enabled,
// //            lottery_prize_funding_source,
// //            lottery_reward_type,
// //            lottery_total_prize_pool,
// //            lottery_prize_description,
// //            lottery_estimated_value,
// //            lottery_projected_revenue,
// //            lottery_revenue_share_percentage,
// //            lottery_winner_count,
// //            lottery_prize_distribution
// //          FROM votteryyy_elections
// //          WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (result.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = result.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.json({ lotteryEnabled: false });
// //       }

// //       //  FIX: Use votteryyy_lottery_tickets (3 y's)
// //       const participantResult = await pool.query(
// //         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       const participantCount = parseInt(participantResult.rows[0].count || 0);

// //       //  FIX: Use votteryyy_lottery_draws (3 y's)
// //       const drawResult = await pool.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
// //         [electionId]
// //       );

// //       const hasBeenDrawn = drawResult.rows.length > 0;
// //       let winners = [];

// //       if (hasBeenDrawn) {
// //         const winnersResult = await pool.query(
// //           `SELECT 
// //              lw.winner_id as id,
// //              lw.user_id,
// //              lw.rank,
// //              lw.prize_amount,
// //              lw.claimed,
// //              lt.ball_number,
// //              ud.full_name as winner_name,
// //              ud.username
// //            FROM votteryy_lottery_winners lw
// //            LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
// //            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
// //            WHERE lw.election_id = $1
// //            ORDER BY lw.rank ASC`,
// //           [electionId]
// //         );

// //         winners = winnersResult.rows;
// //       }

// //       res.json({
// //         lotteryEnabled: true,
// //         lottery_enabled: true,
// //         hasBeenDrawn,
// //         has_been_drawn: hasBeenDrawn,
// //         rewardType: election.lottery_reward_type,
// //         reward_type: election.lottery_reward_type,
// //         totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
// //         total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
// //         prizeDescription: election.lottery_prize_description,
// //         prize_description: election.lottery_prize_description,
// //         estimatedValue: parseFloat(election.lottery_estimated_value || 0),
// //         estimated_value: parseFloat(election.lottery_estimated_value || 0),
// //         projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
// //         projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
// //         revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //         winnerCount: election.lottery_winner_count,
// //         winner_count: election.lottery_winner_count,
// //         prizeDistribution: election.lottery_prize_distribution || [],
// //         prize_distribution: election.lottery_prize_distribution || [],
// //         participantCount,
// //         participant_count: participantCount,
// //         winners: hasBeenDrawn ? winners : [],
// //       });

// //     } catch (error) {
// //       console.error('Get lottery info error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery information' });
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// // async autoDrawLottery(electionId) {
// //   const client = await pool.connect();
// //   try {
// //     await client.query('BEGIN');

// //     console.log(`🎰 Auto-draw started for election ${electionId}`);

// //     // Get election
// //     const electionResult = await client.query(
// //       `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (electionResult.rows.length === 0) {
// //       throw new Error('Election not found');
// //     }

// //     const election = electionResult.rows[0];
// //     const now = new Date();
// //     const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //     if (now < endDate) {
// //       throw new Error('Election not yet ended');
// //     }

// //     if (!election.lottery_enabled) {
// //       throw new Error('Lottery not enabled');
// //     }

// //     // Check if already drawn
// //     const existingDraw = await client.query(
// //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //       [electionId]
// //     );

// //     if (existingDraw.rows.length > 0) {
// //       throw new Error('Lottery already drawn');
// //     }

// //     // Select winners
// //     const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //       await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //     if (winners.length === 0) {
// //       throw new Error('No participants found for lottery');
// //     }

// //     // Record lottery draw
// //     const drawResult = await client.query(
// //       `INSERT INTO votteryy_lottery_draws
// //        (election_id, total_participants, winner_count, random_seed, status, metadata)
// //        VALUES ($1, $2, $3, $4, $5, $6)
// //        RETURNING draw_id`,
// //       [
// //         electionId,
// //         totalParticipants,
// //         winners.length,
// //         randomSeed,
// //         'completed',
// //         JSON.stringify({ prizeDistribution, totalPrizePool, autoDrawn: true })
// //       ]
// //     );

// //     const drawId = drawResult.rows[0].draw_id;

// //     // Calculate prizes and record winners
// //     const prizeDistArray = prizeDistribution || [];
// //     const winnerRecords = [];

// //     for (let i = 0; i < winners.length; i++) {
// //       const winner = winners[i];
// //       const rank = i + 1;

// //       let prizeAmount = 0;
// //       let prizePercentage = 0;

// //       if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //         const distEntry = prizeDistArray.find(d => d.rank === rank);
// //         if (distEntry) {
// //           prizePercentage = distEntry.percentage;
// //           prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //         } else {
// //           prizeAmount = totalPrizePool / winners.length;
// //           prizePercentage = 100 / winners.length;
// //         }
// //       }

// //       const winnerResult = await client.query(
// //         `INSERT INTO votteryy_lottery_winners
// //          (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //          RETURNING *`,
// //         [
// //           electionId,
// //           winner.user_id,
// //           winner.ticket_id,
// //           rank,
// //           prizeAmount,
// //           prizePercentage,
// //           election.lottery_prize_description,
// //           rewardType,
// //           false
// //         ]
// //       );

// //       winnerRecords.push(winnerResult.rows[0]);

// //       // Credit wallet for monetary prizes
// //       if (rewardType === 'monetary' && prizeAmount > 0) {
// //         await client.query(
// //           `INSERT INTO votteryy_user_wallets (user_id, balance)
// //            VALUES ($1, $2)
// //            ON CONFLICT (user_id)
// //            DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //           [winner.user_id, prizeAmount]
// //         );

// //         await client.query(
// //           `INSERT INTO votteryy_wallet_transactions
// //            (user_id, transaction_type, amount, election_id, status, description)
// //            VALUES ($1, $2, $3, $4, $5, $6)`,
// //           [
// //             winner.user_id,
// //             'prize_won',
// //             prizeAmount,
// //             electionId,
// //             'success',
// //             `Auto Lottery Prize - Rank ${rank}`
// //           ]
// //         );
// //       }

// //       // Send notification
// //       try {
// //   const userResult = await client.query(
// //   `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
// //   [winner.user_id]
// // );

// // if (userResult.rows.length > 0) {
// //   const user = userResult.rows[0];
// //   const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
// //   const prizeText = rewardType === 'monetary' 
// //     ? `$${prizeAmount.toFixed(2)}`
// //     : election.lottery_prize_description;

// //   // Log winner (email notification disabled until email column added)
// //   console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
  
// //   // TODO: Enable when email is added to votteryy_user_details
// //   // await notificationService.sendLotteryWinnerNotification(
// //   //   user.email,
// //   //   fullName,
// //   //   election.title,
// //   //   prizeText,
// //   //   rank
// //   // );
// // }
// //       } catch (emailError) {
// //         console.error('Winner notification error:', emailError);
// //       }
// //     }

// //     // Log audit (pass null for req since it's auto-draw)
// //     await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, null);

// //     await client.query('COMMIT');

// //     console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
// //     return { success: true, drawId, winners: winnerRecords };

// //   } catch (error) {
// //     await client.query('ROLLBACK');
// //     console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error);
// //     throw error;
// //   } finally {
// //     client.release();
// //   }
// // }
// //   // Get user's lottery ticket
// //   async getUserTicket(req, res) {
// //     try {
// //       const { electionId } = req.params;
// //       const userId = req.user.userId;

// //       // FIX: Use votteryyy_lottery_tickets (3 y's)
// //       const result = await pool.query(
// //         `SELECT * FROM votteryy_lottery_tickets
// //          WHERE user_id = $1 AND election_id = $2`,
// //         [userId, electionId]
// //       );

// //       //  Don't return 404, return empty state
// //       if (result.rows.length === 0) {
// //         return res.json({
// //           hasTicket: false,
// //           has_ticket: false,
// //           ticket: null,
// //           message: 'No lottery ticket found. Vote to participate.'
// //         });
// //       }

// //       const ticket = result.rows[0];

// //       res.json({
// //         hasTicket: true,
// //         has_ticket: true,
// //         ticket: {
// //           id: ticket.ticket_id,
// //           ticket_id: ticket.ticket_id,
// //           ticketId: ticket.ticket_id,
// //           ticket_number: ticket.ticket_number,
// //           ticketNumber: ticket.ticket_number,
// //           ball_number: ticket.ball_number,
// //           ballNumber: ticket.ball_number,
// //           user_id: ticket.user_id,
// //           userId: ticket.user_id,
// //           election_id: ticket.election_id,
// //           electionId: ticket.election_id,
// //           created_at: ticket.created_at,
// //           createdAt: ticket.created_at,
// //         }
// //       });

// //     } catch (error) {
// //       console.error('Get user ticket error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
// //     }
// //   }

// //   // Get all lottery participants

// // async getLotteryParticipants(req, res) {
// //   try {
// //     const { electionId } = req.params;

// //     console.log('🔍 Fetching participants for election:', electionId);

// //     // ✅ FIX: Correct column names and type casting
// //     const result = await pool.query(
// //       `SELECT 
// //          lt.ticket_id,
// //          lt.ticket_number,
// //          lt.ball_number,
// //          lt.user_id,
// //          lt.created_at,
// //          ud.first_name,
// //          ud.last_name,
// //          CONCAT(ud.first_name, ' ', ud.last_name) as full_name
// //        FROM votteryy_lottery_tickets lt
// //        LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
// //        WHERE lt.election_id = $1
// //        ORDER BY lt.created_at ASC`,
// //       [electionId]
// //     );

// //     console.log('✅ Found participants:', result.rows.length);

// //     const participants = result.rows.map(p => ({
// //       id: p.ticket_id,
// //       ticket_id: p.ticket_id,
// //       ticket_number: p.ticket_number,
// //       ticketNumber: p.ticket_number,
// //       ball_number: p.ball_number,
// //       ballNumber: p.ball_number,
// //       user_id: p.user_id,
// //       userId: p.user_id,
// //       full_name: p.full_name,
// //       fullName: p.full_name,
// //       first_name: p.first_name,
// //       lastName: p.last_name,
// //       created_at: p.created_at,
// //       createdAt: p.created_at,
// //     }));

// //     res.json({
// //       participants,
// //       count: participants.length,
// //       totalCount: participants.length,
// //     });

// //   } catch (error) {
// //     console.error('Get lottery participants error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery participants' });
// //   }
// // }


// //   // Draw lottery (manual trigger - admin only)
// //   async drawLottery(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { electionId } = req.params;
// //       const adminId = req.user.userId;

// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required ' });
// //       }

// //       // Get election
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.status(400).json({ error: 'Lottery not enabled for this election' });
// //       }

// //       // FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDrawResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDrawResult.rows.length > 0) {
// //         return res.status(400).json({ error: 'Lottery already drawn for this election' });
// //       }

// //       // Select winners
// //       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       if (winners.length === 0) {
// //         return res.status(400).json({ error: 'No participants found for lottery' });
// //       }

// //       // Record lottery draw
// //       const drawResult = await client.query(
// //         `INSERT INTO votteryy_lottery_draws
// //          (election_id, total_participants, winner_count, random_seed, status, metadata)
// //          VALUES ($1, $2, $3, $4, $5, $6)
// //          RETURNING draw_id`,
// //         [
// //           electionId,
// //           totalParticipants,
// //           winners.length,
// //           randomSeed,
// //           'completed',
// //           JSON.stringify({ prizeDistribution, totalPrizePool })
// //         ]
// //       );

// //       const drawId = drawResult.rows[0].draw_id;

// //       // Calculate prizes and record winners
// //       const prizeDistArray = prizeDistribution || [];
// //       const winnerRecords = [];

// //       for (let i = 0; i < winners.length; i++) {
// //         const winner = winners[i];
// //         const rank = i + 1;

// //         // Calculate prize amount based on distribution
// //         let prizeAmount = 0;
// //         let prizePercentage = 0;

// //         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //           const distEntry = prizeDistArray.find(d => d.rank === rank);
// //           if (distEntry) {
// //             prizePercentage = distEntry.percentage;
// //             prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //           } else {
// //             // Equal distribution if not specified
// //             prizeAmount = totalPrizePool / winners.length;
// //             prizePercentage = 100 / winners.length;
// //           }
// //         }

// //         const winnerResult = await client.query(
// //           `INSERT INTO votteryy_lottery_winners
// //            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //            RETURNING *`,
// //           [
// //             electionId,
// //             winner.user_id,
// //             winner.ticket_id,
// //             rank,
// //             prizeAmount,
// //             prizePercentage,
// //             election.lottery_prize_description,
// //             rewardType,
// //             false
// //           ]
// //         );

// //         winnerRecords.push(winnerResult.rows[0]);

// //         // Credit wallet for monetary prizes
// //         if (rewardType === 'monetary' && prizeAmount > 0) {
// //           await client.query(
// //             `INSERT INTO votteryy_user_wallets (user_id, balance)
// //              VALUES ($1, $2)
// //              ON CONFLICT (user_id)
// //              DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //             [winner.user_id, prizeAmount]
// //           );

// //           await client.query(
// //             `INSERT INTO votteryy_wallet_transactions
// //              (user_id, transaction_type, amount, election_id, status, description)
// //              VALUES ($1, $2, $3, $4, $5, $6)`,
// //             [
// //               winner.user_id,
// //               'prize_won',
// //               prizeAmount,
// //               electionId,
// //               'success',
// //               `Lottery prize - Rank ${rank}`
// //             ]
// //           );
// //         }

// //         // Send notification
// //         try {
// //           const userResult = await client.query(
// //             `SELECT email, full_name FROM votteryy_user_details WHERE user_id = $1`,
// //             [winner.user_id]
// //           );

// //           if (userResult.rows.length > 0) {
// //             const user = userResult.rows[0];
// //             const prizeText = rewardType === 'monetary' 
// //               ? `$${prizeAmount.toFixed(2)}`
// //               : election.lottery_prize_description;

// //             await notificationService.sendLotteryWinnerNotification(
// //               user.email,
// //               user.full_name,
// //               election.title,
// //               prizeText,
// //               rank
// //             );
// //           }
// //         } catch (emailError) {
// //           console.error('Winner notification error:', emailError);
// //         }
// //       }

// //       // Log audit
// //       await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

// //       await client.query('COMMIT');

// //       res.json({
// //         success: true,
// //         drawId,
// //         totalParticipants,
// //         winners: winnerRecords,
// //         randomSeed
// //       });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Draw lottery error:', error);
// //       res.status(500).json({ error: 'Failed to draw lottery' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// //   async autoDrawLottery(electionId) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Check if election ended
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         throw new Error('Election not found');
// //       }

// //       const election = electionResult.rows[0];
// //       const now = new Date();
// //       const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //       if (now < endDate) {
// //         throw new Error('Election not yet ended');
// //       }

// //       if (!election.lottery_enabled) {
// //         throw new Error('Lottery not enabled');
// //       }

// //       // ✅ FIX: Use votteryyy_lottery_draws (3 y's)
// //       const existingDraw = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDraw.rows.length > 0) {
// //         throw new Error('Lottery already drawn');
// //       }

// //       // Execute draw (same logic as manual draw)
// //       const { winners, randomSeed, totalParticipants } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       // Record draw and winners (same as manual)
// //       // ... (similar implementation as drawLottery method)

// //       await client.query('COMMIT');

// //       console.log(`✅ Auto-drew lottery for election ${electionId}`);

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error(`Auto-draw lottery error for election ${electionId}:`, error);
// //       throw error;
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Claim lottery prize
// //   async claimPrize(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { winnerId } = req.params;
// //       const userId = req.user.userId;

// //       const winnerResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       if (winnerResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Winner record not found' });
// //       }

// //       const winner = winnerResult.rows[0];

// //       if (winner.user_id !== userId) {
// //         return res.status(403).json({ error: 'Unauthorized' });
// //       }

// //       if (winner.claimed) {
// //         return res.status(400).json({ error: 'Prize already claimed' });
// //       }

// //       // Mark as claimed
// //       await client.query(
// //         `UPDATE votteryy_lottery_winners
// //          SET claimed = true, claimed_at = CURRENT_TIMESTAMP
// //          WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       await client.query('COMMIT');

// //       res.json({ success: true, message: 'Prize claimed successfully' });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Claim prize error:', error);
// //       res.status(500).json({ error: 'Failed to claim prize' });
// //     } finally {
// //       client.release();
// //     }
// //   }
// // }

// // export default new LotteryController();
// // import pool from '../config/database.js';
// // import rngService from '../services/rng.service.js';
// // import auditService from '../services/audit.service.js';
// // import notificationService from '../services/notification.service.js';

// // class LotteryController {

// //   // Get lottery info for election
// //   async getLotteryInfo(req, res) {
// //   try {
// //     const { electionId } = req.params;

// //     const result = await pool.query(
// //       `SELECT 
// //          lottery_enabled,
// //          lottery_prize_funding_source,
// //          lottery_reward_type,
// //          lottery_total_prize_pool,
// //          lottery_prize_description,
// //          lottery_estimated_value,
// //          lottery_projected_revenue,
// //          lottery_revenue_share_percentage,
// //          lottery_winner_count,
// //          lottery_prize_distribution
// //        FROM votteryyy_elections
// //        WHERE id = $1`,
// //       [electionId]
// //     );

// //     if (result.rows.length === 0) {
// //       return res.status(404).json({ error: 'Election not found' });
// //     }

// //     const election = result.rows[0];

// //     if (!election.lottery_enabled) {
// //       return res.json({ lotteryEnabled: false });
// //     }

// //     // Get participant count
// //     const participantResult = await pool.query(
// //       `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
// //       [electionId]
// //     );

// //     const participantCount = parseInt(participantResult.rows[0].count || 0);

// //     // Check if lottery has been drawn
// //     const drawResult = await pool.query(
// //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
// //       [electionId]
// //     );

// //     const hasBeenDrawn = drawResult.rows.length > 0;
// //     let winners = [];

// //     if (hasBeenDrawn) {
// //       const winnersResult = await pool.query(
// //         `SELECT 
// //            lw.winner_id as id,
// //            lw.user_id,
// //            lw.rank,
// //            lw.prize_amount,
// //            lw.claimed,
// //            lt.ball_number,
// //            ud.full_name as winner_name,
// //            ud.username
// //          FROM votteryy_lottery_winners lw
// //          LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
// //          LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
// //          WHERE lw.election_id = $1
// //          ORDER BY lw.rank ASC`,
// //         [electionId]
// //       );

// //       winners = winnersResult.rows;
// //     }

// //     res.json({
// //       lotteryEnabled: true,
// //       lottery_enabled: true,
// //       hasBeenDrawn,
// //       has_been_drawn: hasBeenDrawn,
// //       rewardType: election.lottery_reward_type,
// //       reward_type: election.lottery_reward_type,
// //       totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
// //       total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
// //       prizeDescription: election.lottery_prize_description,
// //       prize_description: election.lottery_prize_description,
// //       estimatedValue: parseFloat(election.lottery_estimated_value || 0),
// //       estimated_value: parseFloat(election.lottery_estimated_value || 0),
// //       projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
// //       projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
// //       revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //       revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
// //       winnerCount: election.lottery_winner_count,
// //       winner_count: election.lottery_winner_count,
// //       prizeDistribution: election.lottery_prize_distribution || [],
// //       prize_distribution: election.lottery_prize_distribution || [],
// //       participantCount,
// //       participant_count: participantCount,
// //       winners: hasBeenDrawn ? winners : [],
// //     });

// //   } catch (error) {
// //     console.error('Get lottery info error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery information' });
// //   }
// // }
// //   // async getLotteryInfo(req, res) {
// //   //   try {
// //   //     const { electionId } = req.params;

// //   //     const result = await pool.query(
// //   //       `SELECT 
// //   //          lottery_enabled,
// //   //          lottery_prize_funding_source,
// //   //          lottery_reward_type,
// //   //          lottery_total_prize_pool,
// //   //          lottery_prize_description,
// //   //          lottery_estimated_value,
// //   //          lottery_projected_revenue,
// //   //          lottery_revenue_share_percentage,
// //   //          lottery_winner_count,
// //   //          lottery_prize_distribution
// //   //        FROM votteryyy_elections
// //   //        WHERE id = $1`,
// //   //       [electionId]
// //   //     );

// //   //     if (result.rows.length === 0) {
// //   //       return res.status(404).json({ error: 'Election not found' });
// //   //     }

// //   //     const election = result.rows[0];

// //   //     if (!election.lottery_enabled) {
// //   //       return res.json({ lotteryEnabled: false });
// //   //     }

// //   //     // Get participant count
// //   //     const participantResult = await pool.query(
// //   //       `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
// //   //       [electionId]
// //   //     );

// //   //     const participantCount = parseInt(participantResult.rows[0].count);

// //   //     // Check if lottery has been drawn
// //   //     const drawResult = await pool.query(
// //   //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
// //   //       [electionId]
// //   //     );

// //   //     const hasBeenDrawn = drawResult.rows.length > 0;
// //   //     let winners = [];

// //   //     if (hasBeenDrawn) {
// //   //       const winnersResult = await pool.query(
// //   //         `SELECT 
// //   //            lw.*,
// //   //            ud.full_name,
// //   //            ud.email
// //   //          FROM votteryy_lottery_winners lw
// //   //          LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
// //   //          WHERE lw.election_id = $1
// //   //          ORDER BY lw.rank ASC`,
// //   //         [electionId]
// //   //       );

// //   //       winners = winnersResult.rows;
// //   //     }

// //   //     res.json({
// //   //       lotteryEnabled: true,
// //   //       rewardType: election.lottery_reward_type,
// //   //       totalPrizePool: parseFloat(election.lottery_total_prize_pool),
// //   //       prizeDescription: election.lottery_prize_description,
// //   //       estimatedValue: parseFloat(election.lottery_estimated_value),
// //   //       projectedRevenue: parseFloat(election.lottery_projected_revenue),
// //   //       revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage),
// //   //       winnerCount: election.lottery_winner_count,
// //   //       prizeDistribution: election.lottery_prize_distribution,
// //   //       participantCount,
// //   //       hasBeenDrawn,
// //   //       winners: hasBeenDrawn ? winners : null
// //   //     });

// //   //   } catch (error) {
// //   //     console.error('Get lottery info error:', error);
// //   //     res.status(500).json({ error: 'Failed to retrieve lottery information' });
// //   //   }
// //   // }

// //   // Get user's lottery ticket

// //   async getUserTicket(req, res) {
// //   try {
// //     const { electionId } = req.params;
// //     const userId = req.user.userId;

// //     const result = await pool.query(
// //       `SELECT * FROM votteryy_lottery_tickets
// //        WHERE user_id = $1 AND election_id = $2`,
// //       [userId, electionId]
// //     );

// //     // ✅ Don't return 404, return empty state
// //     if (result.rows.length === 0) {
// //       return res.json({
// //         hasTicket: false,
// //         has_ticket: false,
// //         ticket: null,
// //         message: 'No lottery ticket found. Vote to participate.'
// //       });
// //     }

// //     const ticket = result.rows[0];

// //     res.json({
// //       hasTicket: true,
// //       has_ticket: true,
// //       ticket: {
// //         id: ticket.ticket_id,
// //         ticket_id: ticket.ticket_id,
// //         ticketId: ticket.ticket_id,
// //         ticket_number: ticket.ticket_number,
// //         ticketNumber: ticket.ticket_number,
// //         ball_number: ticket.ball_number,
// //         ballNumber: ticket.ball_number,
// //         user_id: ticket.user_id,
// //         userId: ticket.user_id,
// //         election_id: ticket.election_id,
// //         electionId: ticket.election_id,
// //         created_at: ticket.created_at,
// //         createdAt: ticket.created_at,
// //       }
// //     });

// //   } catch (error) {
// //     console.error('Get user ticket error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
// //   }
// // }
// //   // async getUserTicket(req, res) {
// //   //   try {
// //   //     const { electionId } = req.params;
// //   //     const userId = req.user.userId;

// //   //     const result = await pool.query(
// //   //       `SELECT * FROM votteryy_lottery_tickets
// //   //        WHERE user_id = $1 AND election_id = $2`,
// //   //       [userId, electionId]
// //   //     );

// //   //     if (result.rows.length === 0) {
// //   //       return res.status(404).json({ error: 'No lottery ticket found. You must vote to participate.' });
// //   //     }

// //   //     res.json(result.rows[0]);

// //   //   } catch (error) {
// //   //     console.error('Get user ticket error:', error);
// //   //     res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
// //   //   }
// //   // }

// //   // Draw lottery (manual trigger - admin only)
// //   async drawLottery(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { electionId } = req.params;
// //       const adminId = req.user.userId;

// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required' });
// //       }

// //       // Get election
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];

// //       if (!election.lottery_enabled) {
// //         return res.status(400).json({ error: 'Lottery not enabled for this election' });
// //       }

// //       // Check if already drawn
// //       const existingDrawResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDrawResult.rows.length > 0) {
// //         return res.status(400).json({ error: 'Lottery already drawn for this election' });
// //       }

// //       // Select winners
// //       const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       if (winners.length === 0) {
// //         return res.status(400).json({ error: 'No participants found for lottery' });
// //       }

// //       // Record lottery draw
// //       const drawResult = await client.query(
// //         `INSERT INTO votteryy_lottery_draws
// //          (election_id, total_participants, winner_count, random_seed, status, metadata)
// //          VALUES ($1, $2, $3, $4, $5, $6)
// //          RETURNING draw_id`,
// //         [
// //           electionId,
// //           totalParticipants,
// //           winners.length,
// //           randomSeed,
// //           'completed',
// //           JSON.stringify({ prizeDistribution, totalPrizePool })
// //         ]
// //       );

// //       const drawId = drawResult.rows[0].draw_id;

// //       // Calculate prizes and record winners
// //       const prizeDistArray = prizeDistribution || [];
// //       const winnerRecords = [];

// //       for (let i = 0; i < winners.length; i++) {
// //         const winner = winners[i];
// //         const rank = i + 1;

// //         // Calculate prize amount based on distribution
// //         let prizeAmount = 0;
// //         let prizePercentage = 0;

// //         if (rewardType === 'monetary' && prizeDistArray.length > 0) {
// //           const distEntry = prizeDistArray.find(d => d.rank === rank);
// //           if (distEntry) {
// //             prizePercentage = distEntry.percentage;
// //             prizeAmount = (totalPrizePool * prizePercentage) / 100;
// //           } else {
// //             // Equal distribution if not specified
// //             prizeAmount = totalPrizePool / winners.length;
// //             prizePercentage = 100 / winners.length;
// //           }
// //         }

// //         const winnerResult = await client.query(
// //           `INSERT INTO votteryy_lottery_winners
// //            (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
// //            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
// //            RETURNING *`,
// //           [
// //             electionId,
// //             winner.user_id,
// //             winner.ticket_id,
// //             rank,
// //             prizeAmount,
// //             prizePercentage,
// //             election.lottery_prize_description,
// //             rewardType,
// //             false
// //           ]
// //         );

// //         winnerRecords.push(winnerResult.rows[0]);

// //         // Credit wallet for monetary prizes
// //         if (rewardType === 'monetary' && prizeAmount > 0) {
// //           await client.query(
// //             `INSERT INTO votteryy_user_wallets (user_id, balance)
// //              VALUES ($1, $2)
// //              ON CONFLICT (user_id)
// //              DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
// //             [winner.user_id, prizeAmount]
// //           );

// //           await client.query(
// //             `INSERT INTO votteryy_wallet_transactions
// //              (user_id, transaction_type, amount, election_id, status, description)
// //              VALUES ($1, $2, $3, $4, $5, $6)`,
// //             [
// //               winner.user_id,
// //               'prize_won',
// //               prizeAmount,
// //               electionId,
// //               'success',
// //               `Lottery prize - Rank ${rank}`
// //             ]
// //           );
// //         }

// //         // Send notification
// //         try {
// //           const userResult = await client.query(
// //             `SELECT email, full_name FROM votteryy_user_details WHERE user_id = $1`,
// //             [winner.user_id]
// //           );

// //           if (userResult.rows.length > 0) {
// //             const user = userResult.rows[0];
// //             const prizeText = rewardType === 'monetary' 
// //               ? `$${prizeAmount.toFixed(2)}`
// //               : election.lottery_prize_description;

// //             await notificationService.sendLotteryWinnerNotification(
// //               user.email,
// //               user.full_name,
// //               election.title,
// //               prizeText,
// //               rank
// //             );
// //           }
// //         } catch (emailError) {
// //           console.error('Winner notification error:', emailError);
// //         }
// //       }

// //       // Log audit
// //       await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

// //       await client.query('COMMIT');

// //       res.json({
// //         success: true,
// //         drawId,
// //         totalParticipants,
// //         winners: winnerRecords,
// //         randomSeed
// //       });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Draw lottery error:', error);
// //       res.status(500).json({ error: 'Failed to draw lottery' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Auto-draw lottery (cron job trigger)
// //   async autoDrawLottery(electionId) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Check if election ended
// //       const electionResult = await client.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         throw new Error('Election not found');
// //       }

// //       const election = electionResult.rows[0];
// //       const now = new Date();
// //       const endDate = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //       if (now < endDate) {
// //         throw new Error('Election not yet ended');
// //       }

// //       if (!election.lottery_enabled) {
// //         throw new Error('Lottery not enabled');
// //       }

// //       // Check if already drawn
// //       const existingDraw = await client.query(
// //         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
// //         [electionId]
// //       );

// //       if (existingDraw.rows.length > 0) {
// //         throw new Error('Lottery already drawn');
// //       }

// //       // Execute draw (same logic as manual draw)
// //       const { winners, randomSeed, totalParticipants } = 
// //         await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

// //       // Record draw and winners (same as manual)
// //       // ... (similar implementation as drawLottery method)

// //       await client.query('COMMIT');

// //       console.log(`✅ Auto-drew lottery for election ${electionId}`);

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error(`Auto-draw lottery error for election ${electionId}:`, error);
// //       throw error;
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Claim lottery prize
// //   async claimPrize(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { winnerId } = req.params;
// //       const userId = req.user.userId;

// //       const winnerResult = await client.query(
// //         `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       if (winnerResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Winner record not found' });
// //       }

// //       const winner = winnerResult.rows[0];

// //       if (winner.user_id !== userId) {
// //         return res.status(403).json({ error: 'Unauthorized' });
// //       }

// //       if (winner.claimed) {
// //         return res.status(400).json({ error: 'Prize already claimed' });
// //       }

// //       // Mark as claimed
// //       await client.query(
// //         `UPDATE votteryy_lottery_winners
// //          SET claimed = true, claimed_at = CURRENT_TIMESTAMP
// //          WHERE winner_id = $1`,
// //         [winnerId]
// //       );

// //       await client.query('COMMIT');

// //       res.json({ success: true, message: 'Prize claimed successfully' });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Claim prize error:', error);
// //       res.status(500).json({ error: 'Failed to claim prize' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Get all lottery participants
// //   async getLotteryParticipants(req, res) {
// //   try {
// //     const { electionId } = req.params;

// //     const result = await pool.query(
// //       `SELECT 
// //          lt.ticket_id,
// //          lt.ticket_number,
// //          lt.ball_number,
// //          lt.user_id,
// //          lt.created_at,
// //          ud.full_name,
// //          ud.username,
// //          ud.email
// //        FROM votteryy_lottery_tickets lt
// //        LEFT JOIN votteryy_user_details ud ON lt.user_id = ud.user_id
// //        WHERE lt.election_id = $1
// //        ORDER BY lt.created_at ASC`,
// //       [electionId]
// //     );

// //     const participants = result.rows.map(p => ({
// //       id: p.ticket_id,
// //       ticket_id: p.ticket_id,
// //       ticket_number: p.ticket_number,
// //       ticketNumber: p.ticket_number,
// //       ball_number: p.ball_number,
// //       ballNumber: p.ball_number,
// //       user_id: p.user_id,
// //       userId: p.user_id,
// //       full_name: p.full_name,
// //       fullName: p.full_name,
// //       username: p.username,
// //       email: p.email,
// //       created_at: p.created_at,
// //       createdAt: p.created_at,
// //     }));

// //     res.json({
// //       participants,
// //       count: participants.length,
// //       totalCount: participants.length,
// //     });

// //   } catch (error) {
// //     console.error('Get lottery participants error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve lottery participants' });
// //   }
// // }

// // }

// // export default new LotteryController();