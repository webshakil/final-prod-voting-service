import stripe from '../config/stripe.js';
import paddleClient, { paddleConfig } from '../config/paddle.js';
import pool from '../config/database.js';

class PaymentService {

  // Get payment gateway for region
  async getGatewayForRegion(regionCode) {
    // Map region codes to zone numbers
    const regionMap = {
      'region_1_us_canada': 1,
      'region_2_western_europe': 2,
      'region_3_eastern_europe': 3,
      'region_4_africa': 4,
      'region_5_latin_america': 5,
      'region_6_middle_east_asia': 6,
      'region_7_australasia': 7,
      'region_8_china': 8
    };

    const regionZone = regionMap[regionCode] || 1;

    const result = await pool.query(
      `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
      [regionZone]
    );

    if (result.rows.length === 0) {
      return { gateway: 'stripe', splitPercentage: 100 };
    }

    const config = result.rows[0];

    // Determine which gateway to use
    if (config.gateway_name === 'both') {
      // 50/50 split - randomly choose
      return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
    }

    return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
  }

  // Create Stripe payment intent
  async createStripePayment(amount, currency, metadata) {
    try {
      console.log('🔵 Creating Stripe PaymentIntent:', {
        amount: Math.round(amount * 100),
        currency: currency.toLowerCase(),
        metadata
      });

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        metadata,
        automatic_payment_methods: { enabled: true }
      });

      console.log('✅ Stripe PaymentIntent created:', {
        id: paymentIntent.id,
        client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
        status: paymentIntent.status
      });

      return {
        success: true,
        paymentIntentId: paymentIntent.id,
        clientSecret: paymentIntent.client_secret,
        gateway: 'stripe'
      };
    } catch (error) {
      console.error('❌ Stripe error:', error.message);
      throw new Error(`Stripe payment failed: ${error.message}`);
    }
  }

  // Create Paddle payment
  async createPaddlePayment(amount, currency, metadata) {
    try {
      const response = await paddleClient.post('/product/generate_pay_link', {
        vendor_id: paddleConfig.vendorId,
        vendor_auth_code: paddleConfig.apiKey,
        prices: [`${currency}:${amount}`],
        customer_email: metadata.email,
        passthrough: JSON.stringify(metadata)
      });

      return {
        success: true,
        paymentUrl: response.data.response.url,
        gateway: 'paddle'
      };
    } catch (error) {
      throw new Error(`Paddle payment failed: ${error.message}`);
    }
  }

  // Process election participation payment
// payment.service.js - processElectionPayment function

async processElectionPayment(userId, electionId, amount, regionCode) {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // ✅ STEP 1: Check if payment already exists
    const existingPaymentResult = await client.query(
      `SELECT * FROM votteryy_election_payments 
       WHERE user_id = $1 AND election_id = $2 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [userId, electionId]
    );

    // ✅ If payment exists and is succeeded, return early
    if (existingPaymentResult.rows.length > 0) {
      const existingPayment = existingPaymentResult.rows[0];
      
      console.log('📋 Existing payment found:', existingPayment);

      if (existingPayment.status === 'succeeded') {
        console.log('✅ Payment already completed');
        await client.query('COMMIT');
        return {
          alreadyPaid: true,
          payment: existingPayment,
          message: 'You have already paid for this election'
        };
      }

      // ✅ If payment is pending or failed, reuse it
      if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
        console.log('♻️ Reusing existing payment record');
        
        // Update the payment record
        await client.query(
          `UPDATE votteryy_election_payments 
           SET status = 'pending', 
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [existingPayment.id]
        );

        // Create new Stripe payment intent
        const paymentIntent = await this.createStripePayment(amount, 'USD', {
          userId,
          electionId,
          type: 'election_payment'
        });

        console.log('💳 New PaymentIntent created:', {
          id: paymentIntent.paymentIntentId,
          client_secret: 'exists',
          status: paymentIntent.status
        });

        // Update with new payment intent ID
        await client.query(
          `UPDATE votteryy_election_payments 
           SET payment_intent_id = $1 
           WHERE id = $2`,
          [paymentIntent.paymentIntentId, existingPayment.id]
        );

        await client.query('COMMIT');

        return {
          payment: existingPayment,
          clientSecret: paymentIntent.clientSecret,
          paymentIntentId: paymentIntent.paymentIntentId,
          gateway: 'stripe'
        };
      }
    }

    // ✅ STEP 2: No existing payment found, create new one
    console.log('🆕 Creating new payment record');

    const paymentIntent = await this.createStripePayment(amount, 'USD', {
      userId,
      electionId,
      type: 'election_payment'
    });

    console.log('💳 PaymentIntent created:', {
      id: paymentIntent.paymentIntentId,
      client_secret: 'exists',
      status: paymentIntent.status
    });

    // Insert new payment record
    const paymentResult = await client.query(
      `INSERT INTO votteryy_election_payments 
       (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, electionId, amount, 'USD', 'pending', paymentIntent.paymentIntentId, 'stripe', regionCode]
    );

    await client.query('COMMIT');

    return {
      payment: paymentResult.rows[0],
      clientSecret: paymentIntent.clientSecret,
      paymentIntentId: paymentIntent.paymentIntentId,
      gateway: 'stripe'
    };

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Process election payment error:', error);
    throw error;
  } finally {
    client.release();
  }
}

