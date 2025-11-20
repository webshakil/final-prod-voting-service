import pool from '../config/database.js';
import rngService from '../services/rng.service.js';
import auditService from '../services/audit.service.js';
import notificationService from '../services/notification.service.js';

class LotteryController {

  // Get lottery info for election
  async getLotteryInfo(req, res) {
    try {
      const { electionId } = req.params;

      console.log(`🎰 Getting lottery info for election ${electionId}`);

      const result = await pool.query(
        `SELECT 
           lottery_enabled,
           lottery_prize_funding_source,
           lottery_reward_type,
           lottery_total_prize_pool,
           lottery_prize_description,
           lottery_estimated_value,
           lottery_projected_revenue,
           lottery_revenue_share_percentage,
           lottery_winner_count,
           lottery_prize_distribution
         FROM votteryyy_elections
         WHERE id = $1`,
        [electionId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = result.rows[0];

      if (!election.lottery_enabled) {
        return res.json({ lotteryEnabled: false });
      }

      // Get participant count
      const participantResult = await pool.query(
        `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
        [electionId]
      );

      const participantCount = parseInt(participantResult.rows[0].count || 0);

      // ✅ FIX: Check if lottery has been drawn - use draw_id instead of draw_time
      const drawResult = await pool.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
        [electionId]
      );

      const hasBeenDrawn = drawResult.rows.length > 0;
      let winners = [];

      console.log(`✅ Lottery draw check for election ${electionId}: hasBeenDrawn=${hasBeenDrawn}`);

      if (hasBeenDrawn) {
        // ✅ FIX: Cast user_id to integer using CAST() function, remove username column
        const winnersResult = await pool.query(
          `SELECT 
             lw.winner_id,
             lw.user_id,
             lw.rank,
             lw.prize_amount,
             lw.prize_percentage,
             lw.prize_description,
             lw.prize_type,
             lw.claimed,
             lw.claimed_at,
             lt.ball_number,
             lt.ticket_number,
             CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as winner_name,
             CONCAT(COALESCE(ud.first_name, ''), ' ', COALESCE(ud.last_name, '')) as full_name,
             ud.first_name,
             ud.last_name
           FROM votteryy_lottery_winners lw
           LEFT JOIN votteryy_user_details ud ON CAST(lw.user_id AS INTEGER) = ud.user_id
           LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
           WHERE lw.election_id = $1
           ORDER BY lw.rank ASC`,
          [electionId]
        );

        winners = winnersResult.rows.map(w => ({
          id: w.winner_id,
          winner_id: w.winner_id,
          user_id: w.user_id,
          rank: w.rank,
          prize_amount: w.prize_amount,
          prize_percentage: w.prize_percentage,
          prize_description: w.prize_description,
          prize_type: w.prize_type,
          claimed: w.claimed,
          claimed_at: w.claimed_at,
          ball_number: w.ball_number,
          ticket_number: w.ticket_number,
          winner_name: w.winner_name?.trim() || `User #${w.user_id}`,
          full_name: w.full_name?.trim() || `User #${w.user_id}`,
          first_name: w.first_name,
          last_name: w.last_name,
        }));

        console.log(`✅ Found ${winners.length} winners for election ${electionId}:`, winners);
      }

      const response = {
        lotteryEnabled: true,
        lottery_enabled: true,
        hasBeenDrawn,
        has_been_drawn: hasBeenDrawn,
        rewardType: election.lottery_reward_type,
        reward_type: election.lottery_reward_type,
        totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
        total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
        prizeDescription: election.lottery_prize_description,
        prize_description: election.lottery_prize_description,
        estimatedValue: parseFloat(election.lottery_estimated_value || 0),
        estimated_value: parseFloat(election.lottery_estimated_value || 0),
        projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
        projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
        revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
        revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
        winnerCount: winners.length > 0 ? winners.length : election.lottery_winner_count,
        winner_count: winners.length > 0 ? winners.length : election.lottery_winner_count,
        prizeDistribution: election.lottery_prize_distribution || [],
        prize_distribution: election.lottery_prize_distribution || [],
        participantCount,
        participant_count: participantCount,
        winners: winners,
      };

      console.log(`📊 Lottery response for election ${electionId}:`, JSON.stringify(response, null, 2));

      res.json(response);

    } catch (error) {
      console.error('Get lottery info error:', error);
      res.status(500).json({ error: 'Failed to retrieve lottery information' });
    }
  }

  // Auto-draw lottery (cron job trigger)
