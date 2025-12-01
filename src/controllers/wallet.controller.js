
//last workbale code and full functional just to add socket.io above code
import pool from '../config/database.js';
import paymentService from '../services/payment.service.js';
import auditService from '../services/audit.service.js';
import notificationService from '../services/notification.service.js';
import { depositSchema, withdrawalSchema } from '../utils/validators.js';
import Stripe from 'stripe';
import { 
  emitPaymentInitiated,
  emitPaymentSuccess,
  emitPaymentFailed
} from '../socket/combinedSocket.js';
// import { 
//   emitPaymentInitiated,
//   emitPaymentSuccess,
//   emitPaymentFailed
// } from '../socket/notificationSocket.js';

class WalletController {

  // Check if user can vote (hasn't voted yet)
  async canUserVote(req, res) {
    try {
      const userId = req.user.userId;
      const { electionId } = req.params;

      const voteResult = await pool.query(
        `SELECT voting_id FROM votteryy_votes
         WHERE user_id = $1 AND election_id = $2
         LIMIT 1`,
        [userId, electionId]
      );

      const hasVoted = voteResult.rows.length > 0;

      const electionResult = await pool.query(
        `SELECT id, status, start_date, end_date, end_time
         FROM votteryyy_elections
         WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        return res.status(404).json({ error: 'Election not found' });
      }

      const election = electionResult.rows[0];
      const now = new Date();
      const endDateTime = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

      const canVote = !hasVoted && 
                      election.status === 'published' && 
                      now <= endDateTime;

      res.json({
        canVote,
        hasVoted,
        reason: hasVoted ? 'already_voted' : 
                election.status !== 'published' ? 'election_not_active' :
                now > endDateTime ? 'election_ended' : null
      });

    } catch (error) {
      console.error('Check vote eligibility error:', error);
      res.status(500).json({ error: 'Failed to check vote eligibility' });
    }
  }

  async getWallet(req, res) {
    try {
      const userId = req.user.userId;

      console.log('💰 Getting wallet for userId:', userId);

      const result = await pool.query(
        `SELECT * FROM votteryy_wallets WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        console.log('⚠️ Wallet not found, creating new wallet');
        
        const createResult = await pool.query(
          `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
           VALUES ($1, 0, 0, 'USD')
           RETURNING *`,
          [userId]
        );

        console.log('✅ New wallet created:', createResult.rows[0]);
        return res.json(createResult.rows[0]);
      }

      console.log('✅ Wallet found:', result.rows[0]);
      res.json(result.rows[0]);

    } catch (error) {
      console.error('❌ Get wallet error:', error);
      res.status(500).json({ error: 'Failed to retrieve wallet' });
    }
  }

  async getTransactions(req, res) {
    try {
      const userId = req.user.userId;
      const { 
        page = 1, 
        limit = 20, 
        type, 
        status, 
        dateFrom, 
        dateTo,
        filterType
      } = req.query;

      console.log('📜 Getting transactions for userId:', userId, { page, limit, type, status, filterType });

      const offset = (page - 1) * limit;

      let query = `SELECT * FROM votteryy_transactions WHERE user_id = $1`;
      const params = [userId];
      let paramIndex = 2;

      if (type) {
        query += ` AND transaction_type = $${paramIndex}`;
        params.push(type);
        paramIndex++;
      }

      if (status) {
        query += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      if (filterType) {
        const now = new Date();
        let startDate, endDate;

        switch (filterType) {
          case 'today':
            startDate = new Date(now.setHours(0, 0, 0, 0));
            endDate = new Date(now.setHours(23, 59, 59, 999));
            break;
          case 'yesterday':
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            startDate = new Date(yesterday.setHours(0, 0, 0, 0));
            endDate = new Date(yesterday.setHours(23, 59, 59, 999));
            break;
          case 'last_week':
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 7);
            endDate = new Date();
            break;
          case 'last_30_days':
            startDate = new Date(now);
            startDate.setDate(startDate.getDate() - 30);
            endDate = new Date();
            break;
          case 'custom':
            if (dateFrom) startDate = new Date(dateFrom);
            if (dateTo) endDate = new Date(dateTo);
            break;
        }

        if (startDate) {
          query += ` AND created_at >= $${paramIndex}`;
          params.push(startDate);
          paramIndex++;
        }

        if (endDate) {
          query += ` AND created_at <= $${paramIndex}`;
          params.push(endDate);
          paramIndex++;
        }
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      let countQuery = `SELECT COUNT(*) FROM votteryy_transactions WHERE user_id = $1`;
      const countParams = [userId];
      let countParamIndex = 2;

      if (type) {
        countQuery += ` AND transaction_type = $${countParamIndex}`;
        countParams.push(type);
        countParamIndex++;
      }

      if (status) {
        countQuery += ` AND status = $${countParamIndex}`;
        countParams.push(status);
        countParamIndex++;
      }

      const countResult = await pool.query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0].count);

      console.log('✅ Found transactions:', result.rows.length);

      res.json({
        transactions: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      });

    } catch (error) {
      console.error('❌ Get transactions error:', error);
      res.status(500).json({ error: 'Failed to retrieve transactions' });
    }
  }

  async deposit(req, res) {
    try {
      const userId = req.user.userId;
      const { amount, paymentMethod, regionCode } = req.body;

      const { error } = depositSchema.validate({ amount, paymentMethod });
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const processingFeeConfig = await paymentService.getUserProcessingFee(userId);
      
      const stripeFee = (amount * 0.029) + 0.30;
      const platformFee = paymentService.calculateProcessingFee(amount, processingFeeConfig);
      const netAmount = amount - stripeFee - platformFee;

      const paymentResult = await paymentService.createStripePayment(
        amount,
        'USD',
        { userId, type: 'wallet_deposit' }
      );

      await pool.query(
        `INSERT INTO votteryy_wallet_transactions
         (user_id, transaction_type, amount, stripe_fee, platform_fee, net_amount, status, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId, 'deposit', amount, stripeFee, platformFee, netAmount, 'pending',
          'Wallet deposit',
          JSON.stringify({ paymentIntentId: paymentResult.paymentIntentId })
        ]
      );

      res.json({
        success: true,
        clientSecret: paymentResult.clientSecret,
        paymentIntentId: paymentResult.paymentIntentId,
        breakdown: {
          originalAmount: amount.toFixed(2),
          stripeFee: stripeFee.toFixed(2),
          platformFee: platformFee.toFixed(2),
          netAmount: netAmount.toFixed(2)
        }
      });
    } catch (error) {
      console.error('Deposit error:', error);
      res.status(500).json({ error: 'Failed to process deposit' });
    }
  }

  async confirmDeposit(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { paymentIntentId } = req.body;

      const txResult = await client.query(
        `SELECT * FROM votteryy_wallet_transactions
         WHERE metadata->>'paymentIntentId' = $1 AND status = 'pending'`,
        [paymentIntentId]
      );

      if (txResult.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const transaction = txResult.rows[0];

      await client.query(
        `UPDATE votteryy_wallet_transactions
         SET status = 'success', updated_at = CURRENT_TIMESTAMP
         WHERE transaction_id = $1`,
        [transaction.transaction_id]
      );

      await client.query(
        `UPDATE votteryy_user_wallets
         SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [transaction.amount, transaction.user_id]
      );

      const depositCountResult = await client.query(
        `SELECT COUNT(*) as count FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
        [transaction.user_id]
      );

      const depositCount = parseInt(depositCountResult.rows[0].count);

      if (depositCount === 1) {
        await client.query(
          `INSERT INTO user_roles (user_id, role_name, is_active, assigned_date)
           VALUES ($1, 'sponsor', true, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, role_name) DO NOTHING`,
          [transaction.user_id]
        );
      }

      await client.query('COMMIT');

      res.json({ success: true, message: 'Deposit confirmed' });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Confirm deposit error:', error);
      res.status(500).json({ error: 'Failed to confirm deposit' });
    } finally {
      client.release();
    }
  }

  async requestWithdrawal(req, res) {
    try {
      const userId = req.user.userId;
      const { amount, paymentMethod, paymentDetails } = req.body;

      const { error } = withdrawalSchema.validate({ amount, paymentMethod, paymentDetails });
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      if (amount < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
      }

      const withdrawal = await paymentService.processWithdrawal(
        userId,
        amount,
        paymentMethod,
        paymentDetails
      );

      await auditService.logWithdrawal(userId, amount, withdrawal.status, req);

      try {
        const userResult = await pool.query(
          `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
          [userId]
        );

        if (userResult.rows.length > 0) {
          if (withdrawal.status === 'approved' || withdrawal.status === 'completed') {
            await notificationService.sendWithdrawalApproved(
              userResult.rows[0].email,
              amount
            );
          }
        }
      } catch (emailError) {
        console.error('Email notification error:', emailError);
      }

      res.json({
        success: true,
        withdrawal,
        message: amount >= 5000 
          ? 'Withdrawal request submitted for admin review' 
          : 'Withdrawal processed successfully'
      });

    } catch (error) {
      console.error('Request withdrawal error:', error);
      res.status(500).json({ error: error.message || 'Failed to process withdrawal request' });
    }
  }

  async getWithdrawalRequests(req, res) {
    try {
      const userId = req.user.userId;
      const { status } = req.query;

      let query = `SELECT * FROM votteryy_withdrawal_requests WHERE user_id = $1`;
      const params = [userId];

      if (status) {
        query += ` AND status = $2`;
        params.push(status);
      }

      query += ` ORDER BY created_at DESC`;

      const result = await pool.query(query, params);

      res.json({
        withdrawalRequests: result.rows,
        totalCount: result.rows.length
      });

    } catch (error) {
      console.error('Get withdrawal requests error:', error);
      res.status(500).json({ error: 'Failed to retrieve withdrawal requests' });
    }
  }

  async getPendingWithdrawals(req, res) {
    try {
      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const result = await pool.query(
        `SELECT 
           wr.*,
           ud.full_name,
           ud.email,
           uw.balance as user_balance
         FROM votteryy_withdrawal_requests wr
         LEFT JOIN votteryy_user_details ud ON wr.user_id = ud.user_id
         LEFT JOIN votteryy_user_wallets uw ON wr.user_id = uw.user_id
         WHERE wr.status = 'pending'
         ORDER BY wr.created_at ASC`
      );

      res.json({
        pendingWithdrawals: result.rows,
        totalCount: result.rows.length
      });

    } catch (error) {
      console.error('Get pending withdrawals error:', error);
      res.status(500).json({ error: 'Failed to retrieve pending withdrawals' });
    }
  }

  async reviewWithdrawal(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { requestId } = req.params;
      const { action, adminNotes } = req.body;
      const adminId = req.user.userId;

      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
      }

      const requestResult = await client.query(
        `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
        [requestId]
      );

      if (requestResult.rows.length === 0) {
        return res.status(404).json({ error: 'Withdrawal request not found' });
      }

      const request = requestResult.rows[0];

      if (request.status !== 'pending') {
        return res.status(400).json({ error: 'Withdrawal request already processed' });
      }

      if (action === 'approve') {
        await client.query(
          `UPDATE votteryy_withdrawal_requests
           SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
           WHERE request_id = $3`,
          [adminId, adminNotes, requestId]
        );

        await paymentService.executeWithdrawal(requestId, adminId);

        try {
          const userResult = await client.query(
            `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
            [request.user_id]
          );

          if (userResult.rows.length > 0) {
            await notificationService.sendWithdrawalApproved(
              userResult.rows[0].email,
              request.amount
            );
          }
        } catch (emailError) {
          console.error('Email notification error:', emailError);
        }

      } else {
        await client.query(
          `UPDATE votteryy_withdrawal_requests
           SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
           WHERE request_id = $3`,
          [adminId, adminNotes, requestId]
        );
      }

      await client.query('COMMIT');

      res.json({
        success: true,
        message: action === 'approve' ? 'Withdrawal approved and processed' : 'Withdrawal rejected'
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Review withdrawal error:', error);
      res.status(500).json({ error: 'Failed to review withdrawal' });
    } finally {
      client.release();
    }
  }

  async getBlockedAccounts(req, res) {
    try {
      const userId = req.user.userId;

      const result = await pool.query(
        `SELECT 
           ba.*,
           e.title as election_title,
           e.end_date,
           e.end_time
         FROM votteryy_blocked_accounts ba
         LEFT JOIN votteryyy_elections e ON ba.election_id = e.id
         WHERE ba.user_id = $1 AND ba.status = 'locked'
         ORDER BY ba.created_at DESC`,
        [userId]
      );

      res.json({
        blockedAccounts: result.rows,
        totalBlocked: result.rows.reduce((sum, acc) => sum + parseFloat(acc.amount), 0)
      });

    } catch (error) {
      console.error('Get blocked accounts error:', error);
      res.status(500).json({ error: 'Failed to retrieve blocked accounts' });
    }
  }

  async getWalletAnalytics(req, res) {
    try {
      const userId = req.user.userId;

      console.log('📊 Getting wallet analytics for userId:', userId);

      const depositsResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
         FROM votteryy_transactions
         WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
        [userId]
      );

      const withdrawalsResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
         FROM votteryy_transactions
         WHERE user_id = $1 AND transaction_type = 'withdraw' AND status = 'success'`,
        [userId]
      );

      const prizesResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_prizes, COUNT(*) as prize_count
         FROM votteryy_transactions
         WHERE user_id = $1 AND transaction_type = 'prize_won' AND status = 'success'`,
        [userId]
      );

      const revenueResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(DISTINCT election_id) as election_count
         FROM votteryy_transactions
         WHERE user_id = $1 AND transaction_type = 'election_revenue' AND status = 'success'`,
        [userId]
      );

      const analytics = {
        totalDeposits: parseFloat(depositsResult.rows[0].total_deposits),
        depositCount: parseInt(depositsResult.rows[0].deposit_count),
        totalWithdrawals: parseFloat(withdrawalsResult.rows[0].total_withdrawals),
        withdrawalCount: parseInt(withdrawalsResult.rows[0].withdrawal_count),
        totalPrizesWon: parseFloat(prizesResult.rows[0].total_prizes),
        prizeCount: parseInt(prizesResult.rows[0].prize_count),
        totalElectionFees: parseFloat(revenueResult.rows[0].total_revenue),
        electionCount: parseInt(revenueResult.rows[0].election_count)
      };

      console.log('✅ Analytics calculated:', analytics);

      res.json(analytics);

    } catch (error) {
      console.error('❌ Get wallet analytics error:', error);
      res.status(500).json({ error: 'Failed to retrieve wallet analytics' });
    }
  }

  // ✅ UPDATED: Process election participation payment (now supports Paddle)
  // Replace the payForElection function in wallet.controller.js with this:

  async payForElection(req, res) {
  try {
    const userId = req.user.userId;
    const { electionId, regionCode, paymentGateway = 'stripe' } = req.body;

    let userEmail = `voter${userId}@vottery.com`;
    
    try {
      const userResult = await pool.query(
        `SELECT email FROM users WHERE user_id = $1`,
        [userId]
      );
      
      if (userResult.rows.length > 0 && userResult.rows[0].email) {
        userEmail = userResult.rows[0].email;
      }
    } catch (emailError) {
      console.log('⚠️ Could not fetch user email, using fallback:', userEmail);
    }

    const electionResult = await pool.query(
      `SELECT * FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];

    if (election.is_free) {
      return res.status(400).json({ error: 'This election is free' });
    }

    let amount = 0;

    if (election.pricing_type === 'general_fee') {
      amount = parseFloat(election.general_participation_fee);
    } else if (election.pricing_type === 'regional_fee') {
      const regionalResult = await pool.query(
        `SELECT participation_fee FROM votteryy_election_regional_pricing
         WHERE election_id = $1 AND region_code = $2`,
        [electionId, regionCode]
      );

      if (regionalResult.rows.length === 0) {
        return res.status(400).json({ error: 'Regional pricing not configured for your region' });
      }

      amount = parseFloat(regionalResult.rows[0].participation_fee);
    }

    if (amount <= 0) {
      return res.status(400).json({ error: 'Invalid participation fee' });
    }

    // ✅ EMIT: Payment Initiated
    setImmediate(() => {
      try {
        emitPaymentInitiated(userId, {
          paymentId: `pending-${Date.now()}`,
          amount: amount,
          electionId: electionId,
          electionTitle: election.title,
          gateway: paymentGateway
        });
      } catch (notifError) {
        console.error('⚠️ Failed to emit payment initiated:', notifError.message);
      }
    });

    const paymentResult = await paymentService.processElectionPayment(
      userId,
      electionId,
      amount,
      regionCode,
      paymentGateway,
      userEmail
    );

    res.json({
      success: true,
      payment: paymentResult.payment,
      clientSecret: paymentResult.clientSecret,
      checkoutUrl: paymentResult.checkoutUrl,
      gateway: paymentResult.gateway
    });

  } catch (error) {
    console.error('Pay for election error:', error);
    
    // ✅ EMIT: Payment Failed
    setImmediate(() => {
      try {
        emitPaymentFailed(req.user.userId, {
          paymentId: 'failed',
          amount: 0,
          electionId: req.body.electionId,
          electionTitle: 'Unknown',
          error: error.message
        });
      } catch (notifError) {
        console.error('⚠️ Failed to emit payment failed:', notifError.message);
      }
    });

    res.status(500).json({ error: error.message || 'Failed to process election payment' });
  }
}