  // Confirm payment and create blocked account
  async confirmPaymentAndBlock(paymentIntentId, electionId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ✅ Check if payment already confirmed
      const existingPayment = await client.query(
        `SELECT * FROM votteryy_election_payments
         WHERE payment_intent_id = $1`,
        [paymentIntentId]
      );

      if (existingPayment.rows.length === 0) {
        throw new Error('Payment not found');
      }

      const payment = existingPayment.rows[0];

      // ✅ If already succeeded, don't process again
      if (payment.status === 'succeeded') {
        console.log('⚠️ Payment already confirmed:', paymentIntentId);
        await client.query('ROLLBACK');
        return { 
          success: true, 
          payment: payment,
          alreadyProcessed: true 
        };
      }

      // Update payment status
      const paymentResult = await client.query(
        `UPDATE votteryy_election_payments
         SET status = 'succeeded', updated_at = CURRENT_TIMESTAMP
         WHERE payment_intent_id = $1
         RETURNING *`,
        [paymentIntentId]
      );

      const updatedPayment = paymentResult.rows[0];

      // Get election end date
      const electionResult = await client.query(
        `SELECT end_date, end_time FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      const election = electionResult.rows[0];
      const lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

      // ✅ Check if blocked account already exists
      const existingBlocked = await client.query(
        `SELECT * FROM votteryy_blocked_accounts
         WHERE user_id = $1 AND election_id = $2`,
        [updatedPayment.user_id, electionId]
      );

      if (existingBlocked.rows.length === 0) {
        // Create blocked account
        await client.query(
          `INSERT INTO votteryy_blocked_accounts
           (user_id, election_id, amount, platform_fee, locked_until)
           VALUES ($1, $2, $3, $4, $5)`,
          [updatedPayment.user_id, electionId, updatedPayment.amount - updatedPayment.platform_fee, updatedPayment.platform_fee, lockedUntil]
        );

        // Update wallet
        await client.query(
          `INSERT INTO votteryy_user_wallets (user_id, blocked_balance)
           VALUES ($1, $2)
           ON CONFLICT (user_id) 
           DO UPDATE SET blocked_balance = votteryy_user_wallets.blocked_balance + $2`,
          [updatedPayment.user_id, updatedPayment.amount - updatedPayment.platform_fee]
        );
      }

      await client.query('COMMIT');

      return { success: true, payment: updatedPayment };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Process withdrawal
  async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check wallet balance
      const walletResult = await client.query(
        `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
        [userId]
      );

      if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
        throw new Error('Insufficient balance');
      }