async autoDrawLottery(electionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log(`🎰 Auto-draw started for election ${electionId}`);

    // Get election
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

    // Calculate prizes and record winners
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
         (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
          false
        ]
      );

      winnerRecords.push(winnerResult.rows[0]);

      // Credit wallet for monetary prizes
      if (rewardType === 'monetary' && prizeAmount > 0) {
        await client.query(
          `INSERT INTO votteryy_user_wallets (user_id, balance)
           VALUES ($1, $2)
           ON CONFLICT (user_id)
           DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
          [winner.user_id, prizeAmount]
        );

        await client.query(
          `INSERT INTO votteryy_wallet_transactions
           (user_id, transaction_type, amount, election_id, status, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            winner.user_id,
            'prize_won',
            prizeAmount,
            electionId,
            'success',
            `Auto Lottery Prize - Rank ${rank}`
          ]
        );
      }

      // Send notification
      try {
  const userResult = await client.query(
  `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
  [winner.user_id]
);

if (userResult.rows.length > 0) {
  const user = userResult.rows[0];
  const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const prizeText = rewardType === 'monetary' 
    ? `$${prizeAmount.toFixed(2)}`
    : election.lottery_prize_description;

  // Log winner (email notification disabled until email column added)
  console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
  
  // TODO: Enable when email is added to votteryy_user_details
  // await notificationService.sendLotteryWinnerNotification(
  //   user.email,
  //   fullName,
  //   election.title,
  //   prizeText,
  //   rank
  // );
}
      } catch (emailError) {
        console.error('Winner notification error:', emailError);
      }
    }

    // Log audit (pass null for req since it's auto-draw)
    await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, null);

    await client.query('COMMIT');

    console.log(`✅ Auto-drew lottery for election ${electionId}, ${winners.length} winners`);
    return { success: true, drawId, winners: winnerRecords };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`❌ Auto-draw lottery error for election ${electionId}:`, error);
    throw error;
  } finally {
    client.release();
  }
}
  // Get user's lottery ticket
  async getUserTicket(req, res) {
    try {
      const { electionId } = req.params;
      const userId = req.user.userId;

      // FIX: Use votteryyy_lottery_tickets (3 y's)
      const result = await pool.query(
        `SELECT * FROM votteryy_lottery_tickets
         WHERE user_id = $1 AND election_id = $2`,
        [userId, electionId]
      );

      //  Don't return 404, return empty state
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
          ticketId: ticket.ticket_id,
          ticket_number: ticket.ticket_number,
          ticketNumber: ticket.ticket_number,
          ball_number: ticket.ball_number,
          ballNumber: ticket.ball_number,
          user_id: ticket.user_id,
          userId: ticket.user_id,
          election_id: ticket.election_id,
          electionId: ticket.election_id,
          created_at: ticket.created_at,
          createdAt: ticket.created_at,
        }
      });

    } catch (error) {
      console.error('Get user ticket error:', error);
      res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
    }
  }

  // Get all lottery participants

async getLotteryParticipants(req, res) {
  try {
    const { electionId } = req.params;

    console.log('🔍 Fetching participants for election:', electionId);

    // ✅ FIX: Correct column names and type casting
    const result = await pool.query(
      `SELECT 
         lt.ticket_id,
         lt.ticket_number,
         lt.ball_number,
         lt.user_id,
         lt.created_at,
         ud.first_name,
         ud.last_name,
         CONCAT(ud.first_name, ' ', ud.last_name) as full_name
       FROM votteryy_lottery_tickets lt
       LEFT JOIN votteryy_user_details ud ON lt.user_id::integer = ud.user_id
       WHERE lt.election_id = $1
       ORDER BY lt.created_at ASC`,
      [electionId]
    );

    console.log('✅ Found participants:', result.rows.length);

    const participants = result.rows.map(p => ({
      id: p.ticket_id,
      ticket_id: p.ticket_id,
      ticket_number: p.ticket_number,
      ticketNumber: p.ticket_number,
      ball_number: p.ball_number,
      ballNumber: p.ball_number,
      user_id: p.user_id,
      userId: p.user_id,
      full_name: p.full_name,
      fullName: p.full_name,
      first_name: p.first_name,
      lastName: p.last_name,
      created_at: p.created_at,
      createdAt: p.created_at,
    }));

    res.json({
      participants,
      count: participants.length,
      totalCount: participants.length,
    });

  } catch (error) {
    console.error('Get lottery participants error:', error);
    res.status(500).json({ error: 'Failed to retrieve lottery participants' });
  }
}


  // Draw lottery (manual trigger - admin only)
  async drawLottery(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { electionId } = req.params;
      const adminId = req.user.userId;

      // Verify admin role
      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required ' });
      }

      // Get election
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

      // FIX: Use votteryyy_lottery_draws (3 y's)
      const existingDrawResult = await client.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
        [electionId]
      );

      if (existingDrawResult.rows.length > 0) {
        return res.status(400).json({ error: 'Lottery already drawn for this election' });
      }

      // Select winners
      const { winners, randomSeed, totalParticipants, prizeDistribution, totalPrizePool, rewardType } = 
        await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

      if (winners.length === 0) {
        return res.status(400).json({ error: 'No participants found for lottery' });
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
          JSON.stringify({ prizeDistribution, totalPrizePool })
        ]
      );

      const drawId = drawResult.rows[0].draw_id;

      // Calculate prizes and record winners
      const prizeDistArray = prizeDistribution || [];
      const winnerRecords = [];

      for (let i = 0; i < winners.length; i++) {
        const winner = winners[i];
        const rank = i + 1;

        // Calculate prize amount based on distribution
        let prizeAmount = 0;
        let prizePercentage = 0;

        if (rewardType === 'monetary' && prizeDistArray.length > 0) {
          const distEntry = prizeDistArray.find(d => d.rank === rank);
          if (distEntry) {
            prizePercentage = distEntry.percentage;
            prizeAmount = (totalPrizePool * prizePercentage) / 100;
          } else {
            // Equal distribution if not specified
            prizeAmount = totalPrizePool / winners.length;
            prizePercentage = 100 / winners.length;
          }
        }

        const winnerResult = await client.query(
          `INSERT INTO votteryy_lottery_winners
           (election_id, user_id, ticket_id, rank, prize_amount, prize_percentage, prize_description, prize_type, claimed)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
            false
          ]
        );

        winnerRecords.push(winnerResult.rows[0]);

        // Credit wallet for monetary prizes
        if (rewardType === 'monetary' && prizeAmount > 0) {
          await client.query(
            `INSERT INTO votteryy_user_wallets (user_id, balance)
             VALUES ($1, $2)
             ON CONFLICT (user_id)
             DO UPDATE SET balance = votteryy_user_wallets.balance + $2`,
            [winner.user_id, prizeAmount]
          );

          await client.query(
            `INSERT INTO votteryy_wallet_transactions
             (user_id, transaction_type, amount, election_id, status, description)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              winner.user_id,
              'prize_won',
              prizeAmount,
              electionId,
              'success',
              `Lottery prize - Rank ${rank}`
            ]
          );
        }

        // Send notification
        try {
          const userResult = await client.query(
            `SELECT first_name, last_name FROM votteryy_user_details WHERE user_id = $1`,
            [winner.user_id]
          );

          if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
            const prizeText = rewardType === 'monetary' 
              ? `$${prizeAmount.toFixed(2)}`
              : election.lottery_prize_description;

            // Log winner (email notification disabled until email column added)
            console.log(`🏆 Winner (Rank ${rank}): ${fullName} won ${prizeText}`);
            
            // TODO: Enable when email is added to votteryy_user_details
            // await notificationService.sendLotteryWinnerNotification(
            //   user.email,
            //   fullName,
            //   election.title,
            //   prizeText,
            //   rank
            // );
          }
        } catch (emailError) {
          console.error('Winner notification error:', emailError);
        }
      }

      // Log audit
      await auditService.logLotteryDraw(electionId, winnerRecords, randomSeed, req);

      await client.query('COMMIT');

      res.json({
        success: true,
        drawId,
        totalParticipants,
        winners: winnerRecords,
        randomSeed
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Draw lottery error:', error);
      res.status(500).json({ error: 'Failed to draw lottery' });
    } finally {
      client.release();
    }
  }

  // Auto-draw lottery (cron job trigger)
  async autoDrawLottery(electionId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if election ended
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

      // ✅ FIX: Use votteryyy_lottery_draws (3 y's)
      const existingDraw = await client.query(
        `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1`,
        [electionId]
      );

      if (existingDraw.rows.length > 0) {
        throw new Error('Lottery already drawn');
      }

      // Execute draw (same logic as manual draw)
      const { winners, randomSeed, totalParticipants } = 
        await rngService.selectLotteryWinners(electionId, election.lottery_winner_count);

      // Record draw and winners (same as manual)
      // ... (similar implementation as drawLottery method)

      await client.query('COMMIT');

      console.log(`✅ Auto-drew lottery for election ${electionId}`);

    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`Auto-draw lottery error for election ${electionId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  // Claim lottery prize
  async claimPrize(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { winnerId } = req.params;
      const userId = req.user.userId;

      const winnerResult = await client.query(
        `SELECT * FROM votteryy_lottery_winners WHERE winner_id = $1`,
        [winnerId]
      );

      if (winnerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Winner record not found' });
      }

      const winner = winnerResult.rows[0];

      if (winner.user_id !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (winner.claimed) {
        return res.status(400).json({ error: 'Prize already claimed' });
      }

      // Mark as claimed
      await client.query(
        `UPDATE votteryy_lottery_winners
         SET claimed = true, claimed_at = CURRENT_TIMESTAMP
         WHERE winner_id = $1`,
        [winnerId]
      );

      await client.query('COMMIT');

      res.json({ success: true, message: 'Prize claimed successfully' });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Claim prize error:', error);
      res.status(500).json({ error: 'Failed to claim prize' });
    } finally {
      client.release();
    }
  }
}

export default new LotteryController();
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
//         // ✅ FIX: Cast user_id to integer using CAST() function
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
//              ud.username,
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
//           username: w.username,
//           first_name: w.first_name,
//           last_name: w.last_name,
//         }));

//         console.log(`✅ Found ${winners.length} winners for election ${electionId}`);
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
// import pool from '../config/database.js';
// import rngService from '../services/rng.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';

// class LotteryController {

//   // Get lottery info for election
//   async getLotteryInfo(req, res) {
//     try {
//       const { electionId } = req.params;

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

//       //  FIX: Use votteryyy_lottery_tickets (3 y's)
//       const participantResult = await pool.query(
//         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//         [electionId]
//       );

//       const participantCount = parseInt(participantResult.rows[0].count || 0);

//       //  FIX: Use votteryyy_lottery_draws (3 y's)
//       const drawResult = await pool.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//         [electionId]
//       );

//       const hasBeenDrawn = drawResult.rows.length > 0;
//       let winners = [];

//       if (hasBeenDrawn) {
//         const winnersResult = await pool.query(
//           `SELECT 
//              lw.winner_id as id,
//              lw.user_id,
//              lw.rank,
//              lw.prize_amount,
//              lw.claimed,
//              lt.ball_number,
//              ud.full_name as winner_name,
//              ud.username
//            FROM votteryy_lottery_winners lw
//            LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
//            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//            WHERE lw.election_id = $1
//            ORDER BY lw.rank ASC`,
//           [electionId]
//         );

//         winners = winnersResult.rows;
//       }

//       res.json({
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
//         winnerCount: election.lottery_winner_count,
//         winner_count: election.lottery_winner_count,
//         prizeDistribution: election.lottery_prize_distribution || [],
//         prize_distribution: election.lottery_prize_distribution || [],
//         participantCount,
//         participant_count: participantCount,
//         winners: hasBeenDrawn ? winners : [],
//       });

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
// import pool from '../config/database.js';
// import rngService from '../services/rng.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';

// class LotteryController {

//   // Get lottery info for election
//   async getLotteryInfo(req, res) {
//     try {
//       const { electionId } = req.params;

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

//       //  FIX: Use votteryyy_lottery_tickets (3 y's)
//       const participantResult = await pool.query(
//         `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//         [electionId]
//       );

//       const participantCount = parseInt(participantResult.rows[0].count || 0);

//       //  FIX: Use votteryyy_lottery_draws (3 y's)
//       const drawResult = await pool.query(
//         `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//         [electionId]
//       );

//       const hasBeenDrawn = drawResult.rows.length > 0;
//       let winners = [];

//       if (hasBeenDrawn) {
//         const winnersResult = await pool.query(
//           `SELECT 
//              lw.winner_id as id,
//              lw.user_id,
//              lw.rank,
//              lw.prize_amount,
//              lw.claimed,
//              lt.ball_number,
//              ud.full_name as winner_name,
//              ud.username
//            FROM votteryy_lottery_winners lw
//            LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
//            LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//            WHERE lw.election_id = $1
//            ORDER BY lw.rank ASC`,
//           [electionId]
//         );

//         winners = winnersResult.rows;
//       }

//       res.json({
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
//         winnerCount: election.lottery_winner_count,
//         winner_count: election.lottery_winner_count,
//         prizeDistribution: election.lottery_prize_distribution || [],
//         prize_distribution: election.lottery_prize_distribution || [],
//         participantCount,
//         participant_count: participantCount,
//         winners: hasBeenDrawn ? winners : [],
//       });

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
//             `SELECT email, full_name FROM votteryy_user_details WHERE user_id = $1`,
//             [winner.user_id]
//           );

//           if (userResult.rows.length > 0) {
//             const user = userResult.rows[0];
//             const prizeText = rewardType === 'monetary' 
//               ? `$${prizeAmount.toFixed(2)}`
//               : election.lottery_prize_description;

//             await notificationService.sendLotteryWinnerNotification(
//               user.email,
//               user.full_name,
//               election.title,
//               prizeText,
//               rank
//             );
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
// import pool from '../config/database.js';
// import rngService from '../services/rng.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';

// class LotteryController {

//   // Get lottery info for election
//   async getLotteryInfo(req, res) {
//   try {
//     const { electionId } = req.params;

//     const result = await pool.query(
//       `SELECT 
//          lottery_enabled,
//          lottery_prize_funding_source,
//          lottery_reward_type,
//          lottery_total_prize_pool,
//          lottery_prize_description,
//          lottery_estimated_value,
//          lottery_projected_revenue,
//          lottery_revenue_share_percentage,
//          lottery_winner_count,
//          lottery_prize_distribution
//        FROM votteryyy_elections
//        WHERE id = $1`,
//       [electionId]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = result.rows[0];

//     if (!election.lottery_enabled) {
//       return res.json({ lotteryEnabled: false });
//     }

//     // Get participant count
//     const participantResult = await pool.query(
//       `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//       [electionId]
//     );

//     const participantCount = parseInt(participantResult.rows[0].count || 0);

//     // Check if lottery has been drawn
//     const drawResult = await pool.query(
//       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//       [electionId]
//     );

//     const hasBeenDrawn = drawResult.rows.length > 0;
//     let winners = [];

//     if (hasBeenDrawn) {
//       const winnersResult = await pool.query(
//         `SELECT 
//            lw.winner_id as id,
//            lw.user_id,
//            lw.rank,
//            lw.prize_amount,
//            lw.claimed,
//            lt.ball_number,
//            ud.full_name as winner_name,
//            ud.username
//          FROM votteryy_lottery_winners lw
//          LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
//          LEFT JOIN votteryy_lottery_tickets lt ON lw.ticket_id = lt.ticket_id
//          WHERE lw.election_id = $1
//          ORDER BY lw.rank ASC`,
//         [electionId]
//       );

//       winners = winnersResult.rows;
//     }

//     res.json({
//       lotteryEnabled: true,
//       lottery_enabled: true,
//       hasBeenDrawn,
//       has_been_drawn: hasBeenDrawn,
//       rewardType: election.lottery_reward_type,
//       reward_type: election.lottery_reward_type,
//       totalPrizePool: parseFloat(election.lottery_total_prize_pool || 0),
//       total_prize_pool: parseFloat(election.lottery_total_prize_pool || 0),
//       prizeDescription: election.lottery_prize_description,
//       prize_description: election.lottery_prize_description,
//       estimatedValue: parseFloat(election.lottery_estimated_value || 0),
//       estimated_value: parseFloat(election.lottery_estimated_value || 0),
//       projectedRevenue: parseFloat(election.lottery_projected_revenue || 0),
//       projected_revenue: parseFloat(election.lottery_projected_revenue || 0),
//       revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage || 0),
//       revenue_share_percentage: parseFloat(election.lottery_revenue_share_percentage || 0),
//       winnerCount: election.lottery_winner_count,
//       winner_count: election.lottery_winner_count,
//       prizeDistribution: election.lottery_prize_distribution || [],
//       prize_distribution: election.lottery_prize_distribution || [],
//       participantCount,
//       participant_count: participantCount,
//       winners: hasBeenDrawn ? winners : [],
//     });

//   } catch (error) {
//     console.error('Get lottery info error:', error);
//     res.status(500).json({ error: 'Failed to retrieve lottery information' });
//   }
// }
//   // async getLotteryInfo(req, res) {
//   //   try {
//   //     const { electionId } = req.params;

//   //     const result = await pool.query(
//   //       `SELECT 
//   //          lottery_enabled,
//   //          lottery_prize_funding_source,
//   //          lottery_reward_type,
//   //          lottery_total_prize_pool,
//   //          lottery_prize_description,
//   //          lottery_estimated_value,
//   //          lottery_projected_revenue,
//   //          lottery_revenue_share_percentage,
//   //          lottery_winner_count,
//   //          lottery_prize_distribution
//   //        FROM votteryyy_elections
//   //        WHERE id = $1`,
//   //       [electionId]
//   //     );

//   //     if (result.rows.length === 0) {
//   //       return res.status(404).json({ error: 'Election not found' });
//   //     }

//   //     const election = result.rows[0];

//   //     if (!election.lottery_enabled) {
//   //       return res.json({ lotteryEnabled: false });
//   //     }

//   //     // Get participant count
//   //     const participantResult = await pool.query(
//   //       `SELECT COUNT(*) as count FROM votteryy_lottery_tickets WHERE election_id = $1`,
//   //       [electionId]
//   //     );

//   //     const participantCount = parseInt(participantResult.rows[0].count);

//   //     // Check if lottery has been drawn
//   //     const drawResult = await pool.query(
//   //       `SELECT * FROM votteryy_lottery_draws WHERE election_id = $1 ORDER BY draw_time DESC LIMIT 1`,
//   //       [electionId]
//   //     );

//   //     const hasBeenDrawn = drawResult.rows.length > 0;
//   //     let winners = [];

//   //     if (hasBeenDrawn) {
//   //       const winnersResult = await pool.query(
//   //         `SELECT 
//   //            lw.*,
//   //            ud.full_name,
//   //            ud.email
//   //          FROM votteryy_lottery_winners lw
//   //          LEFT JOIN votteryy_user_details ud ON lw.user_id = ud.user_id
//   //          WHERE lw.election_id = $1
//   //          ORDER BY lw.rank ASC`,
//   //         [electionId]
//   //       );

//   //       winners = winnersResult.rows;
//   //     }

//   //     res.json({
//   //       lotteryEnabled: true,
//   //       rewardType: election.lottery_reward_type,
//   //       totalPrizePool: parseFloat(election.lottery_total_prize_pool),
//   //       prizeDescription: election.lottery_prize_description,
//   //       estimatedValue: parseFloat(election.lottery_estimated_value),
//   //       projectedRevenue: parseFloat(election.lottery_projected_revenue),
//   //       revenueSharePercentage: parseFloat(election.lottery_revenue_share_percentage),
//   //       winnerCount: election.lottery_winner_count,
//   //       prizeDistribution: election.lottery_prize_distribution,
//   //       participantCount,
//   //       hasBeenDrawn,
//   //       winners: hasBeenDrawn ? winners : null
//   //     });

//   //   } catch (error) {
//   //     console.error('Get lottery info error:', error);
//   //     res.status(500).json({ error: 'Failed to retrieve lottery information' });
//   //   }
//   // }

//   // Get user's lottery ticket

//   async getUserTicket(req, res) {
//   try {
//     const { electionId } = req.params;
//     const userId = req.user.userId;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_lottery_tickets
//        WHERE user_id = $1 AND election_id = $2`,
//       [userId, electionId]
//     );

//     // ✅ Don't return 404, return empty state
//     if (result.rows.length === 0) {
//       return res.json({
//         hasTicket: false,
//         has_ticket: false,
//         ticket: null,
//         message: 'No lottery ticket found. Vote to participate.'
//       });
//     }

//     const ticket = result.rows[0];

//     res.json({
//       hasTicket: true,
//       has_ticket: true,
//       ticket: {
//         id: ticket.ticket_id,
//         ticket_id: ticket.ticket_id,
//         ticketId: ticket.ticket_id,
//         ticket_number: ticket.ticket_number,
//         ticketNumber: ticket.ticket_number,
//         ball_number: ticket.ball_number,
//         ballNumber: ticket.ball_number,
//         user_id: ticket.user_id,
//         userId: ticket.user_id,
//         election_id: ticket.election_id,
//         electionId: ticket.election_id,
//         created_at: ticket.created_at,
//         createdAt: ticket.created_at,
//       }
//     });

//   } catch (error) {
//     console.error('Get user ticket error:', error);
//     res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
//   }
// }
//   // async getUserTicket(req, res) {
//   //   try {
//   //     const { electionId } = req.params;
//   //     const userId = req.user.userId;

//   //     const result = await pool.query(
//   //       `SELECT * FROM votteryy_lottery_tickets
//   //        WHERE user_id = $1 AND election_id = $2`,
//   //       [userId, electionId]
//   //     );

//   //     if (result.rows.length === 0) {
//   //       return res.status(404).json({ error: 'No lottery ticket found. You must vote to participate.' });
//   //     }

//   //     res.json(result.rows[0]);

//   //   } catch (error) {
//   //     console.error('Get user ticket error:', error);
//   //     res.status(500).json({ error: 'Failed to retrieve lottery ticket' });
//   //   }
//   // }

//   // Draw lottery (manual trigger - admin only)
//   async drawLottery(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { electionId } = req.params;
//       const adminId = req.user.userId;

//       // Verify admin role
//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
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

//       // Check if already drawn
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
//             `SELECT email, full_name FROM votteryy_user_details WHERE user_id = $1`,
//             [winner.user_id]
//           );

//           if (userResult.rows.length > 0) {
//             const user = userResult.rows[0];
//             const prizeText = rewardType === 'monetary' 
//               ? `$${prizeAmount.toFixed(2)}`
//               : election.lottery_prize_description;

//             await notificationService.sendLotteryWinnerNotification(
//               user.email,
//               user.full_name,
//               election.title,
//               prizeText,
//               rank
//             );
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

//       // Check if already drawn
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

//   // Get all lottery participants
//   async getLotteryParticipants(req, res) {
//   try {
//     const { electionId } = req.params;

//     const result = await pool.query(
//       `SELECT 
//          lt.ticket_id,
//          lt.ticket_number,
//          lt.ball_number,
//          lt.user_id,
//          lt.created_at,
//          ud.full_name,
//          ud.username,
//          ud.email
//        FROM votteryy_lottery_tickets lt
//        LEFT JOIN votteryy_user_details ud ON lt.user_id = ud.user_id
//        WHERE lt.election_id = $1
//        ORDER BY lt.created_at ASC`,
//       [electionId]
//     );

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
//       username: p.username,
//       email: p.email,
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

// }

// export default new LotteryController();