//socket version
async confirmElectionPayment(req, res) {
  try {
    const { paymentIntentId, electionId } = req.body;

    console.log('🔔 Confirmation request received:', { 
      paymentIntentId, 
      electionId,
      hasSignature: !!req.headers['stripe-signature']
    });

    const sig = req.headers['stripe-signature'];
    if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
      try {
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        const event = stripe.webhooks.constructEvent(
          req.rawBody,
          sig, 
          process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('✅ Webhook signature verified:', event.type);
      } catch (err) {
        console.error('⚠️ Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } else {
      console.log('ℹ️ No signature - treating as direct API call');
    }

    await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

    // ✅ GET PAYMENT DETAILS FOR NOTIFICATION
    const paymentResult = await pool.query(
      `SELECT ep.*, e.title as election_title
       FROM votteryy_election_payments ep
       JOIN votteryyy_elections e ON ep.election_id = e.id
       WHERE ep.gateway_transaction_id = $1`,
      [paymentIntentId]
    );

    if (paymentResult.rows.length > 0) {
      const payment = paymentResult.rows[0];
      
      // ✅ EMIT: Payment Success
      setImmediate(() => {
        try {
          emitPaymentSuccess(payment.user_id, {
            paymentId: payment.payment_id,
            amount: parseFloat(payment.amount),
            electionId: payment.election_id,
            electionTitle: payment.election_title
          });
        } catch (notifError) {
          console.error('⚠️ Failed to emit payment success:', notifError.message);
        }
      });
    }

    res.json({ 
      success: true, 
      message: 'Payment confirmed and funds blocked until election ends' 
    });

  } catch (error) {
    console.error('❌ Confirm election payment error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
}
//non sockit version
// async confirmElectionPayment(req, res) {
//   try {
//     const { paymentIntentId, electionId } = req.body;

//     console.log('🔔 Confirmation request received:', { 
//       paymentIntentId, 
//       electionId,
//       hasSignature: !!req.headers['stripe-signature']
//     });

//     // ✅ Only verify signature if it's present (webhook call)
//     const sig = req.headers['stripe-signature'];
//     if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
//       try {
//         // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
//         const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
//         const event = stripe.webhooks.constructEvent(
//           req.rawBody,  // Need raw body for webhooks
//           sig, 
//           process.env.STRIPE_WEBHOOK_SECRET
//         );
//         console.log('✅ Webhook signature verified:', event.type);
//       } catch (err) {
//         console.error('⚠️ Webhook signature verification failed:', err.message);
//         return res.status(400).json({ error: 'Invalid signature' });
//       }
//     } else {
//       console.log('ℹ️ No signature - treating as direct API call');
//     }

//     // ✅ Confirm payment regardless of source
//     await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

//     res.json({ 
//       success: true, 
//       message: 'Payment confirmed and funds blocked until election ends' 
//     });

//   } catch (error) {
//     console.error('❌ Confirm election payment error:', error);
//     res.status(500).json({ error: 'Failed to confirm payment' });
//   }
// }

  // ✅ NEW: Paddle Webhook Handler
  async handlePaddleWebhook(req, res) {
    try {
      const payload = req.body;
      
      console.log('🔔 Paddle webhook received:', payload.alert_name);

      switch (payload.alert_name) {
        case 'payment_succeeded':
          await this.handlePaddlePaymentSucceeded(payload);
          break;

        case 'payment_refunded':
          await this.handlePaddlePaymentRefunded(payload);
          break;

        case 'subscription_payment_succeeded':
          console.log('Subscription payment - not handling for elections');
          break;

        default:
          console.log('⚠️ Unhandled Paddle event:', payload.alert_name);
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('❌ Paddle webhook error:', error);
      return res.status(500).json({ error: 'Webhook processing failed' });
    }
  }

  // ✅ NEW: Handle Paddle payment_succeeded
  async handlePaddlePaymentSucceeded(payload) {
    try {
      const orderId = payload.order_id;
      const passthrough = JSON.parse(payload.passthrough);
      const { electionId } = passthrough;

      console.log('💳 Processing Paddle payment:', { orderId, electionId });

      await paymentService.confirmPaymentAndBlock(orderId, electionId);

      console.log('✅ Paddle payment processed successfully');
    } catch (error) {
      console.error('❌ Error handling Paddle payment:', error);
      throw error;
    }
  }

  // ✅ NEW: Handle Paddle refund
  async handlePaddlePaymentRefunded(payload) {
    try {
      const orderId = payload.order_id;
      
      console.log('💸 Processing Paddle refund:', orderId);

      await pool.query(
        `UPDATE votteryy_election_payments
         SET status = 'refunded',
             updated_at = CURRENT_TIMESTAMP
         WHERE gateway_transaction_id = $1`,
        [orderId]
      );

      console.log('✅ Paddle refund processed');
    } catch (error) {
      console.error('❌ Error handling Paddle refund:', error);
      throw error;
    }
  }

  async checkElectionPaymentStatus(req, res) {
    try {
      const userId = req.user.userId;
      const { electionId } = req.params;

      const paymentResult = await pool.query(
        `SELECT * FROM votteryy_election_payments
         WHERE user_id = $1 AND election_id = $2 AND status = 'succeeded'
         LIMIT 1`,
        [userId, electionId]
      );

      const paid = paymentResult.rows.length > 0;

      res.json({
        paid,
        payment: paid ? paymentResult.rows[0] : null
      });

    } catch (error) {
      console.error('Check participation fee status error:', error);
      res.status(500).json({ error: 'Failed to check payment status' });
    }
  }

  async distributeLotteryPrizes(req, res) {
    try {
      const { electionId } = req.params;
      
      const winnersResult = await pool.query(
        `SELECT lw.*, v.user_id, ud.email 
         FROM votteryy_lottery_winners lw
         JOIN votteryy_votings v ON lw.voting_id = v.voting_id
         JOIN votteryy_user_details ud ON v.user_id = ud.user_id
         WHERE lw.election_id = $1 AND lw.prize_claimed = false`,
        [electionId]
      );

      const electionResult = await pool.query(
        `SELECT prize_amount, auto_distribute_threshold FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      const election = electionResult.rows[0];
      const autoDistribute = election.prize_amount < election.auto_distribute_threshold;

      for (const winner of winnersResult.rows) {
        if (autoDistribute) {
          await this.creditPrizeToWallet(winner.user_id, winner.prize_amount, electionId);
        } else {
          await pool.query(
            `INSERT INTO votteryy_prize_distribution_queue 
             (user_id, election_id, amount, status)
             VALUES ($1, $2, $3, 'pending_review')`,
            [winner.user_id, electionId, winner.prize_amount]
          );
        }
      }

      res.json({ success: true, distributedCount: winnersResult.rows.length });
    } catch (error) {
      console.error('Distribute prizes error:', error);
      res.status(500).json({ error: 'Failed to distribute prizes' });
    }
  }

  async creditPrizeToWallet(userId, amount, electionId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE votteryy_user_wallets
         SET balance = balance + $1
         WHERE user_id = $2`,
        [amount, userId]
      );

      await client.query(
        `INSERT INTO votteryy_wallet_transactions
         (user_id, transaction_type, amount, election_id, status, description)
         VALUES ($1, 'prize_won', $2, $3, 'success', 'Lottery prize winnings')`,
        [userId, amount, electionId]
      );

      await client.query(
        `UPDATE votteryy_lottery_winners
         SET prize_claimed = true, claimed_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND election_id = $2`,
        [userId, electionId]
      );

      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMyPrizes(req, res) {
    try {
      const userId = req.user.userId;
      
      const result = await pool.query(
        `SELECT lw.*, e.title as election_title
         FROM votteryy_lottery_winners lw
         JOIN votteryyy_elections e ON lw.election_id = e.id
         WHERE lw.user_id = $1
         ORDER BY lw.created_at DESC`,
        [userId]
      );

      res.json({ prizes: result.rows });
    } catch (error) {
      console.error('Get my prizes error:', error);
      res.status(500).json({ error: 'Failed to retrieve prizes' });
    }
  }

  async getPendingPrizeDistributions(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Get pending prize distributions error:', error);
      res.status(500).json({ error: 'Failed to retrieve pending prize distributions' });
    }
  }

  async reviewPrizeDistribution(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Review prize distribution error:', error);
      res.status(500).json({ error: 'Failed to review prize distribution' });
    }
  }

  async fundPrizePool(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Fund prize pool error:', error);
      res.status(500).json({ error: 'Failed to fund prize pool' });
    }
  }

  async confirmPrizeFunding(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Confirm prize funding error:', error);
      res.status(500).json({ error: 'Failed to confirm prize funding' });
    }
  }

  async getSponsoredElections(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Get sponsored elections error:', error);
      res.status(500).json({ error: 'Failed to retrieve sponsored elections' });
    }
  }

  async refundFailedElection(req, res) {
    try {
      res.status(501).json({ error: 'Feature not implemented yet' });
    } catch (error) {
      console.error('Refund failed election error:', error);
      res.status(500).json({ error: 'Failed to refund election' });
    }
  }

  // ==========================================
// LOTTERY DEPOSIT METHODS
// ==========================================

/**
 * Create Stripe checkout for lottery prize deposit
 */
async createLotteryDepositCheckout(req, res) {
  try {
    const userId = req.user.userId;
    const { electionId } = req.params;
    const { amount } = req.body;


    
// ✅ Add defensive URL handling
    let frontendUrl = process.env.FRONTEND_URL;
    console.log('🔍 Raw FRONTEND_URL:', frontendUrl);





    console.log('💰 Creating lottery deposit checkout:', { electionId, userId, amount });

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid deposit amount' });
    }

    // Validate election ownership
    const electionResult = await pool.query(
      `SELECT id, title, lottery_enabled, lottery_prize_funding_source,
              lottery_total_prize_pool, lottery_estimated_value
       FROM votteryyy_elections 
       WHERE id = $1 AND creator_id = $2`,
      [electionId, userId]
    );

    if (electionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found or unauthorized' });
    }

    const election = electionResult.rows[0];

    if (!election.lottery_enabled) {
      return res.status(400).json({ error: 'Lottery is not enabled for this election' });
    }

    if (election.lottery_prize_funding_source !== 'creator_funded') {
      return res.status(400).json({ error: 'This election does not require creator deposit' });
    }

    // Check if already deposited
    const existingDeposit = await pool.query(
      `SELECT status FROM votteryy_lottery_escrow 
       WHERE election_id = $1 AND creator_id = $2`,
      [electionId, userId]
    );

    if (existingDeposit.rows.length > 0 && existingDeposit.rows[0].status === 'completed') {
      return res.status(400).json({ 
        error: 'Deposit already completed',
        status: 'completed'
      });
    }

    // ✅ FIXED: Use Stripe with ES Modules
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Lottery Prize Pool Deposit`,
            description: `Prize pool deposit for: ${election.title}`,
          },
          unit_amount: Math.round(amount * 100), // Convert to cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/dashboard/creator-wallet?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard/creator-wallet`,
      metadata: {
        election_id: electionId.toString(),
        creator_id: userId.toString(),
        deposit_type: 'lottery_prize',
      },
    });

    // Store/update escrow record
    await pool.query(
      `INSERT INTO votteryy_lottery_escrow 
       (election_id, creator_id, amount, stripe_session_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (election_id) 
       DO UPDATE SET 
         stripe_session_id = $4, 
         status = 'pending',
         created_at = CURRENT_TIMESTAMP`,
      [electionId, userId, amount, session.id]
    );

    console.log('✅ Checkout session created:', session.id);

    res.json({
      success: true,
      sessionId: session.id,
      checkoutUrl: session.url,
    });

  } catch (error) {
    console.error('❌ Create lottery deposit checkout error:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Confirm lottery deposit after Stripe payment
 */

/**
 * Confirm lottery deposit after Stripe payment
 */
async confirmLotteryDeposit(req, res) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const { sessionId } = req.body;

    console.log('🔔 Confirming lottery deposit, session:', sessionId);

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    // ✅ FIXED: Use Stripe with ES Modules
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    console.log('Stripe session status:', session.payment_status);

    if (session.payment_status !== 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Payment not completed',
        paymentStatus: session.payment_status
      });
    }

    const electionId = parseInt(session.metadata.election_id);
    const creatorId = parseInt(session.metadata.creator_id);

    // Update escrow record
    const updateResult = await client.query(
      `UPDATE votteryy_lottery_escrow
       SET 
         status = 'completed',
         stripe_payment_intent_id = $1,
         completed_at = CURRENT_TIMESTAMP
       WHERE stripe_session_id = $2
       RETURNING *`,
      [session.payment_intent, sessionId]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Escrow record not found' });
    }

    const deposit = updateResult.rows[0];
    // ✅✅✅ ADD THESE 7 LINES ✅✅✅