      // Create withdrawal request
      const withdrawalResult = await client.query(
        `INSERT INTO votteryy_withdrawal_requests
         (user_id, amount, payment_method, payment_details, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
      );

      const withdrawal = withdrawalResult.rows[0];

      // If auto-approved (< threshold), process immediately
      if (amount < 5000) {
        await this.executeWithdrawal(withdrawal.request_id, userId);
      }

      await client.query('COMMIT');

      return withdrawal;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }


  // payment.service.js - ADD THESE METHODS

// ✅ Get processing fee from user's active subscription
async getUserProcessingFee(userId) {
  try {
    const result = await pool.query(
      `SELECT 
         sp.processing_fee_enabled,
         sp.processing_fee_mandatory,
         sp.processing_fee_type,
         sp.processing_fee_fixed_amount,
         sp.processing_fee_percentage
       FROM votteryy_user_subscriptions us
       JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
       WHERE us.user_id = $1 
         AND us.status = 'active'
         AND us.end_date > NOW()
       ORDER BY us.created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // No subscription - FREE user defaults
      return {
        enabled: true,
        mandatory: true,
        type: 'percentage',
        fixedAmount: 0,
        percentage: 5.0 // Free users pay 5%
      };
    }

    const plan = result.rows[0];
    return {
      enabled: plan.processing_fee_enabled,
      mandatory: plan.processing_fee_mandatory,
      type: plan.processing_fee_type,
      fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
      percentage: parseFloat(plan.processing_fee_percentage || 0)
    };
  } catch (error) {
    console.error('Get user processing fee error:', error);
    throw error;
  }
}

// ✅ Calculate processing fee
calculateProcessingFee(amount, feeConfig) {
  if (!feeConfig.enabled) return 0;
  
  if (feeConfig.type === 'fixed') {
    return feeConfig.fixedAmount;
  } else {
    return (amount * feeConfig.percentage) / 100;
  }
}

  // Execute withdrawal (called by admin or automatically)
  async executeWithdrawal(requestId, adminId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get withdrawal request
      const requestResult = await client.query(
        `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
        [requestId]
      );

      if (requestResult.rows.length === 0) {
        throw new Error('Withdrawal request not found');
      }

      const request = requestResult.rows[0];

      if (request.status !== 'approved') {
        throw new Error('Withdrawal not approved');
      }

      // Deduct from wallet
      await client.query(
        `UPDATE votteryy_user_wallets
         SET balance = balance - $1
         WHERE user_id = $2`,
        [request.amount, request.user_id]
      );

      // Record transaction
      await client.query(
        `INSERT INTO votteryy_wallet_transactions
         (user_id, transaction_type, amount, status, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
      );

      // Update withdrawal request
      await client.query(
        `UPDATE votteryy_withdrawal_requests
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
         WHERE request_id = $2`,
        [adminId, requestId]
      );

      await client.query('COMMIT');

      // TODO: Actually send money via Stripe/Paddle
      // This would call the payment gateway API to transfer funds

      return { success: true, message: 'Withdrawal processed successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Release blocked accounts after election ends
  async releaseBlockedAccounts(electionId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get all blocked accounts for this election
      const blockedResult = await client.query(
        `SELECT * FROM votteryy_blocked_accounts
         WHERE election_id = $1 AND status = 'locked'`,
        [electionId]
      );

      for (const blocked of blockedResult.rows) {
        // Move from blocked to available balance
        await client.query(
          `UPDATE votteryy_user_wallets
           SET balance = balance + $1,
               blocked_balance = blocked_balance - $1
           WHERE user_id = $2`,
          [blocked.amount, blocked.user_id]
        );

        // Update blocked account status
        await client.query(
          `UPDATE votteryy_blocked_accounts
           SET status = 'released', released_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [blocked.id]
        );

        // Record transaction
        await client.query(
          `INSERT INTO votteryy_wallet_transactions
           (user_id, transaction_type, amount, election_id, status, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [blocked.user_id, 'election_refund', blocked.amount, electionId, 'success', 'Election participation fee released']
        );
      }

      await client.query('COMMIT');

      return { success: true, releasedCount: blockedResult.rows.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default new PaymentService();