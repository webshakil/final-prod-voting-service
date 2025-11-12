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
async processElectionPayment(userId, electionId, amount, regionCode, currency = 'USD') {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingPayment = await client.query(
      `SELECT * FROM votteryy_election_payments
       WHERE user_id = $1 AND election_id = $2 AND status IN ('succeeded', 'pending')
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, electionId]
    );

    if (existingPayment.rows.length > 0) {
      const payment = existingPayment.rows[0];
      
      if (payment.status === 'succeeded') {
        await client.query('ROLLBACK');
        console.log('✅ Payment already succeeded for this election');
        
        return {
          success: true,
          clientSecret: payment.client_secret,
          paymentIntentId: payment.payment_intent_id,
          gateway: payment.gateway_used,
          payment: payment,
          alreadyPaid: true
        };
      }
      
      // ✅ If pending, verify with Stripe first
      if (payment.status === 'pending' && payment.payment_intent_id) {
        console.log('⚠️ Found pending payment, verifying with Stripe:', payment.payment_intent_id);
        
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(payment.payment_intent_id);
          
          if (paymentIntent.status === 'succeeded') {
            console.log('✅ Stripe confirmed payment succeeded, updating database');
            
            await client.query(
              `UPDATE votteryy_election_payments 
               SET status = 'succeeded', updated_at = CURRENT_TIMESTAMP 
               WHERE payment_intent_id = $1`,
              [payment.payment_intent_id]
            );
            
            await client.query('COMMIT');
            
            return {
              success: true,
              clientSecret: payment.client_secret,
              paymentIntentId: payment.payment_intent_id,
              gateway: payment.gateway_used,
              payment: { ...payment, status: 'succeeded' },
              alreadyPaid: true
            };
          } else if (paymentIntent.status === 'requires_payment_method' || paymentIntent.status === 'requires_confirmation') {
            console.log('⚠️ Payment still pending, returning existing');
            await client.query('ROLLBACK');
            
            return {
              success: true,
              clientSecret: payment.client_secret,
              paymentIntentId: payment.payment_intent_id,
              gateway: payment.gateway_used,
              payment: payment
            };
          }
        } catch (stripeError) {
          console.error('❌ Error checking Stripe:', stripeError.message);
        }
      }
      
      // If pending but no valid state, delete and create new
      if (payment.status === 'pending') {
        console.log('⚠️ Deleting invalid pending payment');
        await client.query(
          `DELETE FROM votteryy_election_payments WHERE id = $1`,
          [payment.id]
        );
      }
    }

    // Create new payment (rest of your existing code)
    const { gateway } = await this.getGatewayForRegion(regionCode);

    const electionResult = await client.query(
      `SELECT processing_fee_percentage FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    const processingFeePercentage = electionResult.rows[0]?.processing_fee_percentage || 0;
    const platformFee = (amount * processingFeePercentage) / 100;

    let paymentResult;
    const metadata = { userId, electionId, type: 'election_participation' };

    console.log('🔵 Creating new payment with gateway:', gateway);

    if (gateway === 'stripe') {
      paymentResult = await this.createStripePayment(amount, currency, metadata);
    } else {
      paymentResult = await this.createPaddlePayment(amount, currency, metadata);
    }

    console.log('✅ Payment result:', {
      paymentIntentId: paymentResult.paymentIntentId,
      clientSecret: paymentResult.clientSecret ? 'exists' : 'NULL',
      gateway: paymentResult.gateway
    });

    const paymentRecord = await client.query(
      `INSERT INTO votteryy_election_payments 
       (user_id, election_id, payment_intent_id, gateway_used, amount, platform_fee, currency, status, client_secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId, 
        electionId, 
        paymentResult.paymentIntentId, 
        gateway, 
        amount, 
        platformFee, 
        currency, 
        'pending',
        paymentResult.clientSecret
      ]
    );

    console.log('✅ Payment record saved');

    await client.query('COMMIT');

    return {
      success: true,
      clientSecret: paymentResult.clientSecret,
      paymentIntentId: paymentResult.paymentIntentId,
      gateway: gateway,
      payment: paymentRecord.rows[0]
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('💥 Payment service error:', error);
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