console.log('📢 Updating election status to published for election:', electionId);

await client.query(
  `UPDATE votteryyy_elections
   SET status = 'published', published_at = CURRENT_TIMESTAMP
   WHERE id = $1 AND creator_id = $2`,
  [electionId, creatorId]
);

console.log('✅ Election status updated to PUBLISHED');
// ✅✅✅ END - 7 LINES ADDED ✅✅✅

    await client.query('COMMIT');

    console.log('✅ Lottery deposit confirmed:', {
      electionId,
      creatorId,
      amount: deposit.amount,
      completedAt: deposit.completed_at
    });

    res.json({ 
      success: true, 
      electionId,
      deposit: {
        amount: deposit.amount,
        status: deposit.status,
        completedAt: deposit.completed_at
      },
      message: 'Deposit confirmed! You can now publish your election.'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Confirm lottery deposit error:', error);
    res.status(500).json({ 
      error: 'Failed to confirm deposit',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
}

/**
 * Get lottery deposit status for an election
 */
async getLotteryDepositStatus(req, res) {
  try {
    const userId = req.user.userId;
    const { electionId } = req.params;

    console.log('🔍 Getting lottery deposit status:', { electionId, userId });

    const result = await pool.query(
      `SELECT 
         e.id,
         e.lottery_enabled,
         e.lottery_prize_funding_source,
         e.lottery_total_prize_pool,
         es.status as deposit_status,
         es.amount as deposited_amount,
         es.completed_at,
         es.stripe_session_id
       FROM votteryyy_elections e
       LEFT JOIN votteryy_lottery_escrow es ON e.id = es.election_id AND es.creator_id = $2
       WHERE e.id = $1 AND e.creator_id = $2`,
      [electionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found or unauthorized' });
    }

    const row = result.rows[0];
    const requiresDeposit = row.lottery_enabled && row.lottery_prize_funding_source === 'creator_funded';
    const depositCompleted = row.deposit_status === 'completed';

    res.json({
      success: true,
      requiresDeposit: requiresDeposit,
      depositCompleted: depositCompleted,
      depositStatus: row.deposit_status || 'not_started',
      requiredAmount: parseFloat(row.lottery_total_prize_pool || 0),
      depositedAmount: parseFloat(row.deposited_amount || 0),
      completedAt: row.completed_at,
      canPublish: !requiresDeposit || depositCompleted
    });

  } catch (error) {
    console.error('❌ Get lottery deposit status error:', error);
    res.status(500).json({ 
      error: 'Failed to get deposit status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Get creator's escrow deposits summary
async getCreatorEscrowDeposits(req, res) {
  try {
    const userId = req.user.userId;

    console.log('📊 Getting escrow deposits for creator:', userId);

    const result = await pool.query(
      `SELECT 
         le.*,
         e.title as election_title,
         e.status as election_status,
         e.end_date,
         e.end_time
       FROM votteryy_lottery_escrow le
       JOIN votteryyy_elections e ON le.election_id = e.id
       WHERE le.creator_id = $1
       ORDER BY le.created_at DESC`,
      [userId]
    );

    const deposits = result.rows.map(row => ({
      electionId: row.election_id,
      electionTitle: row.election_title,
      electionStatus: row.election_status,
      amount: parseFloat(row.amount),
      status: row.status,
      completedAt: row.completed_at,
      endDate: row.end_date,
      endTime: row.end_time,
    }));

    const totalEscrowed = deposits
      .filter(d => d.status === 'completed')
      .reduce((sum, d) => sum + d.amount, 0);

    res.json({
      success: true,
      deposits,
      totalEscrowed,
      depositCount: deposits.length,
    });

  } catch (error) {
    console.error('❌ Get escrow deposits error:', error);
    res.status(500).json({ 
      error: 'Failed to get escrow deposits',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
}

export default new WalletController();




// //last workbale code and full functional just to add socket.io above code
// import pool from '../config/database.js';
// import paymentService from '../services/payment.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';
// import { depositSchema, withdrawalSchema } from '../utils/validators.js';
// import Stripe from 'stripe';

// class WalletController {

//   // Check if user can vote (hasn't voted yet)
//   async canUserVote(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { electionId } = req.params;

//       const voteResult = await pool.query(
//         `SELECT voting_id FROM votteryy_votes
//          WHERE user_id = $1 AND election_id = $2
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       const hasVoted = voteResult.rows.length > 0;

//       const electionResult = await pool.query(
//         `SELECT id, status, start_date, end_date, end_time
//          FROM votteryyy_elections
//          WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];
//       const now = new Date();
//       const endDateTime = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//       const canVote = !hasVoted && 
//                       election.status === 'published' && 
//                       now <= endDateTime;

//       res.json({
//         canVote,
//         hasVoted,
//         reason: hasVoted ? 'already_voted' : 
//                 election.status !== 'published' ? 'election_not_active' :
//                 now > endDateTime ? 'election_ended' : null
//       });

//     } catch (error) {
//       console.error('Check vote eligibility error:', error);
//       res.status(500).json({ error: 'Failed to check vote eligibility' });
//     }
//   }

//   async getWallet(req, res) {
//     try {
//       const userId = req.user.userId;

//       console.log('💰 Getting wallet for userId:', userId);

//       const result = await pool.query(
//         `SELECT * FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         console.log('⚠️ Wallet not found, creating new wallet');
        
//         const createResult = await pool.query(
//           `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//            VALUES ($1, 0, 0, 'USD')
//            RETURNING *`,
//           [userId]
//         );

//         console.log('✅ New wallet created:', createResult.rows[0]);
//         return res.json(createResult.rows[0]);
//       }

//       console.log('✅ Wallet found:', result.rows[0]);
//       res.json(result.rows[0]);

//     } catch (error) {
//       console.error('❌ Get wallet error:', error);
//       res.status(500).json({ error: 'Failed to retrieve wallet' });
//     }
//   }

//   async getTransactions(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { 
//         page = 1, 
//         limit = 20, 
//         type, 
//         status, 
//         dateFrom, 
//         dateTo,
//         filterType
//       } = req.query;

//       console.log('📜 Getting transactions for userId:', userId, { page, limit, type, status, filterType });

//       const offset = (page - 1) * limit;

//       let query = `SELECT * FROM votteryy_transactions WHERE user_id = $1`;
//       const params = [userId];
//       let paramIndex = 2;

//       if (type) {
//         query += ` AND transaction_type = $${paramIndex}`;
//         params.push(type);
//         paramIndex++;
//       }

//       if (status) {
//         query += ` AND status = $${paramIndex}`;
//         params.push(status);
//         paramIndex++;
//       }

//       if (filterType) {
//         const now = new Date();
//         let startDate, endDate;

//         switch (filterType) {
//           case 'today':
//             startDate = new Date(now.setHours(0, 0, 0, 0));
//             endDate = new Date(now.setHours(23, 59, 59, 999));
//             break;
//           case 'yesterday':
//             const yesterday = new Date(now);
//             yesterday.setDate(yesterday.getDate() - 1);
//             startDate = new Date(yesterday.setHours(0, 0, 0, 0));
//             endDate = new Date(yesterday.setHours(23, 59, 59, 999));
//             break;
//           case 'last_week':
//             startDate = new Date(now);
//             startDate.setDate(startDate.getDate() - 7);
//             endDate = new Date();
//             break;
//           case 'last_30_days':
//             startDate = new Date(now);
//             startDate.setDate(startDate.getDate() - 30);
//             endDate = new Date();
//             break;
//           case 'custom':
//             if (dateFrom) startDate = new Date(dateFrom);
//             if (dateTo) endDate = new Date(dateTo);
//             break;
//         }

//         if (startDate) {
//           query += ` AND created_at >= $${paramIndex}`;
//           params.push(startDate);
//           paramIndex++;
//         }

//         if (endDate) {
//           query += ` AND created_at <= $${paramIndex}`;
//           params.push(endDate);
//           paramIndex++;
//         }
//       }

//       query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
//       params.push(limit, offset);

//       const result = await pool.query(query, params);

//       let countQuery = `SELECT COUNT(*) FROM votteryy_transactions WHERE user_id = $1`;
//       const countParams = [userId];
//       let countParamIndex = 2;

//       if (type) {
//         countQuery += ` AND transaction_type = $${countParamIndex}`;
//         countParams.push(type);
//         countParamIndex++;
//       }

//       if (status) {
//         countQuery += ` AND status = $${countParamIndex}`;
//         countParams.push(status);
//         countParamIndex++;
//       }

//       const countResult = await pool.query(countQuery, countParams);
//       const totalCount = parseInt(countResult.rows[0].count);

//       console.log('✅ Found transactions:', result.rows.length);

//       res.json({
//         transactions: result.rows,
//         pagination: {
//           page: parseInt(page),
//           limit: parseInt(limit),
//           total: totalCount,
//           totalPages: Math.ceil(totalCount / limit)
//         }
//       });

//     } catch (error) {
//       console.error('❌ Get transactions error:', error);
//       res.status(500).json({ error: 'Failed to retrieve transactions' });
//     }
//   }

//   async deposit(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { amount, paymentMethod, regionCode } = req.body;

//       const { error } = depositSchema.validate({ amount, paymentMethod });
//       if (error) {
//         return res.status(400).json({ error: error.details[0].message });
//       }

//       const processingFeeConfig = await paymentService.getUserProcessingFee(userId);
      
//       const stripeFee = (amount * 0.029) + 0.30;
//       const platformFee = paymentService.calculateProcessingFee(amount, processingFeeConfig);
//       const netAmount = amount - stripeFee - platformFee;

//       const paymentResult = await paymentService.createStripePayment(
//         amount,
//         'USD',
//         { userId, type: 'wallet_deposit' }
//       );

//       await pool.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, stripe_fee, platform_fee, net_amount, status, description, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
//         [
//           userId, 'deposit', amount, stripeFee, platformFee, netAmount, 'pending',
//           'Wallet deposit',
//           JSON.stringify({ paymentIntentId: paymentResult.paymentIntentId })
//         ]
//       );

//       res.json({
//         success: true,
//         clientSecret: paymentResult.clientSecret,
//         paymentIntentId: paymentResult.paymentIntentId,
//         breakdown: {
//           originalAmount: amount.toFixed(2),
//           stripeFee: stripeFee.toFixed(2),
//           platformFee: platformFee.toFixed(2),
//           netAmount: netAmount.toFixed(2)
//         }
//       });
//     } catch (error) {
//       console.error('Deposit error:', error);
//       res.status(500).json({ error: 'Failed to process deposit' });
//     }
//   }

//   async confirmDeposit(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { paymentIntentId } = req.body;

//       const txResult = await client.query(
//         `SELECT * FROM votteryy_wallet_transactions
//          WHERE metadata->>'paymentIntentId' = $1 AND status = 'pending'`,
//         [paymentIntentId]
//       );

//       if (txResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Transaction not found' });
//       }

//       const transaction = txResult.rows[0];

//       await client.query(
//         `UPDATE votteryy_wallet_transactions
//          SET status = 'success', updated_at = CURRENT_TIMESTAMP
//          WHERE transaction_id = $1`,
//         [transaction.transaction_id]
//       );

//       await client.query(
//         `UPDATE votteryy_user_wallets
//          SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [transaction.amount, transaction.user_id]
//       );

//       const depositCountResult = await client.query(
//         `SELECT COUNT(*) as count FROM votteryy_wallet_transactions
//          WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
//         [transaction.user_id]
//       );

//       const depositCount = parseInt(depositCountResult.rows[0].count);

//       if (depositCount === 1) {
//         await client.query(
//           `INSERT INTO user_roles (user_id, role_name, is_active, assigned_date)
//            VALUES ($1, 'sponsor', true, CURRENT_TIMESTAMP)
//            ON CONFLICT (user_id, role_name) DO NOTHING`,
//           [transaction.user_id]
//         );
//       }

//       await client.query('COMMIT');

//       res.json({ success: true, message: 'Deposit confirmed' });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Confirm deposit error:', error);
//       res.status(500).json({ error: 'Failed to confirm deposit' });
//     } finally {
//       client.release();
//     }
//   }

//   async requestWithdrawal(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { amount, paymentMethod, paymentDetails } = req.body;

//       const { error } = withdrawalSchema.validate({ amount, paymentMethod, paymentDetails });
//       if (error) {
//         return res.status(400).json({ error: error.details[0].message });
//       }

//       if (amount < 10) {
//         return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
//       }

//       const withdrawal = await paymentService.processWithdrawal(
//         userId,
//         amount,
//         paymentMethod,
//         paymentDetails
//       );

//       await auditService.logWithdrawal(userId, amount, withdrawal.status, req);

//       try {
//         const userResult = await pool.query(
//           `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
//           [userId]
//         );

//         if (userResult.rows.length > 0) {
//           if (withdrawal.status === 'approved' || withdrawal.status === 'completed') {
//             await notificationService.sendWithdrawalApproved(
//               userResult.rows[0].email,
//               amount
//             );
//           }
//         }
//       } catch (emailError) {
//         console.error('Email notification error:', emailError);
//       }

//       res.json({
//         success: true,
//         withdrawal,
//         message: amount >= 5000 
//           ? 'Withdrawal request submitted for admin review' 
//           : 'Withdrawal processed successfully'
//       });

//     } catch (error) {
//       console.error('Request withdrawal error:', error);
//       res.status(500).json({ error: error.message || 'Failed to process withdrawal request' });
//     }
//   }

//   async getWithdrawalRequests(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { status } = req.query;

//       let query = `SELECT * FROM votteryy_withdrawal_requests WHERE user_id = $1`;
//       const params = [userId];

//       if (status) {
//         query += ` AND status = $2`;
//         params.push(status);
//       }

//       query += ` ORDER BY created_at DESC`;

//       const result = await pool.query(query, params);

//       res.json({
//         withdrawalRequests: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get withdrawal requests error:', error);
//       res.status(500).json({ error: 'Failed to retrieve withdrawal requests' });
//     }
//   }

//   async getPendingWithdrawals(req, res) {
//     try {
//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
//       }

//       const result = await pool.query(
//         `SELECT 
//            wr.*,
//            ud.full_name,
//            ud.email,
//            uw.balance as user_balance
//          FROM votteryy_withdrawal_requests wr
//          LEFT JOIN votteryy_user_details ud ON wr.user_id = ud.user_id
//          LEFT JOIN votteryy_user_wallets uw ON wr.user_id = uw.user_id
//          WHERE wr.status = 'pending'
//          ORDER BY wr.created_at ASC`
//       );

//       res.json({
//         pendingWithdrawals: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get pending withdrawals error:', error);
//       res.status(500).json({ error: 'Failed to retrieve pending withdrawals' });
//     }
//   }

//   async reviewWithdrawal(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
//       }

//       const { requestId } = req.params;
//       const { action, adminNotes } = req.body;
//       const adminId = req.user.userId;

//       if (!['approve', 'reject'].includes(action)) {
//         return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
//       }

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Withdrawal request not found' });
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'pending') {
//         return res.status(400).json({ error: 'Withdrawal request already processed' });
//       }

//       if (action === 'approve') {
//         await client.query(
//           `UPDATE votteryy_withdrawal_requests
//            SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
//            WHERE request_id = $3`,
//           [adminId, adminNotes, requestId]
//         );

//         await paymentService.executeWithdrawal(requestId, adminId);

//         try {
//           const userResult = await client.query(
//             `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
//             [request.user_id]
//           );

//           if (userResult.rows.length > 0) {
//             await notificationService.sendWithdrawalApproved(
//               userResult.rows[0].email,
//               request.amount
//             );
//           }
//         } catch (emailError) {
//           console.error('Email notification error:', emailError);
//         }

//       } else {
//         await client.query(
//           `UPDATE votteryy_withdrawal_requests
//            SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
//            WHERE request_id = $3`,
//           [adminId, adminNotes, requestId]
//         );
//       }

//       await client.query('COMMIT');

//       res.json({
//         success: true,
//         message: action === 'approve' ? 'Withdrawal approved and processed' : 'Withdrawal rejected'
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Review withdrawal error:', error);
//       res.status(500).json({ error: 'Failed to review withdrawal' });
//     } finally {
//       client.release();
//     }
//   }

//   async getBlockedAccounts(req, res) {
//     try {
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT 
//            ba.*,
//            e.title as election_title,
//            e.end_date,
//            e.end_time
//          FROM votteryy_blocked_accounts ba
//          LEFT JOIN votteryyy_elections e ON ba.election_id = e.id
//          WHERE ba.user_id = $1 AND ba.status = 'locked'
//          ORDER BY ba.created_at DESC`,
//         [userId]
//       );

//       res.json({
//         blockedAccounts: result.rows,
//         totalBlocked: result.rows.reduce((sum, acc) => sum + parseFloat(acc.amount), 0)
//       });

//     } catch (error) {
//       console.error('Get blocked accounts error:', error);
//       res.status(500).json({ error: 'Failed to retrieve blocked accounts' });
//     }
//   }

//   async getWalletAnalytics(req, res) {
//     try {
//       const userId = req.user.userId;

//       console.log('📊 Getting wallet analytics for userId:', userId);

//       const depositsResult = await pool.query(
//         `SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
//          FROM votteryy_transactions
//          WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
//         [userId]
//       );

//       const withdrawalsResult = await pool.query(
//         `SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
//          FROM votteryy_transactions
//          WHERE user_id = $1 AND transaction_type = 'withdraw' AND status = 'success'`,
//         [userId]
//       );

//       const prizesResult = await pool.query(
//         `SELECT COALESCE(SUM(amount), 0) as total_prizes, COUNT(*) as prize_count
//          FROM votteryy_transactions
//          WHERE user_id = $1 AND transaction_type = 'prize_won' AND status = 'success'`,
//         [userId]
//       );

//       const revenueResult = await pool.query(
//         `SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(DISTINCT election_id) as election_count
//          FROM votteryy_transactions
//          WHERE user_id = $1 AND transaction_type = 'election_revenue' AND status = 'success'`,
//         [userId]
//       );

//       const analytics = {
//         totalDeposits: parseFloat(depositsResult.rows[0].total_deposits),
//         depositCount: parseInt(depositsResult.rows[0].deposit_count),
//         totalWithdrawals: parseFloat(withdrawalsResult.rows[0].total_withdrawals),
//         withdrawalCount: parseInt(withdrawalsResult.rows[0].withdrawal_count),
//         totalPrizesWon: parseFloat(prizesResult.rows[0].total_prizes),
//         prizeCount: parseInt(prizesResult.rows[0].prize_count),
//         totalElectionFees: parseFloat(revenueResult.rows[0].total_revenue),
//         electionCount: parseInt(revenueResult.rows[0].election_count)
//       };

//       console.log('✅ Analytics calculated:', analytics);

//       res.json(analytics);

//     } catch (error) {
//       console.error('❌ Get wallet analytics error:', error);
//       res.status(500).json({ error: 'Failed to retrieve wallet analytics' });
//     }
//   }

//   // ✅ UPDATED: Process election participation payment (now supports Paddle)
//   // Replace the payForElection function in wallet.controller.js with this:

// async payForElection(req, res) {
//   try {
//     const userId = req.user.userId;
//     const { electionId, regionCode, paymentGateway = 'stripe' } = req.body;

//     // ✅ FIXED: Get user email from correct table
//     let userEmail = `voter${userId}@vottery.com`; // Default fallback
    
//     try {
//       // Try to get email from users table
//       const userResult = await pool.query(
//         `SELECT email FROM users WHERE user_id = $1`,
//         [userId]
//       );
      
//       if (userResult.rows.length > 0 && userResult.rows[0].email) {
//         userEmail = userResult.rows[0].email;
//       }
//     } catch (emailError) {
//       console.log('⚠️ Could not fetch user email, using fallback:', userEmail);
//     }

//     const electionResult = await pool.query(
//       `SELECT * FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];

//     if (election.is_free) {
//       return res.status(400).json({ error: 'This election is free' });
//     }

//     let amount = 0;

//     if (election.pricing_type === 'general_fee') {
//       amount = parseFloat(election.general_participation_fee);
//     } else if (election.pricing_type === 'regional_fee') {
//       const regionalResult = await pool.query(
//         `SELECT participation_fee FROM votteryy_election_regional_pricing
//          WHERE election_id = $1 AND region_code = $2`,
//         [electionId, regionCode]
//       );

//       if (regionalResult.rows.length === 0) {
//         return res.status(400).json({ error: 'Regional pricing not configured for your region' });
//       }

//       amount = parseFloat(regionalResult.rows[0].participation_fee);
//     }

//     if (amount <= 0) {
//       return res.status(400).json({ error: 'Invalid participation fee' });
//     }

//     // ✅ Process payment with gateway parameter
//     const paymentResult = await paymentService.processElectionPayment(
//       userId,
//       electionId,
//       amount,
//       regionCode,
//       paymentGateway,
//       userEmail
//     );

//     res.json({
//       success: true,
//       payment: paymentResult.payment,
//       clientSecret: paymentResult.clientSecret,
//       checkoutUrl: paymentResult.checkoutUrl,
//       gateway: paymentResult.gateway
//     });

//   } catch (error) {
//     console.error('Pay for election error:', error);
//     res.status(500).json({ error: error.message || 'Failed to process election payment' });
//   }
// }


// async confirmElectionPayment(req, res) {
//   try {
//     const { paymentIntentId, electionId } = req.body;

//     console.log('🔔 Confirmation request received:', { 
//       paymentIntentId, 
//       electionId,
//       hasSignature: !!req.headers['stripe-signature']
//     });

//     // ✅ Only verify signature if it's present (webhook call)
//     const sig = req.headers['stripe-signature'];
//     if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
//       try {
//         // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
//         const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
//         const event = stripe.webhooks.constructEvent(
//           req.rawBody,  // Need raw body for webhooks
//           sig, 
//           process.env.STRIPE_WEBHOOK_SECRET
//         );
//         console.log('✅ Webhook signature verified:', event.type);
//       } catch (err) {
//         console.error('⚠️ Webhook signature verification failed:', err.message);
//         return res.status(400).json({ error: 'Invalid signature' });
//       }
//     } else {
//       console.log('ℹ️ No signature - treating as direct API call');
//     }

//     // ✅ Confirm payment regardless of source
//     await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

//     res.json({ 
//       success: true, 
//       message: 'Payment confirmed and funds blocked until election ends' 
//     });

//   } catch (error) {
//     console.error('❌ Confirm election payment error:', error);
//     res.status(500).json({ error: 'Failed to confirm payment' });
//   }
// }

//   // ✅ NEW: Paddle Webhook Handler
//   async handlePaddleWebhook(req, res) {
//     try {
//       const payload = req.body;
      
//       console.log('🔔 Paddle webhook received:', payload.alert_name);

//       switch (payload.alert_name) {
//         case 'payment_succeeded':
//           await this.handlePaddlePaymentSucceeded(payload);
//           break;

//         case 'payment_refunded':
//           await this.handlePaddlePaymentRefunded(payload);
//           break;

//         case 'subscription_payment_succeeded':
//           console.log('Subscription payment - not handling for elections');
//           break;

//         default:
//           console.log('⚠️ Unhandled Paddle event:', payload.alert_name);
//       }

//       return res.json({ success: true });
//     } catch (error) {
//       console.error('❌ Paddle webhook error:', error);
//       return res.status(500).json({ error: 'Webhook processing failed' });
//     }
//   }

//   // ✅ NEW: Handle Paddle payment_succeeded
//   async handlePaddlePaymentSucceeded(payload) {
//     try {
//       const orderId = payload.order_id;
//       const passthrough = JSON.parse(payload.passthrough);
//       const { electionId } = passthrough;

//       console.log('💳 Processing Paddle payment:', { orderId, electionId });

//       await paymentService.confirmPaymentAndBlock(orderId, electionId);

//       console.log('✅ Paddle payment processed successfully');
//     } catch (error) {
//       console.error('❌ Error handling Paddle payment:', error);
//       throw error;
//     }
//   }

//   // ✅ NEW: Handle Paddle refund
//   async handlePaddlePaymentRefunded(payload) {
//     try {
//       const orderId = payload.order_id;
      
//       console.log('💸 Processing Paddle refund:', orderId);

//       await pool.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'refunded',
//              updated_at = CURRENT_TIMESTAMP
//          WHERE gateway_transaction_id = $1`,
//         [orderId]
//       );

//       console.log('✅ Paddle refund processed');
//     } catch (error) {
//       console.error('❌ Error handling Paddle refund:', error);
//       throw error;
//     }
//   }

//   async checkElectionPaymentStatus(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { electionId } = req.params;

//       const paymentResult = await pool.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE user_id = $1 AND election_id = $2 AND status = 'succeeded'
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       const paid = paymentResult.rows.length > 0;

//       res.json({
//         paid,
//         payment: paid ? paymentResult.rows[0] : null
//       });

//     } catch (error) {
//       console.error('Check participation fee status error:', error);
//       res.status(500).json({ error: 'Failed to check payment status' });
//     }
//   }

//   async distributeLotteryPrizes(req, res) {
//     try {
//       const { electionId } = req.params;
      
//       const winnersResult = await pool.query(
//         `SELECT lw.*, v.user_id, ud.email 
//          FROM votteryy_lottery_winners lw
//          JOIN votteryy_votings v ON lw.voting_id = v.voting_id
//          JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//          WHERE lw.election_id = $1 AND lw.prize_claimed = false`,
//         [electionId]
//       );

//       const electionResult = await pool.query(
//         `SELECT prize_amount, auto_distribute_threshold FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       const election = electionResult.rows[0];
//       const autoDistribute = election.prize_amount < election.auto_distribute_threshold;

//       for (const winner of winnersResult.rows) {
//         if (autoDistribute) {
//           await this.creditPrizeToWallet(winner.user_id, winner.prize_amount, electionId);
//         } else {
//           await pool.query(
//             `INSERT INTO votteryy_prize_distribution_queue 
//              (user_id, election_id, amount, status)
//              VALUES ($1, $2, $3, 'pending_review')`,
//             [winner.user_id, electionId, winner.prize_amount]
//           );
//         }
//       }

//       res.json({ success: true, distributedCount: winnersResult.rows.length });
//     } catch (error) {
//       console.error('Distribute prizes error:', error);
//       res.status(500).json({ error: 'Failed to distribute prizes' });
//     }
//   }

//   async creditPrizeToWallet(userId, amount, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       await client.query(
//         `UPDATE votteryy_user_wallets
//          SET balance = balance + $1
//          WHERE user_id = $2`,
//         [amount, userId]
//       );

//       await client.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, election_id, status, description)
//          VALUES ($1, 'prize_won', $2, $3, 'success', 'Lottery prize winnings')`,
//         [userId, amount, electionId]
//       );

//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET prize_claimed = true, claimed_at = CURRENT_TIMESTAMP
//          WHERE user_id = $1 AND election_id = $2`,
//         [userId, electionId]
//       );

//       await client.query('COMMIT');
//       return { success: true };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async getMyPrizes(req, res) {
//     try {
//       const userId = req.user.userId;
      
//       const result = await pool.query(
//         `SELECT lw.*, e.title as election_title
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          WHERE lw.user_id = $1
//          ORDER BY lw.created_at DESC`,
//         [userId]
//       );

//       res.json({ prizes: result.rows });
//     } catch (error) {
//       console.error('Get my prizes error:', error);
//       res.status(500).json({ error: 'Failed to retrieve prizes' });
//     }
//   }

//   async getPendingPrizeDistributions(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Get pending prize distributions error:', error);
//       res.status(500).json({ error: 'Failed to retrieve pending prize distributions' });
//     }
//   }

//   async reviewPrizeDistribution(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Review prize distribution error:', error);
//       res.status(500).json({ error: 'Failed to review prize distribution' });
//     }
//   }

//   async fundPrizePool(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Fund prize pool error:', error);
//       res.status(500).json({ error: 'Failed to fund prize pool' });
//     }
//   }

//   async confirmPrizeFunding(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Confirm prize funding error:', error);
//       res.status(500).json({ error: 'Failed to confirm prize funding' });
//     }
//   }

//   async getSponsoredElections(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Get sponsored elections error:', error);
//       res.status(500).json({ error: 'Failed to retrieve sponsored elections' });
//     }
//   }

//   async refundFailedElection(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Refund failed election error:', error);
//       res.status(500).json({ error: 'Failed to refund election' });
//     }
//   }

//   // ==========================================
// // LOTTERY DEPOSIT METHODS
// // ==========================================

// /**
//  * Create Stripe checkout for lottery prize deposit
//  */
// async createLotteryDepositCheckout(req, res) {
//   try {
//     const userId = req.user.userId;
//     const { electionId } = req.params;
//     const { amount } = req.body;

//     console.log('💰 Creating lottery deposit checkout:', { electionId, userId, amount });

//     if (!amount || amount <= 0) {
//       return res.status(400).json({ error: 'Invalid deposit amount' });
//     }

//     // Validate election ownership
//     const electionResult = await pool.query(
//       `SELECT id, title, lottery_enabled, lottery_prize_funding_source,
//               lottery_total_prize_pool, lottery_estimated_value
//        FROM votteryyy_elections 
//        WHERE id = $1 AND creator_id = $2`,
//       [electionId, userId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found or unauthorized' });
//     }

//     const election = electionResult.rows[0];

//     if (!election.lottery_enabled) {
//       return res.status(400).json({ error: 'Lottery is not enabled for this election' });
//     }

//     if (election.lottery_prize_funding_source !== 'creator_funded') {
//       return res.status(400).json({ error: 'This election does not require creator deposit' });
//     }

//     // Check if already deposited
//     const existingDeposit = await pool.query(
//       `SELECT status FROM votteryy_lottery_escrow 
//        WHERE election_id = $1 AND creator_id = $2`,
//       [electionId, userId]
//     );

//     if (existingDeposit.rows.length > 0 && existingDeposit.rows[0].status === 'completed') {
//       return res.status(400).json({ 
//         error: 'Deposit already completed',
//         status: 'completed'
//       });
//     }

//     // ✅ FIXED: Use Stripe with ES Modules
//     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    
//     const session = await stripe.checkout.sessions.create({
//       payment_method_types: ['card'],
//       line_items: [{
//         price_data: {
//           currency: 'usd',
//           product_data: {
//             name: `Lottery Prize Pool Deposit`,
//             description: `Prize pool deposit for: ${election.title}`,
//           },
//           unit_amount: Math.round(amount * 100), // Convert to cents
//         },
//         quantity: 1,
//       }],
//       mode: 'payment',
//       success_url: `${process.env.FRONTEND_URL}/dashboard/creator-wallet?session_id={CHECKOUT_SESSION_ID}`,
//       cancel_url: `${process.env.FRONTEND_URL}/dashboard/creator-wallet`,
//       metadata: {
//         election_id: electionId.toString(),
//         creator_id: userId.toString(),
//         deposit_type: 'lottery_prize',
//       },
//     });

//     // Store/update escrow record
//     await pool.query(
//       `INSERT INTO votteryy_lottery_escrow 
//        (election_id, creator_id, amount, stripe_session_id, status)
//        VALUES ($1, $2, $3, $4, 'pending')
//        ON CONFLICT (election_id) 
//        DO UPDATE SET 
//          stripe_session_id = $4, 
//          status = 'pending',
//          created_at = CURRENT_TIMESTAMP`,
//       [electionId, userId, amount, session.id]
//     );

//     console.log('✅ Checkout session created:', session.id);

//     res.json({
//       success: true,
//       sessionId: session.id,
//       checkoutUrl: session.url,
//     });

//   } catch (error) {
//     console.error('❌ Create lottery deposit checkout error:', error);
//     res.status(500).json({ 
//       error: 'Failed to create checkout session',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }

// /**
//  * Confirm lottery deposit after Stripe payment
//  */

// /**
//  * Confirm lottery deposit after Stripe payment
//  */
// async confirmLotteryDeposit(req, res) {
//   const client = await pool.connect();
  
//   try {
//     await client.query('BEGIN');

//     const { sessionId } = req.body;

//     console.log('🔔 Confirming lottery deposit, session:', sessionId);

//     if (!sessionId) {
//       return res.status(400).json({ error: 'Session ID required' });
//     }

//     // ✅ FIXED: Use Stripe with ES Modules
//     const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
//     const session = await stripe.checkout.sessions.retrieve(sessionId);

//     console.log('Stripe session status:', session.payment_status);

//     if (session.payment_status !== 'paid') {
//       await client.query('ROLLBACK');
//       return res.status(400).json({ 
//         error: 'Payment not completed',
//         paymentStatus: session.payment_status
//       });
//     }

//     const electionId = parseInt(session.metadata.election_id);
//     const creatorId = parseInt(session.metadata.creator_id);

//     // Update escrow record
//     const updateResult = await client.query(
//       `UPDATE votteryy_lottery_escrow
//        SET 
//          status = 'completed',
//          stripe_payment_intent_id = $1,
//          completed_at = CURRENT_TIMESTAMP
//        WHERE stripe_session_id = $2
//        RETURNING *`,
//       [session.payment_intent, sessionId]
//     );

//     if (updateResult.rows.length === 0) {
//       await client.query('ROLLBACK');
//       return res.status(404).json({ error: 'Escrow record not found' });
//     }

//     const deposit = updateResult.rows[0];

//     await client.query('COMMIT');

//     console.log('✅ Lottery deposit confirmed:', {
//       electionId,
//       creatorId,
//       amount: deposit.amount,
//       completedAt: deposit.completed_at
//     });

//     res.json({ 
//       success: true, 
//       electionId,
//       deposit: {
//         amount: deposit.amount,
//         status: deposit.status,
//         completedAt: deposit.completed_at
//       },
//       message: 'Deposit confirmed! You can now publish your election.'
//     });

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('❌ Confirm lottery deposit error:', error);
//     res.status(500).json({ 
//       error: 'Failed to confirm deposit',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   } finally {
//     client.release();
//   }
// }

// /**
//  * Get lottery deposit status for an election
//  */
// async getLotteryDepositStatus(req, res) {
//   try {
//     const userId = req.user.userId;
//     const { electionId } = req.params;

//     console.log('🔍 Getting lottery deposit status:', { electionId, userId });

//     const result = await pool.query(
//       `SELECT 
//          e.id,
//          e.lottery_enabled,
//          e.lottery_prize_funding_source,
//          e.lottery_total_prize_pool,
//          es.status as deposit_status,
//          es.amount as deposited_amount,
//          es.completed_at,
//          es.stripe_session_id
//        FROM votteryyy_elections e
//        LEFT JOIN votteryy_lottery_escrow es ON e.id = es.election_id AND es.creator_id = $2
//        WHERE e.id = $1 AND e.creator_id = $2`,
//       [electionId, userId]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found or unauthorized' });
//     }

//     const row = result.rows[0];
//     const requiresDeposit = row.lottery_enabled && row.lottery_prize_funding_source === 'creator_funded';
//     const depositCompleted = row.deposit_status === 'completed';

//     res.json({
//       success: true,
//       requiresDeposit: requiresDeposit,
//       depositCompleted: depositCompleted,
//       depositStatus: row.deposit_status || 'not_started',
//       requiredAmount: parseFloat(row.lottery_total_prize_pool || 0),
//       depositedAmount: parseFloat(row.deposited_amount || 0),
//       completedAt: row.completed_at,
//       canPublish: !requiresDeposit || depositCompleted
//     });

//   } catch (error) {
//     console.error('❌ Get lottery deposit status error:', error);
//     res.status(500).json({ 
//       error: 'Failed to get deposit status',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }

// // Get creator's escrow deposits summary
// async getCreatorEscrowDeposits(req, res) {
//   try {
//     const userId = req.user.userId;

//     console.log('📊 Getting escrow deposits for creator:', userId);

//     const result = await pool.query(
//       `SELECT 
//          le.*,
//          e.title as election_title,
//          e.status as election_status,
//          e.end_date,
//          e.end_time
//        FROM votteryy_lottery_escrow le
//        JOIN votteryyy_elections e ON le.election_id = e.id
//        WHERE le.creator_id = $1
//        ORDER BY le.created_at DESC`,
//       [userId]
//     );

//     const deposits = result.rows.map(row => ({
//       electionId: row.election_id,
//       electionTitle: row.election_title,
//       electionStatus: row.election_status,
//       amount: parseFloat(row.amount),
//       status: row.status,
//       completedAt: row.completed_at,
//       endDate: row.end_date,
//       endTime: row.end_time,
//     }));

//     const totalEscrowed = deposits
//       .filter(d => d.status === 'completed')
//       .reduce((sum, d) => sum + d.amount, 0);

//     res.json({
//       success: true,
//       deposits,
//       totalEscrowed,
//       depositCount: deposits.length,
//     });

//   } catch (error) {
//     console.error('❌ Get escrow deposits error:', error);
//     res.status(500).json({ 
//       error: 'Failed to get escrow deposits',
//       details: process.env.NODE_ENV === 'development' ? error.message : undefined
//     });
//   }
// }
// }

// export default new WalletController();















//last workable code
// import pool from '../config/database.js';
// import paymentService from '../services/payment.service.js';
// import auditService from '../services/audit.service.js';
// import notificationService from '../services/notification.service.js';
// import { depositSchema, withdrawalSchema } from '../utils/validators.js';

// class WalletController {

//   // Check if user can vote (hasn't voted yet)
//   async canUserVote(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { electionId } = req.params;

//       // Check if user already voted
//       const voteResult = await pool.query(
//         `SELECT voting_id FROM votteryy_votings
//          WHERE user_id = $1 AND election_id = $2
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       const hasVoted = voteResult.rows.length > 0;

//       // Check if election exists and is active
//       const electionResult = await pool.query(
//         `SELECT id, status, start_date, end_date, end_time
//          FROM votteryyy_elections
//          WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];
//       const now = new Date();
//       const endDateTime = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//       const canVote = !hasVoted && 
//                       election.status === 'published' && 
//                       now <= endDateTime;

//       res.json({
//         canVote,
//         hasVoted,
//         reason: hasVoted ? 'already_voted' : 
//                 election.status !== 'published' ? 'election_not_active' :
//                 now > endDateTime ? 'election_ended' : null
//       });

//     } catch (error) {
//       console.error('Check vote eligibility error:', error);
//       res.status(500).json({ error: 'Failed to check vote eligibility' });
//     }
//   }

//   // Get user wallet
// async getWallet(req, res) {
//   try {
//     const userId = req.user.userId;

//     console.log('💰 Getting wallet for userId:', userId);

//     const result = await pool.query(
//       `SELECT * FROM votteryy_wallets WHERE user_id = $1`,
//       [userId]
//     );

//     if (result.rows.length === 0) {
//       console.log('⚠️ Wallet not found, creating new wallet');
      
//       // Create wallet if doesn't exist
//       const createResult = await pool.query(
//         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, 0, 0, 'USD')
//          RETURNING *`,
//         [userId]
//       );

//       console.log('✅ New wallet created:', createResult.rows[0]);
//       return res.json(createResult.rows[0]);
//     }

//     console.log('✅ Wallet found:', result.rows[0]);
//     res.json(result.rows[0]);

//   } catch (error) {
//     console.error('❌ Get wallet error:', error);
//     res.status(500).json({ error: 'Failed to retrieve wallet' });
//   }
// }

// async getTransactions(req, res) {
//   try {
//     const userId = req.user.userId;
//     const { 
//       page = 1, 
//       limit = 20, 
//       type, 
//       status, 
//       dateFrom, 
//       dateTo,
//       filterType
//     } = req.query;

//     console.log('📜 Getting transactions for userId:', userId, { page, limit, type, status, filterType });

//     const offset = (page - 1) * limit;

//     // Build query
//     let query = `SELECT * FROM votteryy_transactions WHERE user_id = $1`;
//     const params = [userId];
//     let paramIndex = 2;

//     if (type) {
//       query += ` AND transaction_type = $${paramIndex}`;
//       params.push(type);
//       paramIndex++;
//     }

//     if (status) {
//       query += ` AND status = $${paramIndex}`;
//       params.push(status);
//       paramIndex++;
//     }

//     // Date filters based on filterType
//     if (filterType) {
//       const now = new Date();
//       let startDate, endDate;

//       switch (filterType) {
//         case 'today':
//           startDate = new Date(now.setHours(0, 0, 0, 0));
//           endDate = new Date(now.setHours(23, 59, 59, 999));
//           break;
//         case 'yesterday':
//           const yesterday = new Date(now);
//           yesterday.setDate(yesterday.getDate() - 1);
//           startDate = new Date(yesterday.setHours(0, 0, 0, 0));
//           endDate = new Date(yesterday.setHours(23, 59, 59, 999));
//           break;
//         case 'last_week':
//           startDate = new Date(now);
//           startDate.setDate(startDate.getDate() - 7);
//           endDate = new Date();
//           break;
//         case 'last_30_days':
//           startDate = new Date(now);
//           startDate.setDate(startDate.getDate() - 30);
//           endDate = new Date();
//           break;
//         case 'custom':
//           if (dateFrom) startDate = new Date(dateFrom);
//           if (dateTo) endDate = new Date(dateTo);
//           break;
//       }

//       if (startDate) {
//         query += ` AND created_at >= $${paramIndex}`;
//         params.push(startDate);
//         paramIndex++;
//       }

//       if (endDate) {
//         query += ` AND created_at <= $${paramIndex}`;
//         params.push(endDate);
//         paramIndex++;
//       }
//     }

//     query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
//     params.push(limit, offset);

//     const result = await pool.query(query, params);

//     // Get total count
//     let countQuery = `SELECT COUNT(*) FROM votteryy_transactions WHERE user_id = $1`;
//     const countParams = [userId];
//     let countParamIndex = 2;

//     if (type) {
//       countQuery += ` AND transaction_type = $${countParamIndex}`;
//       countParams.push(type);
//       countParamIndex++;
//     }

//     if (status) {
//       countQuery += ` AND status = $${countParamIndex}`;
//       countParams.push(status);
//       countParamIndex++;
//     }

//     const countResult = await pool.query(countQuery, countParams);
//     const totalCount = parseInt(countResult.rows[0].count);

//     console.log('✅ Found transactions:', result.rows.length);

//     res.json({
//       transactions: result.rows,
//       pagination: {
//         page: parseInt(page),
//         limit: parseInt(limit),
//         total: totalCount,
//         totalPages: Math.ceil(totalCount / limit)
//       }
//     });

//   } catch (error) {
//     console.error('❌ Get transactions error:', error);
//     res.status(500).json({ error: 'Failed to retrieve transactions' });
//   }
// }

//   // Deposit funds
//   async deposit(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { amount, paymentMethod, regionCode } = req.body;

//       const { error } = depositSchema.validate({ amount, paymentMethod });
//       if (error) {
//         return res.status(400).json({ error: error.details[0].message });
//       }

//       // ✅ Get fee from subscription
//       const processingFeeConfig = await paymentService.getUserProcessingFee(userId);
      
//       const stripeFee = (amount * 0.029) + 0.30;
//       const platformFee = paymentService.calculateProcessingFee(amount, processingFeeConfig);
//       const netAmount = amount - stripeFee - platformFee;

//       const paymentResult = await paymentService.createStripePayment(
//         amount,
//         'USD',
//         { userId, type: 'wallet_deposit' }
//       );

//       await pool.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, stripe_fee, platform_fee, net_amount, status, description, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
//         [
//           userId, 'deposit', amount, stripeFee, platformFee, netAmount, 'pending',
//           'Wallet deposit',
//           JSON.stringify({ paymentIntentId: paymentResult.paymentIntentId })
//         ]
//       );

//       res.json({
//         success: true,
//         clientSecret: paymentResult.clientSecret,
//         paymentIntentId: paymentResult.paymentIntentId,
//         breakdown: {
//           originalAmount: amount.toFixed(2),
//           stripeFee: stripeFee.toFixed(2),
//           platformFee: platformFee.toFixed(2),
//           netAmount: netAmount.toFixed(2)
//         }
//       });
//     } catch (error) {
//       console.error('Deposit error:', error);
//       res.status(500).json({ error: 'Failed to process deposit' });
//     }
//   }

//   // Confirm deposit (webhook callback)
//   async confirmDeposit(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const { paymentIntentId } = req.body;

//       // Get transaction
//       const txResult = await client.query(
//         `SELECT * FROM votteryy_wallet_transactions
//          WHERE metadata->>'paymentIntentId' = $1 AND status = 'pending'`,
//         [paymentIntentId]
//       );

//       if (txResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Transaction not found' });
//       }

//       const transaction = txResult.rows[0];

//       // Update transaction status
//       await client.query(
//         `UPDATE votteryy_wallet_transactions
//          SET status = 'success', updated_at = CURRENT_TIMESTAMP
//          WHERE transaction_id = $1`,
//         [transaction.transaction_id]
//       );

//       // Update wallet balance
//       await client.query(
//         `UPDATE votteryy_user_wallets
//          SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [transaction.amount, transaction.user_id]
//       );

//       // Check if this is first deposit - assign Sponsor role
//       const depositCountResult = await client.query(
//         `SELECT COUNT(*) as count FROM votteryy_wallet_transactions
//          WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
//         [transaction.user_id]
//       );

//       const depositCount = parseInt(depositCountResult.rows[0].count);

//       if (depositCount === 1) {
//         // First deposit - assign Sponsor role
//         await client.query(
//           `INSERT INTO user_roles (user_id, role_name, is_active, assigned_date)
//            VALUES ($1, 'sponsor', true, CURRENT_TIMESTAMP)
//            ON CONFLICT (user_id, role_name) DO NOTHING`,
//           [transaction.user_id]
//         );
//       }

//       await client.query('COMMIT');

//       res.json({ success: true, message: 'Deposit confirmed' });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Confirm deposit error:', error);
//       res.status(500).json({ error: 'Failed to confirm deposit' });
//     } finally {
//       client.release();
//     }
//   }

//   // Request withdrawal
//   async requestWithdrawal(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { amount, paymentMethod, paymentDetails } = req.body;

//       // Validate
//       const { error } = withdrawalSchema.validate({ amount, paymentMethod, paymentDetails });
//       if (error) {
//         return res.status(400).json({ error: error.details[0].message });
//       }

//       // Check minimum withdrawal
//       if (amount < 10) {
//         return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
//       }

//       // Process withdrawal
//       const withdrawal = await paymentService.processWithdrawal(
//         userId,
//         amount,
//         paymentMethod,
//         paymentDetails
//       );

//       // Log audit
//       await auditService.logWithdrawal(userId, amount, withdrawal.status, req);

//       // Send notification
//       try {
//         const userResult = await pool.query(
//           `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
//           [userId]
//         );

//         if (userResult.rows.length > 0) {
//           if (withdrawal.status === 'approved' || withdrawal.status === 'completed') {
//             await notificationService.sendWithdrawalApproved(
//               userResult.rows[0].email,
//               amount
//             );
//           }
//         }
//       } catch (emailError) {
//         console.error('Email notification error:', emailError);
//       }

//       res.json({
//         success: true,
//         withdrawal,
//         message: amount >= 5000 
//           ? 'Withdrawal request submitted for admin review' 
//           : 'Withdrawal processed successfully'
//       });

//     } catch (error) {
//       console.error('Request withdrawal error:', error);
//       res.status(500).json({ error: error.message || 'Failed to process withdrawal request' });
//     }
//   }

//   // Get withdrawal requests (user's own)
//   async getWithdrawalRequests(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { status } = req.query;

//       let query = `SELECT * FROM votteryy_withdrawal_requests WHERE user_id = $1`;
//       const params = [userId];

//       if (status) {
//         query += ` AND status = $2`;
//         params.push(status);
//       }

//       query += ` ORDER BY created_at DESC`;

//       const result = await pool.query(query, params);

//       res.json({
//         withdrawalRequests: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get withdrawal requests error:', error);
//       res.status(500).json({ error: 'Failed to retrieve withdrawal requests' });
//     }
//   }

//   // Admin: Get all pending withdrawals
//   async getPendingWithdrawals(req, res) {
//     try {
//       // Verify admin role
//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
//       }

//       const result = await pool.query(
//         `SELECT 
//            wr.*,
//            ud.full_name,
//            ud.email,
//            uw.balance as user_balance
//          FROM votteryy_withdrawal_requests wr
//          LEFT JOIN votteryy_user_details ud ON wr.user_id = ud.user_id
//          LEFT JOIN votteryy_user_wallets uw ON wr.user_id = uw.user_id
//          WHERE wr.status = 'pending'
//          ORDER BY wr.created_at ASC`
//       );

//       res.json({
//         pendingWithdrawals: result.rows,
//         totalCount: result.rows.length
//       });

//     } catch (error) {
//       console.error('Get pending withdrawals error:', error);
//       res.status(500).json({ error: 'Failed to retrieve pending withdrawals' });
//     }
//   }

//   // Admin: Approve/Reject withdrawal
//   async reviewWithdrawal(req, res) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Verify admin role
//       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
//         return res.status(403).json({ error: 'Admin access required' });
//       }

//       const { requestId } = req.params;
//       const { action, adminNotes } = req.body; // action: approve or reject
//       const adminId = req.user.userId;

//       if (!['approve', 'reject'].includes(action)) {
//         return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
//       }

//       // Get withdrawal request
//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Withdrawal request not found' });
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'pending') {
//         return res.status(400).json({ error: 'Withdrawal request already processed' });
//       }

//       if (action === 'approve') {
//         // Approve and execute
//         await client.query(
//           `UPDATE votteryy_withdrawal_requests
//            SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
//            WHERE request_id = $3`,
//           [adminId, adminNotes, requestId]
//         );

//         // Execute withdrawal
//         await paymentService.executeWithdrawal(requestId, adminId);

//         // Send notification
//         try {
//           const userResult = await client.query(
//             `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
//             [request.user_id]
//           );

//           if (userResult.rows.length > 0) {
//             await notificationService.sendWithdrawalApproved(
//               userResult.rows[0].email,
//               request.amount
//             );
//           }
//         } catch (emailError) {
//           console.error('Email notification error:', emailError);
//         }

//       } else {
//         // Reject
//         await client.query(
//           `UPDATE votteryy_withdrawal_requests
//            SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
//            WHERE request_id = $3`,
//           [adminId, adminNotes, requestId]
//         );

//         // Note: Balance was never deducted, so no need to refund
//       }

//       await client.query('COMMIT');

//       res.json({
//         success: true,
//         message: action === 'approve' ? 'Withdrawal approved and processed' : 'Withdrawal rejected'
//       });

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('Review withdrawal error:', error);
//       res.status(500).json({ error: 'Failed to review withdrawal' });
//     } finally {
//       client.release();
//     }
//   }

//   // Get blocked accounts (funds held until election ends)
//   async getBlockedAccounts(req, res) {
//     try {
//       const userId = req.user.userId;

//       const result = await pool.query(
//         `SELECT 
//            ba.*,
//            e.title as election_title,
//            e.end_date,
//            e.end_time
//          FROM votteryy_blocked_accounts ba
//          LEFT JOIN votteryyy_elections e ON ba.election_id = e.id
//          WHERE ba.user_id = $1 AND ba.status = 'locked'
//          ORDER BY ba.created_at DESC`,
//         [userId]
//       );

//       res.json({
//         blockedAccounts: result.rows,
//         totalBlocked: result.rows.reduce((sum, acc) => sum + parseFloat(acc.amount), 0)
//       });

//     } catch (error) {
//       console.error('Get blocked accounts error:', error);
//       res.status(500).json({ error: 'Failed to retrieve blocked accounts' });
//     }
//   }

//   // Get wallet analytics - FIXED to count creator revenue properly
// async getWalletAnalytics(req, res) {
//   try {
//     const userId = req.user.userId;

//     console.log('📊 Getting wallet analytics for userId:', userId);

//     // Total deposits
//     const depositsResult = await pool.query(
//       `SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
//        FROM votteryy_transactions
//        WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
//       [userId]
//     );

//     // Total withdrawals
//     const withdrawalsResult = await pool.query(
//       `SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
//        FROM votteryy_transactions
//        WHERE user_id = $1 AND transaction_type = 'withdraw' AND status = 'success'`,
//       [userId]
//     );

//     // Total prizes won
//     const prizesResult = await pool.query(
//       `SELECT COALESCE(SUM(amount), 0) as total_prizes, COUNT(*) as prize_count
//        FROM votteryy_transactions
//        WHERE user_id = $1 AND transaction_type = 'prize_won' AND status = 'success'`,
//       [userId]
//     );

//     // ✅ FIXED: Total election revenue (for CREATORS)
//     // Look for 'election_revenue' transaction type, not 'election_payment'
//     const revenueResult = await pool.query(
//       `SELECT COALESCE(SUM(amount), 0) as total_revenue, COUNT(DISTINCT election_id) as election_count
//        FROM votteryy_transactions
//        WHERE user_id = $1 AND transaction_type = 'election_revenue' AND status = 'success'`,
//       [userId]
//     );

//     const analytics = {
//       totalDeposits: parseFloat(depositsResult.rows[0].total_deposits),
//       depositCount: parseInt(depositsResult.rows[0].deposit_count),
//       totalWithdrawals: parseFloat(withdrawalsResult.rows[0].total_withdrawals),
//       withdrawalCount: parseInt(withdrawalsResult.rows[0].withdrawal_count),
//       totalPrizesWon: parseFloat(prizesResult.rows[0].total_prizes),
//       prizeCount: parseInt(prizesResult.rows[0].prize_count),
//       totalElectionFees: parseFloat(revenueResult.rows[0].total_revenue),
//       electionCount: parseInt(revenueResult.rows[0].election_count)
//     };

//     console.log('✅ Analytics calculated:', analytics);

//     res.json(analytics);

//   } catch (error) {
//     console.error('❌ Get wallet analytics error:', error);
//     res.status(500).json({ error: 'Failed to retrieve wallet analytics' });
//   }
// }

//   // Process election participation payment
//   async payForElection(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { electionId, regionCode } = req.body;

//       // Get election details
//       const electionResult = await pool.query(
//         `SELECT * FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         return res.status(404).json({ error: 'Election not found' });
//       }

//       const election = electionResult.rows[0];

//       if (election.is_free) {
//         return res.status(400).json({ error: 'This election is free' });
//       }

//       // Get participation fee based on pricing type
//       let amount = 0;

//       if (election.pricing_type === 'general_fee') {
//         amount = parseFloat(election.general_participation_fee);
//       } else if (election.pricing_type === 'regional_fee') {
//         const regionalResult = await pool.query(
//           `SELECT participation_fee FROM votteryy_election_regional_pricing
//            WHERE election_id = $1 AND region_code = $2`,
//           [electionId, regionCode]
//         );

//         if (regionalResult.rows.length === 0) {
//           return res.status(400).json({ error: 'Regional pricing not configured for your region' });
//         }

//         amount = parseFloat(regionalResult.rows[0].participation_fee);
//       }

//       if (amount <= 0) {
//         return res.status(400).json({ error: 'Invalid participation fee' });
//       }

//       // Process payment
//       const paymentResult = await paymentService.processElectionPayment(
//         userId,
//         electionId,
//         amount,
//         regionCode
//       );

//       res.json({
//         success: true,
//         payment: paymentResult.payment,
//         clientSecret: paymentResult.clientSecret,
//         gateway: paymentResult.gateway
//       });

//     } catch (error) {
//       console.error('Pay for election error:', error);
//       res.status(500).json({ error: error.message || 'Failed to process election payment' });
//     }
//   }

//   // Confirm election payment (webhook from Stripe)
//   async confirmElectionPayment(req, res) {
//     try {
//       const { paymentIntentId, electionId } = req.body;

//       console.log('🔔 Webhook received:', { paymentIntentId, electionId });

//       // ✅ Verify this is from Stripe (optional but recommended)
//       const sig = req.headers['stripe-signature'];
//       if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
//         try {
//           const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
//           const event = stripe.webhooks.constructEvent(
//             req.body, 
//             sig, 
//             process.env.STRIPE_WEBHOOK_SECRET
//           );
//           console.log('✅ Webhook signature verified:', event.type);
//         } catch (err) {
//           console.error('⚠️ Webhook signature verification failed:', err.message);
//           return res.status(400).json({ error: 'Invalid signature' });
//         }
//       }

//       await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

//       res.json({ 
//         success: true, 
//         message: 'Payment confirmed and funds blocked until election ends' 
//       });

//     } catch (error) {
//       console.error('Confirm election payment error:', error);
//       res.status(500).json({ error: 'Failed to confirm payment' });
//     }
//   }

//   // Check election payment status
//   async checkElectionPaymentStatus(req, res) {
//     try {
//       const userId = req.user.userId;
//       const { electionId } = req.params;

//       // Check if user has paid PARTICIPATION FEE for this election
//       const paymentResult = await pool.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE user_id = $1 AND election_id = $2 AND status = 'succeeded'
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       const paid = paymentResult.rows.length > 0;

//       res.json({
//         paid,
//         payment: paid ? paymentResult.rows[0] : null
//       });

//     } catch (error) {
//       console.error('Check participation fee status error:', error);
//       res.status(500).json({ error: 'Failed to check payment status' });
//     }
//   }

//   // ===== PRIZE DISTRIBUTION =====

//   // Distribute lottery prizes to winners
//   async distributeLotteryPrizes(req, res) {
//     try {
//       const { electionId } = req.params;
      
//       // Get lottery winners
//       const winnersResult = await pool.query(
//         `SELECT lw.*, v.user_id, ud.email 
//          FROM votteryy_lottery_winners lw
//          JOIN votteryy_votings v ON lw.voting_id = v.voting_id
//          JOIN votteryy_user_details ud ON v.user_id = ud.user_id
//          WHERE lw.election_id = $1 AND lw.prize_claimed = false`,
//         [electionId]
//       );

//       // Get election prize config
//       const electionResult = await pool.query(
//         `SELECT prize_amount, auto_distribute_threshold FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       const election = electionResult.rows[0];
//       const autoDistribute = election.prize_amount < election.auto_distribute_threshold;

//       for (const winner of winnersResult.rows) {
//         if (autoDistribute) {
//           // Auto distribute
//           await this.creditPrizeToWallet(winner.user_id, winner.prize_amount, electionId);
//         } else {
//           // Queue for admin review
//           await pool.query(
//             `INSERT INTO votteryy_prize_distribution_queue 
//              (user_id, election_id, amount, status)
//              VALUES ($1, $2, $3, 'pending_review')`,
//             [winner.user_id, electionId, winner.prize_amount]
//           );
//         }
//       }

//       res.json({ success: true, distributedCount: winnersResult.rows.length });
//     } catch (error) {
//       console.error('Distribute prizes error:', error);
//       res.status(500).json({ error: 'Failed to distribute prizes' });
//     }
//   }

//   // Credit prize to winner's wallet
//   async creditPrizeToWallet(userId, amount, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Add to wallet
//       await client.query(
//         `UPDATE votteryy_user_wallets
//          SET balance = balance + $1
//          WHERE user_id = $2`,
//         [amount, userId]
//       );

//       // Record transaction
//       await client.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, election_id, status, description)
//          VALUES ($1, 'prize_won', $2, $3, 'success', 'Lottery prize winnings')`,
//         [userId, amount, electionId]
//       );

//       // Mark prize as claimed
//       await client.query(
//         `UPDATE votteryy_lottery_winners
//          SET prize_claimed = true, claimed_at = CURRENT_TIMESTAMP
//          WHERE user_id = $1 AND election_id = $2`,
//         [userId, electionId]
//       );

//       await client.query('COMMIT');
//       return { success: true };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Get user's prizes
//   async getMyPrizes(req, res) {
//     try {
//       const userId = req.user.userId;
      
//       const result = await pool.query(
//         `SELECT lw.*, e.title as election_title
//          FROM votteryy_lottery_winners lw
//          JOIN votteryyy_elections e ON lw.election_id = e.id
//          WHERE lw.user_id = $1
//          ORDER BY lw.created_at DESC`,
//         [userId]
//       );

//       res.json({ prizes: result.rows });
//     } catch (error) {
//       console.error('Get my prizes error:', error);
//       res.status(500).json({ error: 'Failed to retrieve prizes' });
//     }
//   }

//   // Get pending prize distributions (admin)
//   async getPendingPrizeDistributions(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Get pending prize distributions error:', error);
//       res.status(500).json({ error: 'Failed to retrieve pending prize distributions' });
//     }
//   }

//   // Review prize distribution (admin)
//   async reviewPrizeDistribution(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Review prize distribution error:', error);
//       res.status(500).json({ error: 'Failed to review prize distribution' });
//     }
//   }

//   // ===== SPONSOR OPERATIONS =====

//   // Fund prize pool
//   async fundPrizePool(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Fund prize pool error:', error);
//       res.status(500).json({ error: 'Failed to fund prize pool' });
//     }
//   }

//   // Confirm prize funding
//   async confirmPrizeFunding(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Confirm prize funding error:', error);
//       res.status(500).json({ error: 'Failed to confirm prize funding' });
//     }
//   }

//   // Get sponsored elections
//   async getSponsoredElections(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Get sponsored elections error:', error);
//       res.status(500).json({ error: 'Failed to retrieve sponsored elections' });
//     }
//   }

//   // ===== REFUNDS =====

//   // Refund failed election
//   async refundFailedElection(req, res) {
//     try {
//       res.status(501).json({ error: 'Feature not implemented yet' });
//     } catch (error) {
//       console.error('Refund failed election error:', error);
//       res.status(500).json({ error: 'Failed to refund election' });
//     }
//   }

  
// }

// export default new WalletController();
// // import pool from '../config/database.js';
// // import paymentService from '../services/payment.service.js';
// // import auditService from '../services/audit.service.js';
// // import notificationService from '../services/notification.service.js';
// // import { depositSchema, withdrawalSchema } from '../utils/validators.js';

// // class WalletController {

// //   // Check if user can vote (hasn't voted yet)
// //   async canUserVote(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { electionId } = req.params;

// //       // Check if user already voted
// //       const voteResult = await pool.query(
// //         `SELECT voting_id FROM votteryy_votings
// //          WHERE user_id = $1 AND election_id = $2
// //          LIMIT 1`,
// //         [userId, electionId]
// //       );

// //       const hasVoted = voteResult.rows.length > 0;

// //       // Check if election exists and is active
// //       const electionResult = await pool.query(
// //         `SELECT id, status, start_date, end_date, end_time
// //          FROM votteryyy_elections
// //          WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];
// //       const now = new Date();
// //       const endDateTime = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

// //       const canVote = !hasVoted && 
// //                       election.status === 'published' && 
// //                       now <= endDateTime;

// //       res.json({
// //         canVote,
// //         hasVoted,
// //         reason: hasVoted ? 'already_voted' : 
// //                 election.status !== 'published' ? 'election_not_active' :
// //                 now > endDateTime ? 'election_ended' : null
// //       });

// //     } catch (error) {
// //       console.error('Check vote eligibility error:', error);
// //       res.status(500).json({ error: 'Failed to check vote eligibility' });
// //     }
// //   }

// //   // Get user wallet
// // async getWallet(req, res) {
// //   try {
// //     const userId = req.user.userId;

// //     console.log('💰 Getting wallet for userId:', userId);

// //     const result = await pool.query(
// //       `SELECT * FROM votteryy_wallets WHERE user_id = $1`,
// //       [userId]
// //     );

// //     if (result.rows.length === 0) {
// //       console.log('⚠️ Wallet not found, creating new wallet');
      
// //       // Create wallet if doesn't exist
// //       const createResult = await pool.query(
// //         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
// //          VALUES ($1, 0, 0, 'USD')
// //          RETURNING *`,
// //         [userId]
// //       );

// //       console.log('✅ New wallet created:', createResult.rows[0]);
// //       return res.json(createResult.rows[0]);
// //     }

// //     console.log('✅ Wallet found:', result.rows[0]);
// //     res.json(result.rows[0]);

// //   } catch (error) {
// //     console.error('❌ Get wallet error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve wallet' });
// //   }
// // }

// // async getTransactions(req, res) {
// //   try {
// //     const userId = req.user.userId;
// //     const { 
// //       page = 1, 
// //       limit = 20, 
// //       type, 
// //       status, 
// //       dateFrom, 
// //       dateTo,
// //       filterType
// //     } = req.query;

// //     console.log('📜 Getting transactions for userId:', userId, { page, limit, type, status, filterType });

// //     const offset = (page - 1) * limit;

// //     // Build query
// //     let query = `SELECT * FROM votteryy_transactions WHERE user_id = $1`;
// //     const params = [userId];
// //     let paramIndex = 2;

// //     if (type) {
// //       query += ` AND transaction_type = $${paramIndex}`;
// //       params.push(type);
// //       paramIndex++;
// //     }

// //     if (status) {
// //       query += ` AND status = $${paramIndex}`;
// //       params.push(status);
// //       paramIndex++;
// //     }

// //     // Date filters based on filterType
// //     if (filterType) {
// //       const now = new Date();
// //       let startDate, endDate;

// //       switch (filterType) {
// //         case 'today':
// //           startDate = new Date(now.setHours(0, 0, 0, 0));
// //           endDate = new Date(now.setHours(23, 59, 59, 999));
// //           break;
// //         case 'yesterday':
// //           const yesterday = new Date(now);
// //           yesterday.setDate(yesterday.getDate() - 1);
// //           startDate = new Date(yesterday.setHours(0, 0, 0, 0));
// //           endDate = new Date(yesterday.setHours(23, 59, 59, 999));
// //           break;
// //         case 'last_week':
// //           startDate = new Date(now);
// //           startDate.setDate(startDate.getDate() - 7);
// //           endDate = new Date();
// //           break;
// //         case 'last_30_days':
// //           startDate = new Date(now);
// //           startDate.setDate(startDate.getDate() - 30);
// //           endDate = new Date();
// //           break;
// //         case 'custom':
// //           if (dateFrom) startDate = new Date(dateFrom);
// //           if (dateTo) endDate = new Date(dateTo);
// //           break;
// //       }

// //       if (startDate) {
// //         query += ` AND created_at >= $${paramIndex}`;
// //         params.push(startDate);
// //         paramIndex++;
// //       }

// //       if (endDate) {
// //         query += ` AND created_at <= $${paramIndex}`;
// //         params.push(endDate);
// //         paramIndex++;
// //       }
// //     }

// //     query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
// //     params.push(limit, offset);

// //     const result = await pool.query(query, params);

// //     // Get total count
// //     let countQuery = `SELECT COUNT(*) FROM votteryy_transactions WHERE user_id = $1`;
// //     const countParams = [userId];
// //     let countParamIndex = 2;

// //     if (type) {
// //       countQuery += ` AND transaction_type = $${countParamIndex}`;
// //       countParams.push(type);
// //       countParamIndex++;
// //     }

// //     if (status) {
// //       countQuery += ` AND status = $${countParamIndex}`;
// //       countParams.push(status);
// //       countParamIndex++;
// //     }

// //     const countResult = await pool.query(countQuery, countParams);
// //     const totalCount = parseInt(countResult.rows[0].count);

// //     console.log('✅ Found transactions:', result.rows.length);

// //     res.json({
// //       transactions: result.rows,
// //       pagination: {
// //         page: parseInt(page),
// //         limit: parseInt(limit),
// //         total: totalCount,
// //         totalPages: Math.ceil(totalCount / limit)
// //       }
// //     });

// //   } catch (error) {
// //     console.error('❌ Get transactions error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve transactions' });
// //   }
// // }

// //   // Deposit funds
// //   async deposit(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { amount, paymentMethod, regionCode } = req.body;

// //       const { error } = depositSchema.validate({ amount, paymentMethod });
// //       if (error) {
// //         return res.status(400).json({ error: error.details[0].message });
// //       }

// //       // ✅ Get fee from subscription
// //       const processingFeeConfig = await paymentService.getUserProcessingFee(userId);
      
// //       const stripeFee = (amount * 0.029) + 0.30;
// //       const platformFee = paymentService.calculateProcessingFee(amount, processingFeeConfig);
// //       const netAmount = amount - stripeFee - platformFee;

// //       const paymentResult = await paymentService.createStripePayment(
// //         amount,
// //         'USD',
// //         { userId, type: 'wallet_deposit' }
// //       );

// //       await pool.query(
// //         `INSERT INTO votteryy_wallet_transactions
// //          (user_id, transaction_type, amount, stripe_fee, platform_fee, net_amount, status, description, metadata)
// //          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
// //         [
// //           userId, 'deposit', amount, stripeFee, platformFee, netAmount, 'pending',
// //           'Wallet deposit',
// //           JSON.stringify({ paymentIntentId: paymentResult.paymentIntentId })
// //         ]
// //       );

// //       res.json({
// //         success: true,
// //         clientSecret: paymentResult.clientSecret,
// //         paymentIntentId: paymentResult.paymentIntentId,
// //         breakdown: {
// //           originalAmount: amount.toFixed(2),
// //           stripeFee: stripeFee.toFixed(2),
// //           platformFee: platformFee.toFixed(2),
// //           netAmount: netAmount.toFixed(2)
// //         }
// //       });
// //     } catch (error) {
// //       console.error('Deposit error:', error);
// //       res.status(500).json({ error: 'Failed to process deposit' });
// //     }
// //   }

// //   // Confirm deposit (webhook callback)
// //   async confirmDeposit(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       const { paymentIntentId } = req.body;

// //       // Get transaction
// //       const txResult = await client.query(
// //         `SELECT * FROM votteryy_wallet_transactions
// //          WHERE metadata->>'paymentIntentId' = $1 AND status = 'pending'`,
// //         [paymentIntentId]
// //       );

// //       if (txResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Transaction not found' });
// //       }

// //       const transaction = txResult.rows[0];

// //       // Update transaction status
// //       await client.query(
// //         `UPDATE votteryy_wallet_transactions
// //          SET status = 'success', updated_at = CURRENT_TIMESTAMP
// //          WHERE transaction_id = $1`,
// //         [transaction.transaction_id]
// //       );

// //       // Update wallet balance
// //       await client.query(
// //         `UPDATE votteryy_user_wallets
// //          SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
// //          WHERE user_id = $2`,
// //         [transaction.amount, transaction.user_id]
// //       );

// //       // Check if this is first deposit - assign Sponsor role
// //       const depositCountResult = await client.query(
// //         `SELECT COUNT(*) as count FROM votteryy_wallet_transactions
// //          WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
// //         [transaction.user_id]
// //       );

// //       const depositCount = parseInt(depositCountResult.rows[0].count);

// //       if (depositCount === 1) {
// //         // First deposit - assign Sponsor role
// //         await client.query(
// //           `INSERT INTO user_roles (user_id, role_name, is_active, assigned_date)
// //            VALUES ($1, 'sponsor', true, CURRENT_TIMESTAMP)
// //            ON CONFLICT (user_id, role_name) DO NOTHING`,
// //           [transaction.user_id]
// //         );
// //       }

// //       await client.query('COMMIT');

// //       res.json({ success: true, message: 'Deposit confirmed' });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Confirm deposit error:', error);
// //       res.status(500).json({ error: 'Failed to confirm deposit' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Request withdrawal
// //   async requestWithdrawal(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { amount, paymentMethod, paymentDetails } = req.body;

// //       // Validate
// //       const { error } = withdrawalSchema.validate({ amount, paymentMethod, paymentDetails });
// //       if (error) {
// //         return res.status(400).json({ error: error.details[0].message });
// //       }

// //       // Check minimum withdrawal
// //       if (amount < 10) {
// //         return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
// //       }

// //       // Process withdrawal
// //       const withdrawal = await paymentService.processWithdrawal(
// //         userId,
// //         amount,
// //         paymentMethod,
// //         paymentDetails
// //       );

// //       // Log audit
// //       await auditService.logWithdrawal(userId, amount, withdrawal.status, req);

// //       // Send notification
// //       try {
// //         const userResult = await pool.query(
// //           `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
// //           [userId]
// //         );

// //         if (userResult.rows.length > 0) {
// //           if (withdrawal.status === 'approved' || withdrawal.status === 'completed') {
// //             await notificationService.sendWithdrawalApproved(
// //               userResult.rows[0].email,
// //               amount
// //             );
// //           }
// //         }
// //       } catch (emailError) {
// //         console.error('Email notification error:', emailError);
// //       }

// //       res.json({
// //         success: true,
// //         withdrawal,
// //         message: amount >= 5000 
// //           ? 'Withdrawal request submitted for admin review' 
// //           : 'Withdrawal processed successfully'
// //       });

// //     } catch (error) {
// //       console.error('Request withdrawal error:', error);
// //       res.status(500).json({ error: error.message || 'Failed to process withdrawal request' });
// //     }
// //   }

// //   // Get withdrawal requests (user's own)
// //   async getWithdrawalRequests(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { status } = req.query;

// //       let query = `SELECT * FROM votteryy_withdrawal_requests WHERE user_id = $1`;
// //       const params = [userId];

// //       if (status) {
// //         query += ` AND status = $2`;
// //         params.push(status);
// //       }

// //       query += ` ORDER BY created_at DESC`;

// //       const result = await pool.query(query, params);

// //       res.json({
// //         withdrawalRequests: result.rows,
// //         totalCount: result.rows.length
// //       });

// //     } catch (error) {
// //       console.error('Get withdrawal requests error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve withdrawal requests' });
// //     }
// //   }

// //   // Admin: Get all pending withdrawals
// //   async getPendingWithdrawals(req, res) {
// //     try {
// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required' });
// //       }

// //       const result = await pool.query(
// //         `SELECT 
// //            wr.*,
// //            ud.full_name,
// //            ud.email,
// //            uw.balance as user_balance
// //          FROM votteryy_withdrawal_requests wr
// //          LEFT JOIN votteryy_user_details ud ON wr.user_id = ud.user_id
// //          LEFT JOIN votteryy_user_wallets uw ON wr.user_id = uw.user_id
// //          WHERE wr.status = 'pending'
// //          ORDER BY wr.created_at ASC`
// //       );

// //       res.json({
// //         pendingWithdrawals: result.rows,
// //         totalCount: result.rows.length
// //       });

// //     } catch (error) {
// //       console.error('Get pending withdrawals error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve pending withdrawals' });
// //     }
// //   }

// //   // Admin: Approve/Reject withdrawal
// //   async reviewWithdrawal(req, res) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Verify admin role
// //       if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
// //         return res.status(403).json({ error: 'Admin access required' });
// //       }

// //       const { requestId } = req.params;
// //       const { action, adminNotes } = req.body; // action: approve or reject
// //       const adminId = req.user.userId;

// //       if (!['approve', 'reject'].includes(action)) {
// //         return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
// //       }

// //       // Get withdrawal request
// //       const requestResult = await client.query(
// //         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
// //         [requestId]
// //       );

// //       if (requestResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Withdrawal request not found' });
// //       }

// //       const request = requestResult.rows[0];

// //       if (request.status !== 'pending') {
// //         return res.status(400).json({ error: 'Withdrawal request already processed' });
// //       }

// //       if (action === 'approve') {
// //         // Approve and execute
// //         await client.query(
// //           `UPDATE votteryy_withdrawal_requests
// //            SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
// //            WHERE request_id = $3`,
// //           [adminId, adminNotes, requestId]
// //         );

// //         // Execute withdrawal
// //         await paymentService.executeWithdrawal(requestId, adminId);

// //         // Send notification
// //         try {
// //           const userResult = await client.query(
// //             `SELECT email FROM votteryy_user_details WHERE user_id = $1`,
// //             [request.user_id]
// //           );

// //           if (userResult.rows.length > 0) {
// //             await notificationService.sendWithdrawalApproved(
// //               userResult.rows[0].email,
// //               request.amount
// //             );
// //           }
// //         } catch (emailError) {
// //           console.error('Email notification error:', emailError);
// //         }

// //       } else {
// //         // Reject
// //         await client.query(
// //           `UPDATE votteryy_withdrawal_requests
// //            SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
// //            WHERE request_id = $3`,
// //           [adminId, adminNotes, requestId]
// //         );

// //         // Note: Balance was never deducted, so no need to refund
// //       }

// //       await client.query('COMMIT');

// //       res.json({
// //         success: true,
// //         message: action === 'approve' ? 'Withdrawal approved and processed' : 'Withdrawal rejected'
// //       });

// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       console.error('Review withdrawal error:', error);
// //       res.status(500).json({ error: 'Failed to review withdrawal' });
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Get blocked accounts (funds held until election ends)
// //   async getBlockedAccounts(req, res) {
// //     try {
// //       const userId = req.user.userId;

// //       const result = await pool.query(
// //         `SELECT 
// //            ba.*,
// //            e.title as election_title,
// //            e.end_date,
// //            e.end_time
// //          FROM votteryy_blocked_accounts ba
// //          LEFT JOIN votteryyy_elections e ON ba.election_id = e.id
// //          WHERE ba.user_id = $1 AND ba.status = 'locked'
// //          ORDER BY ba.created_at DESC`,
// //         [userId]
// //       );

// //       res.json({
// //         blockedAccounts: result.rows,
// //         totalBlocked: result.rows.reduce((sum, acc) => sum + parseFloat(acc.amount), 0)
// //       });

// //     } catch (error) {
// //       console.error('Get blocked accounts error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve blocked accounts' });
// //     }
// //   }

// //   // Get wallet analytics
// // async getWalletAnalytics(req, res) {
// //   try {
// //     const userId = req.user.userId;

// //     console.log('📊 Getting wallet analytics for userId:', userId);

// //     // Total deposits
// //     const depositsResult = await pool.query(
// //       `SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
// //        FROM votteryy_transactions
// //        WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
// //       [userId]
// //     );

// //     // Total withdrawals
// //     const withdrawalsResult = await pool.query(
// //       `SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
// //        FROM votteryy_transactions
// //        WHERE user_id = $1 AND transaction_type = 'withdraw' AND status = 'success'`,
// //       [userId]
// //     );

// //     // Total prizes won
// //     const prizesResult = await pool.query(
// //       `SELECT COALESCE(SUM(amount), 0) as total_prizes, COUNT(*) as prize_count
// //        FROM votteryy_transactions
// //        WHERE user_id = $1 AND transaction_type = 'prize_won' AND status = 'success'`,
// //       [userId]
// //     );

// //     // Total election fees paid
// //     const feesResult = await pool.query(
// //       `SELECT COALESCE(SUM(amount), 0) as total_fees, COUNT(*) as election_count
// //        FROM votteryy_transactions
// //        WHERE user_id = $1 AND transaction_type = 'election_payment' AND status = 'success'`,
// //       [userId]
// //     );

// //     const analytics = {
// //       totalDeposits: parseFloat(depositsResult.rows[0].total_deposits),
// //       depositCount: parseInt(depositsResult.rows[0].deposit_count),
// //       totalWithdrawals: parseFloat(withdrawalsResult.rows[0].total_withdrawals),
// //       withdrawalCount: parseInt(withdrawalsResult.rows[0].withdrawal_count),
// //       totalPrizesWon: parseFloat(prizesResult.rows[0].total_prizes),
// //       prizeCount: parseInt(prizesResult.rows[0].prize_count),
// //       totalElectionFees: parseFloat(feesResult.rows[0].total_fees),
// //       electionCount: parseInt(feesResult.rows[0].election_count)
// //     };

// //     console.log('✅ Analytics calculated:', analytics);

// //     res.json(analytics);

// //   } catch (error) {
// //     console.error('❌ Get wallet analytics error:', error);
// //     res.status(500).json({ error: 'Failed to retrieve wallet analytics' });
// //   }
// // }

// //   // Process election participation payment
// //   async payForElection(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { electionId, regionCode } = req.body;

// //       // Get election details
// //       const electionResult = await pool.query(
// //         `SELECT * FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       if (electionResult.rows.length === 0) {
// //         return res.status(404).json({ error: 'Election not found' });
// //       }

// //       const election = electionResult.rows[0];

// //       if (election.is_free) {
// //         return res.status(400).json({ error: 'This election is free' });
// //       }

// //       // Get participation fee based on pricing type
// //       let amount = 0;

// //       if (election.pricing_type === 'general_fee') {
// //         amount = parseFloat(election.general_participation_fee);
// //       } else if (election.pricing_type === 'regional_fee') {
// //         const regionalResult = await pool.query(
// //           `SELECT participation_fee FROM votteryy_election_regional_pricing
// //            WHERE election_id = $1 AND region_code = $2`,
// //           [electionId, regionCode]
// //         );

// //         if (regionalResult.rows.length === 0) {
// //           return res.status(400).json({ error: 'Regional pricing not configured for your region' });
// //         }

// //         amount = parseFloat(regionalResult.rows[0].participation_fee);
// //       }

// //       if (amount <= 0) {
// //         return res.status(400).json({ error: 'Invalid participation fee' });
// //       }

// //       // Process payment
// //       const paymentResult = await paymentService.processElectionPayment(
// //         userId,
// //         electionId,
// //         amount,
// //         regionCode
// //       );

// //       res.json({
// //         success: true,
// //         payment: paymentResult.payment,
// //         clientSecret: paymentResult.clientSecret,
// //         gateway: paymentResult.gateway
// //       });

// //     } catch (error) {
// //       console.error('Pay for election error:', error);
// //       res.status(500).json({ error: error.message || 'Failed to process election payment' });
// //     }
// //   }

// //   // Confirm election payment (webhook from Stripe)
// //   async confirmElectionPayment(req, res) {
// //     try {
// //       const { paymentIntentId, electionId } = req.body;

// //       console.log('🔔 Webhook received:', { paymentIntentId, electionId });

// //       // ✅ Verify this is from Stripe (optional but recommended)
// //       const sig = req.headers['stripe-signature'];
// //       if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
// //         try {
// //           const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// //           const event = stripe.webhooks.constructEvent(
// //             req.body, 
// //             sig, 
// //             process.env.STRIPE_WEBHOOK_SECRET
// //           );
// //           console.log('✅ Webhook signature verified:', event.type);
// //         } catch (err) {
// //           console.error('⚠️ Webhook signature verification failed:', err.message);
// //           return res.status(400).json({ error: 'Invalid signature' });
// //         }
// //       }

// //       await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

// //       res.json({ 
// //         success: true, 
// //         message: 'Payment confirmed and funds blocked until election ends' 
// //       });

// //     } catch (error) {
// //       console.error('Confirm election payment error:', error);
// //       res.status(500).json({ error: 'Failed to confirm payment' });
// //     }
// //   }

// //   // Check election payment status
// //   async checkElectionPaymentStatus(req, res) {
// //     try {
// //       const userId = req.user.userId;
// //       const { electionId } = req.params;

// //       // Check if user has paid PARTICIPATION FEE for this election
// //       const paymentResult = await pool.query(
// //         `SELECT * FROM votteryy_election_payments
// //          WHERE user_id = $1 AND election_id = $2 AND status = 'succeeded'
// //          LIMIT 1`,
// //         [userId, electionId]
// //       );

// //       const paid = paymentResult.rows.length > 0;

// //       res.json({
// //         paid,
// //         payment: paid ? paymentResult.rows[0] : null
// //       });

// //     } catch (error) {
// //       console.error('Check participation fee status error:', error);
// //       res.status(500).json({ error: 'Failed to check payment status' });
// //     }
// //   }

// //   // ===== PRIZE DISTRIBUTION =====

// //   // Distribute lottery prizes to winners
// //   async distributeLotteryPrizes(req, res) {
// //     try {
// //       const { electionId } = req.params;
      
// //       // Get lottery winners
// //       const winnersResult = await pool.query(
// //         `SELECT lw.*, v.user_id, ud.email 
// //          FROM votteryy_lottery_winners lw
// //          JOIN votteryy_votings v ON lw.voting_id = v.voting_id
// //          JOIN votteryy_user_details ud ON v.user_id = ud.user_id
// //          WHERE lw.election_id = $1 AND lw.prize_claimed = false`,
// //         [electionId]
// //       );

// //       // Get election prize config
// //       const electionResult = await pool.query(
// //         `SELECT prize_amount, auto_distribute_threshold FROM votteryyy_elections WHERE id = $1`,
// //         [electionId]
// //       );

// //       const election = electionResult.rows[0];
// //       const autoDistribute = election.prize_amount < election.auto_distribute_threshold;

// //       for (const winner of winnersResult.rows) {
// //         if (autoDistribute) {
// //           // Auto distribute
// //           await this.creditPrizeToWallet(winner.user_id, winner.prize_amount, electionId);
// //         } else {
// //           // Queue for admin review
// //           await pool.query(
// //             `INSERT INTO votteryy_prize_distribution_queue 
// //              (user_id, election_id, amount, status)
// //              VALUES ($1, $2, $3, 'pending_review')`,
// //             [winner.user_id, electionId, winner.prize_amount]
// //           );
// //         }
// //       }

// //       res.json({ success: true, distributedCount: winnersResult.rows.length });
// //     } catch (error) {
// //       console.error('Distribute prizes error:', error);
// //       res.status(500).json({ error: 'Failed to distribute prizes' });
// //     }
// //   }

// //   // Credit prize to winner's wallet
// //   async creditPrizeToWallet(userId, amount, electionId) {
// //     const client = await pool.connect();
// //     try {
// //       await client.query('BEGIN');

// //       // Add to wallet
// //       await client.query(
// //         `UPDATE votteryy_user_wallets
// //          SET balance = balance + $1
// //          WHERE user_id = $2`,
// //         [amount, userId]
// //       );

// //       // Record transaction
// //       await client.query(
// //         `INSERT INTO votteryy_wallet_transactions
// //          (user_id, transaction_type, amount, election_id, status, description)
// //          VALUES ($1, 'prize_won', $2, $3, 'success', 'Lottery prize winnings')`,
// //         [userId, amount, electionId]
// //       );

// //       // Mark prize as claimed
// //       await client.query(
// //         `UPDATE votteryy_lottery_winners
// //          SET prize_claimed = true, claimed_at = CURRENT_TIMESTAMP
// //          WHERE user_id = $1 AND election_id = $2`,
// //         [userId, electionId]
// //       );

// //       await client.query('COMMIT');
// //       return { success: true };
// //     } catch (error) {
// //       await client.query('ROLLBACK');
// //       throw error;
// //     } finally {
// //       client.release();
// //     }
// //   }

// //   // Get user's prizes
// //   async getMyPrizes(req, res) {
// //     try {
// //       const userId = req.user.userId;
      
// //       const result = await pool.query(
// //         `SELECT lw.*, e.title as election_title
// //          FROM votteryy_lottery_winners lw
// //          JOIN votteryyy_elections e ON lw.election_id = e.id
// //          WHERE lw.user_id = $1
// //          ORDER BY lw.created_at DESC`,
// //         [userId]
// //       );

// //       res.json({ prizes: result.rows });
// //     } catch (error) {
// //       console.error('Get my prizes error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve prizes' });
// //     }
// //   }

// //   // Get pending prize distributions (admin)
// //   async getPendingPrizeDistributions(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Get pending prize distributions error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve pending prize distributions' });
// //     }
// //   }

// //   // Review prize distribution (admin)
// //   async reviewPrizeDistribution(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Review prize distribution error:', error);
// //       res.status(500).json({ error: 'Failed to review prize distribution' });
// //     }
// //   }

// //   // ===== SPONSOR OPERATIONS =====

// //   // Fund prize pool
// //   async fundPrizePool(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Fund prize pool error:', error);
// //       res.status(500).json({ error: 'Failed to fund prize pool' });
// //     }
// //   }

// //   // Confirm prize funding
// //   async confirmPrizeFunding(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Confirm prize funding error:', error);
// //       res.status(500).json({ error: 'Failed to confirm prize funding' });
// //     }
// //   }

// //   // Get sponsored elections
// //   async getSponsoredElections(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Get sponsored elections error:', error);
// //       res.status(500).json({ error: 'Failed to retrieve sponsored elections' });
// //     }
// //   }

// //   // ===== REFUNDS =====

// //   // Refund failed election
// //   async refundFailedElection(req, res) {
// //     try {
// //       res.status(501).json({ error: 'Feature not implemented yet' });
// //     } catch (error) {
// //       console.error('Refund failed election error:', error);
// //       res.status(500).json({ error: 'Failed to refund election' });
// //     }
// //   }
// // }

// // export default new WalletController();