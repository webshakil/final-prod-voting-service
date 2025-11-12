import pool from '../config/database.js';
import paymentService from '../services/payment.service.js';
import auditService from '../services/audit.service.js';
import notificationService from '../services/notification.service.js';
import { depositSchema, withdrawalSchema } from '../utils/validators.js';

class WalletController {

  // Check if user can vote (hasn't voted yet)
async canUserVote(req, res) {
  try {
    const userId = req.user.userId;
    const { electionId } = req.params;

    // Check if user already voted
    const voteResult = await pool.query(
      `SELECT voting_id FROM votteryy_votings
       WHERE user_id = $1 AND election_id = $2
       LIMIT 1`,
      [userId, electionId]
    );

    const hasVoted = voteResult.rows.length > 0;

    // Check if election exists and is active
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

  // Get user wallet
  async getWallet(req, res) {
    try {
      const userId = req.user.userId;

      const result = await pool.query(
        `SELECT * FROM votteryy_user_wallets WHERE user_id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        // Create wallet if doesn't exist
        const createResult = await pool.query(
          `INSERT INTO votteryy_user_wallets (user_id, balance, blocked_balance, currency)
           VALUES ($1, 0, 0, 'USD')
           RETURNING *`,
          [userId]
        );

        return res.json(createResult.rows[0]);
      }

      res.json(result.rows[0]);

    } catch (error) {
      console.error('Get wallet error:', error);
      res.status(500).json({ error: 'Failed to retrieve wallet' });
    }
  }

  // Get wallet transactions
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
        filterType // today, yesterday, last_week, last_30_days, custom
      } = req.query;

      const offset = (page - 1) * limit;

      // Build query
      let query = `SELECT * FROM votteryy_wallet_transactions WHERE user_id = $1`;
      const params = [userId];
      let paramIndex = 2;

      // Type filter
      if (type) {
        query += ` AND transaction_type = $${paramIndex}`;
        params.push(type);
        paramIndex++;
      }

      // Status filter
      if (status) {
        query += ` AND status = $${paramIndex}`;
        params.push(status);
        paramIndex++;
      }

      // Date filters based on filterType
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

      // Add ordering and pagination
      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      // Get total count
      let countQuery = `SELECT COUNT(*) FROM votteryy_wallet_transactions WHERE user_id = $1`;
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

      res.json({
        transactions: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      });

    } catch (error) {
      console.error('Get transactions error:', error);
      res.status(500).json({ error: 'Failed to retrieve transactions' });
    }
  }

  // Deposit funds
  async deposit(req, res) {
    try {
      const userId = req.user.userId;
      const { amount, paymentMethod, regionCode } = req.body;

      // Validate
      const { error } = depositSchema.validate({ amount, paymentMethod });
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      // Create payment intent
      const paymentResult = await paymentService.createStripePayment(
        amount,
        'USD',
        { userId, type: 'wallet_deposit' }
      );

      // Record transaction
      await pool.query(
        `INSERT INTO votteryy_wallet_transactions
         (user_id, transaction_type, amount, status, description, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          'deposit',
          amount,
          'pending',
          'Wallet deposit',
          JSON.stringify({ paymentIntentId: paymentResult.paymentIntentId })
        ]
      );

      res.json({
        success: true,
        clientSecret: paymentResult.clientSecret,
        paymentIntentId: paymentResult.paymentIntentId
      });

    } catch (error) {
      console.error('Deposit error:', error);
      res.status(500).json({ error: 'Failed to process deposit' });
    }
  }

  // Confirm deposit (webhook callback)
  async confirmDeposit(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { paymentIntentId } = req.body;

      // Get transaction
      const txResult = await client.query(
        `SELECT * FROM votteryy_wallet_transactions
         WHERE metadata->>'paymentIntentId' = $1 AND status = 'pending'`,
        [paymentIntentId]
      );

      if (txResult.rows.length === 0) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const transaction = txResult.rows[0];

      // Update transaction status
      await client.query(
        `UPDATE votteryy_wallet_transactions
         SET status = 'success', updated_at = CURRENT_TIMESTAMP
         WHERE transaction_id = $1`,
        [transaction.transaction_id]
      );

      // Update wallet balance
      await client.query(
        `UPDATE votteryy_user_wallets
         SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [transaction.amount, transaction.user_id]
      );

      // Check if this is first deposit - assign Sponsor role
      const depositCountResult = await client.query(
        `SELECT COUNT(*) as count FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
        [transaction.user_id]
      );

      const depositCount = parseInt(depositCountResult.rows[0].count);

      if (depositCount === 1) {
        // First deposit - assign Sponsor role
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

  // Request withdrawal
  async requestWithdrawal(req, res) {
    try {
      const userId = req.user.userId;
      const { amount, paymentMethod, paymentDetails } = req.body;

      // Validate
      const { error } = withdrawalSchema.validate({ amount, paymentMethod, paymentDetails });
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      // Check minimum withdrawal
      if (amount < 10) {
        return res.status(400).json({ error: 'Minimum withdrawal amount is $10' });
      }

      // Process withdrawal
      const withdrawal = await paymentService.processWithdrawal(
        userId,
        amount,
        paymentMethod,
        paymentDetails
      );

      // Log audit
      await auditService.logWithdrawal(userId, amount, withdrawal.status, req);

      // Send notification
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

  // Get withdrawal requests (user's own)
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

  // Admin: Get all pending withdrawals
  async getPendingWithdrawals(req, res) {
    try {
      // Verify admin role
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

  // Admin: Approve/Reject withdrawal
  async reviewWithdrawal(req, res) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify admin role
      if (!req.user.roles.includes('admin') && !req.user.roles.includes('manager')) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { requestId } = req.params;
      const { action, adminNotes } = req.body; // action: approve or reject
      const adminId = req.user.userId;

      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use "approve" or "reject"' });
      }

      // Get withdrawal request
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
        // Approve and execute
        await client.query(
          `UPDATE votteryy_withdrawal_requests
           SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
           WHERE request_id = $3`,
          [adminId, adminNotes, requestId]
        );

        // Execute withdrawal
        await paymentService.executeWithdrawal(requestId, adminId);

        // Send notification
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
        // Reject
        await client.query(
          `UPDATE votteryy_withdrawal_requests
           SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, admin_notes = $2
           WHERE request_id = $3`,
          [adminId, adminNotes, requestId]
        );

        // Note: Balance was never deducted, so no need to refund
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

  // Get blocked accounts (funds held until election ends)
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

  // Get wallet analytics
  async getWalletAnalytics(req, res) {
    try {
      const userId = req.user.userId;

      // Total deposits
      const depositsResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
         FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'deposit' AND status = 'success'`,
        [userId]
      );

      // Total withdrawals
      const withdrawalsResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
         FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'withdraw' AND status = 'success'`,
        [userId]
      );

      // Total prizes won
      const prizesResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_prizes, COUNT(*) as prize_count
         FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'prize_won' AND status = 'success'`,
        [userId]
      );

      // Total election fees paid
      const feesResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) as total_fees, COUNT(*) as election_count
         FROM votteryy_wallet_transactions
         WHERE user_id = $1 AND transaction_type = 'election_payment' AND status = 'success'`,
        [userId]
      );

      // Current wallet balance
      const walletResult = await pool.query(
        `SELECT balance, blocked_balance FROM votteryy_user_wallets WHERE user_id = $1`,
        [userId]
      );

      const wallet = walletResult.rows[0] || { balance: 0, blocked_balance: 0 };

      res.json({
        currentBalance: parseFloat(wallet.balance),
        blockedBalance: parseFloat(wallet.blocked_balance),
        totalDeposits: parseFloat(depositsResult.rows[0].total_deposits),
        depositCount: parseInt(depositsResult.rows[0].deposit_count),
        totalWithdrawals: parseFloat(withdrawalsResult.rows[0].total_withdrawals),
        withdrawalCount: parseInt(withdrawalsResult.rows[0].withdrawal_count),
        totalPrizesWon: parseFloat(prizesResult.rows[0].total_prizes),
        prizeCount: parseInt(prizesResult.rows[0].prize_count),
        totalElectionFees: parseFloat(feesResult.rows[0].total_fees),
        electionCount: parseInt(feesResult.rows[0].election_count)
      });

    } catch (error) {
      console.error('Get wallet analytics error:', error);
      res.status(500).json({ error: 'Failed to retrieve wallet analytics' });
    }
  }

  // Process election participation payment
  async payForElection(req, res) {
    try {
      const userId = req.user.userId;
      const { electionId, regionCode } = req.body;

      // Get election details
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

      // Get participation fee based on pricing type
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

      // Process payment
      const paymentResult = await paymentService.processElectionPayment(
        userId,
        electionId,
        amount,
        regionCode
      );

      res.json({
        success: true,
        payment: paymentResult.payment,
        clientSecret: paymentResult.clientSecret,
        gateway: paymentResult.gateway
      });

    } catch (error) {
      console.error('Pay for election error:', error);
      res.status(500).json({ error: error.message || 'Failed to process election payment' });
    }
  }

  // Confirm election payment (webhook)
// Confirm election payment (webhook from Stripe)
async confirmElectionPayment(req, res) {
  try {
    const { paymentIntentId, electionId } = req.body;

    console.log('🔔 Webhook received:', { paymentIntentId, electionId });

    // ✅ Verify this is from Stripe (optional but recommended)
    const sig = req.headers['stripe-signature'];
    if (sig && process.env.STRIPE_WEBHOOK_SECRET) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const event = stripe.webhooks.constructEvent(
          req.body, 
          sig, 
          process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('✅ Webhook signature verified:', event.type);
      } catch (err) {
        console.error('⚠️ Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    await paymentService.confirmPaymentAndBlock(paymentIntentId, electionId);

    res.json({ 
      success: true, 
      message: 'Payment confirmed and funds blocked until election ends' 
    });

  } catch (error) {
    console.error('Confirm election payment error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
}

  // Check election payment status
async checkElectionPaymentStatus(req, res) {
  try {
    const userId = req.user.userId;
    const { electionId } = req.params;

    // Check if user has paid PARTICIPATION FEE for this election
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
}

export default new WalletController();