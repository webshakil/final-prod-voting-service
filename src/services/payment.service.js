// src/services/payment.service.js - COMPLETE FILE
import stripe from '../config/stripe.js';
import paddleClient, { paddleConfig } from '../config/paddle.js';
import pool from '../config/database.js';
import axios from 'axios';

class PaymentService {

  // Get payment gateway for region
  async getGatewayForRegion(regionCode) {
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

    if (config.gateway_name === 'both') {
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
        amount: Math.round(amount * 100),
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

  // createPaddlePayment
  async createPaddlePayment(amount, currency, metadata) {
    try {
      console.log('🟣 Creating Paddle payment:', { amount, currency, metadata });

      // Step 1: Create a one-time price
      const pricePayload = {
        description: `Election #${metadata.electionId} Participation Fee`,
        name: 'Election Participation',
        type: 'standard',
        billing_cycle: null,
        trial_period: null,
        tax_mode: 'account_setting',
        unit_price: {
          amount: String(Math.round(amount * 100)),
          currency_code: currency.toUpperCase()
        },
        quantity: {
          minimum: 1,
          maximum: 1
        }
      };

      const apiKey = paddleConfig.apiKey.trim();

      console.log('🟣 Step 1: Creating price...');
      
      const priceResponse = await axios({
        method: 'POST',
        url: `${paddleConfig.baseURL}/prices`,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        data: pricePayload
      });

      const priceId = priceResponse.data.data.id;
      console.log('✅ Price created:', priceId);

      // Step 2: Create transaction with the price
      const transactionPayload = {
        items: [{
          price_id: priceId,
          quantity: 1
        }],
        customer_email: metadata.email || 'voter@vottery.com',
        custom_data: {
          userId: String(metadata.userId),
          electionId: String(metadata.electionId),
          creatorId: String(metadata.creatorId),
          type: metadata.type
        }
      };

      console.log('🟣 Step 2: Creating transaction...');

      const transactionResponse = await axios({
        method: 'POST',
        url: `${paddleConfig.baseURL}/transactions`,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        data: transactionPayload
      });

      console.log('✅ Paddle transaction response:', JSON.stringify(transactionResponse.data, null, 2));

      const transaction = transactionResponse.data.data;
      
      // Get checkout URL from transaction
      const checkoutUrl = `https://buy.paddle.com/checkout/${transaction.id}`;

      return {
        success: true,
        checkoutUrl: checkoutUrl,
        orderId: transaction.id,
        gateway: 'paddle'
      };

    } catch (error) {
      console.error('❌ Paddle error:', error.response?.data || error.message);
      throw new Error(`Paddle payment failed: ${error.response?.data?.error?.detail || error.message}`);
    }
  }

  // ✅ UPDATED: Process election participation payment with Paddle support
  async processElectionPayment(userId, electionId, amount, regionCode, gateway = 'stripe', userEmail = null) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      console.log('💳 Processing election payment:', { userId, electionId, amount, gateway });

      // ✅ Get election creator
      const electionResult = await client.query(
        `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        throw new Error('Election not found');
      }

      const creatorId = electionResult.rows[0].creator_id;
      console.log('👤 Election creator:', creatorId);

      // ✅ Check if payment already exists
      const existingPaymentResult = await client.query(
        `SELECT * FROM votteryy_election_payments 
         WHERE user_id = $1 AND election_id = $2 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [userId, electionId]
      );

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

        // If pending or failed, reuse it
        if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
          console.log('♻️ Reusing existing payment record');
          
          await client.query(
            `UPDATE votteryy_election_payments 
             SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [existingPayment.id]
          );

          // ✅ Create payment based on gateway
          let paymentResponse;
          if (gateway === 'paddle') {
            paymentResponse = await this.createPaddlePayment(amount, 'USD', {
              userId,
              electionId,
              creatorId,
              type: 'election_payment',
              email: userEmail
            });

            await client.query(
              `UPDATE votteryy_election_payments 
               SET gateway_transaction_id = $1, gateway_used = 'paddle'
               WHERE id = $2`,
              [paymentResponse.orderId, existingPayment.id]
            );

            await client.query('COMMIT');

            return {
              payment: existingPayment,
              checkoutUrl: paymentResponse.checkoutUrl,
              orderId: paymentResponse.orderId,
              gateway: 'paddle'
            };
          } else {
            paymentResponse = await this.createStripePayment(amount, 'USD', {
              userId,
              electionId,
              creatorId,
              type: 'election_payment'
            });

            await client.query(
              `UPDATE votteryy_election_payments 
               SET payment_intent_id = $1 
               WHERE id = $2`,
              [paymentResponse.paymentIntentId, existingPayment.id]
            );

            await client.query('COMMIT');

            return {
              payment: existingPayment,
              clientSecret: paymentResponse.clientSecret,
              paymentIntentId: paymentResponse.paymentIntentId,
              gateway: 'stripe'
            };
          }
        }
      }

      // ✅ Create new payment based on gateway
      console.log('🆕 Creating new payment record');

      let paymentResponse;
      let paymentResult;

      if (gateway === 'paddle') {
        paymentResponse = await this.createPaddlePayment(amount, 'USD', {
          userId,
          electionId,
          creatorId,
          type: 'election_payment',
          email: userEmail
        });

        paymentResult = await client.query(
          `INSERT INTO votteryy_election_payments 
           (user_id, election_id, amount, currency, status, gateway_transaction_id, gateway_used, region_code, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            userId, 
            electionId, 
            amount, 
            'USD', 
            'pending', 
            paymentResponse.orderId, 
            'paddle', 
            regionCode,
            JSON.stringify({ creatorId })
          ]
        );

        await client.query('COMMIT');

        return {
          payment: paymentResult.rows[0],
          checkoutUrl: paymentResponse.checkoutUrl,
          orderId: paymentResponse.orderId,
          gateway: 'paddle'
        };
      } else {
        paymentResponse = await this.createStripePayment(amount, 'USD', {
          userId,
          electionId,
          creatorId,
          type: 'election_payment'
        });

        paymentResult = await client.query(
          `INSERT INTO votteryy_election_payments 
           (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            userId, 
            electionId, 
            amount, 
            'USD', 
            'pending', 
            paymentResponse.paymentIntentId, 
            'stripe', 
            regionCode,
            JSON.stringify({ creatorId })
          ]
        );

        await client.query('COMMIT');

        return {
          payment: paymentResult.rows[0],
          clientSecret: paymentResponse.clientSecret,
          paymentIntentId: paymentResponse.paymentIntentId,
          gateway: 'stripe'
        };
      }

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Process election payment error:', error);
      throw error;
    } finally {
      client.release();
    }
  }










  // ✅ FIXED: Confirm payment with proper transaction recording

async confirmPaymentAndBlock(paymentIntentId, electionId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

    // Get payment record (works for both payment_intent_id and gateway_transaction_id)
    const paymentResult = await client.query(
      `SELECT * FROM votteryy_election_payments
       WHERE (payment_intent_id = $1 OR gateway_transaction_id = $1)
       AND election_id = $2`,
      [paymentIntentId, electionId]
    );

    if (paymentResult.rows.length === 0) {
      throw new Error('Payment not found');
    }

    const payment = paymentResult.rows[0];

    // ✅ FIX: Convert amount to number
    const amount = parseFloat(payment.amount);
    
    if (isNaN(amount)) {
      throw new Error('Invalid payment amount');
    }

    // Already succeeded? Skip
    if (payment.status === 'succeeded') {
      console.log('⚠️ Payment already confirmed');
      await client.query('ROLLBACK');
      return { success: true, alreadyProcessed: true };
    }

    // ✅ Get election details including title
    const electionResult = await client.query(
      `SELECT creator_id, title, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      throw new Error('Election not found');
    }

    const election = electionResult.rows[0];
    const creatorId = election.creator_id;
    
    // ✅ Calculate lock date
    let lockedUntil;
    if (election.end_date) {
      lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);
      if (isNaN(lockedUntil.getTime())) {
        lockedUntil = new Date();
        lockedUntil.setDate(lockedUntil.getDate() + 30);
      }
    } else {
      lockedUntil = new Date();
      lockedUntil.setDate(lockedUntil.getDate() + 30);
    }

    console.log('👤 Creator ID:', creatorId);
    console.log('🔒 Locked until:', lockedUntil);

    // ✅ GET CREATOR'S PLATFORM FEE FROM SUBSCRIPTION (NO DEFAULT)
    const processingFeeConfig = await this.getUserProcessingFee(creatorId);
    
    // ✅ Calculate fees based on gateway (using parsed amount)
    let gatewayFee, platformFee, netAmount;
    
    if (payment.gateway_used === 'paddle') {
      // Paddle: 5% + $0.50
      gatewayFee = (amount * 0.05) + 0.50;
      platformFee = this.calculateProcessingFee(amount, processingFeeConfig);
      netAmount = amount - gatewayFee - platformFee;

      console.log('\n💰 PAYMENT BREAKDOWN (Paddle):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Voter Paid:           $${amount.toFixed(2)}`);
      console.log(`- Paddle Fee (5%+$0.50): -$${gatewayFee.toFixed(2)}`);
      console.log(`- Platform Fee (${processingFeeConfig.type === 'fixed' ? '$' + processingFeeConfig.fixedAmount.toFixed(2) : processingFeeConfig.percentage + '%'}):    -$${platformFee.toFixed(2)}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
      console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      await client.query(
        `UPDATE votteryy_election_payments
         SET status = 'succeeded', 
             paddle_fee = $1,
             platform_fee = $2,
             net_amount = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [gatewayFee, platformFee, netAmount, payment.id]
      );
    } else {
      // Stripe: 2.9% + $0.30
      gatewayFee = (amount * 0.029) + 0.30;
      platformFee = this.calculateProcessingFee(amount, processingFeeConfig);
      netAmount = amount - gatewayFee - platformFee;

      console.log('\n💰 PAYMENT BREAKDOWN (Stripe):');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Voter Paid:           $${amount.toFixed(2)}`);
      console.log(`- Stripe Fee (2.9%+$0.30): -$${gatewayFee.toFixed(2)}`);
      console.log(`- Platform Fee (${processingFeeConfig.type === 'fixed' ? '$' + processingFeeConfig.fixedAmount.toFixed(2) : processingFeeConfig.percentage + '%'}):    -$${platformFee.toFixed(2)}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
      console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      await client.query(
        `UPDATE votteryy_election_payments
         SET status = 'succeeded', 
             stripe_fee = $1,
             platform_fee = $2,
             net_amount = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [gatewayFee, platformFee, netAmount, payment.id]
      );
    }

    // ✅ Ensure creator has a wallet
    await client.query(
      `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
       VALUES ($1, 0, 0, 'USD')
       ON CONFLICT (user_id) DO NOTHING`,
      [creatorId]
    );

    // ✅ Add to creator's BLOCKED balance (NOT available - frozen until election ends)
    await client.query(
      `UPDATE votteryy_wallets
       SET blocked_balance = blocked_balance + $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2`,
      [netAmount, creatorId]
    );

    console.log(`🔒 FROZEN: $${netAmount.toFixed(2)} added to creator's blocked balance`);
    console.log(`📅 Will be released when election ends: ${lockedUntil.toLocaleString()}\n`);

    // ✅ NEW: Add platform fee to platform owner's wallet (user_id = 1)
    if (platformFee > 0) {
      await client.query(
        `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
         VALUES (1, 0, 0, 'USD')
         ON CONFLICT (user_id) DO NOTHING`
      );

      await client.query(
        `UPDATE votteryy_wallets
         SET balance = balance + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = 1`,
        [platformFee]
      );

      console.log(`💎 Platform fee $${platformFee.toFixed(2)} added to platform owner wallet (user_id=1)`);
    }

    // ✅ Create blocked account record
    if (payment.gateway_used === 'paddle') {
      await client.query(
        `INSERT INTO votteryy_blocked_accounts
         (user_id, election_id, amount, paddle_fee, platform_fee, status, locked_until)
         VALUES ($1, $2, $3, $4, $5, 'locked', $6)
         ON CONFLICT (user_id, election_id) 
         DO UPDATE SET 
           amount = votteryy_blocked_accounts.amount + $3,
           paddle_fee = COALESCE(votteryy_blocked_accounts.paddle_fee, 0) + $4,
           platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
        [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
      );
    } else {
      await client.query(
        `INSERT INTO votteryy_blocked_accounts
         (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
         VALUES ($1, $2, $3, $4, $5, 'locked', $6)
         ON CONFLICT (user_id, election_id) 
         DO UPDATE SET 
           amount = votteryy_blocked_accounts.amount + $3,
           stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
           platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
        [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
      );
    }

    // ✅ Record transaction for CREATOR with detailed breakdown (using parsed amount)
    const creatorDescription = payment.gateway_used === 'paddle'
      ? `Revenue from "${election.title}" - Voter paid $${amount.toFixed(2)} | Paddle fee: -$${gatewayFee.toFixed(2)} | Platform fee: -$${platformFee.toFixed(2)} | Net earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`
      : `Revenue from "${election.title}" - Voter paid $${amount.toFixed(2)} | Stripe fee: -$${gatewayFee.toFixed(2)} | Platform fee: -$${platformFee.toFixed(2)} | Net earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`;

    await client.query(
      `INSERT INTO votteryy_transactions
       (user_id, transaction_type, amount, net_amount, ${payment.gateway_used === 'paddle' ? 'paddle_fee' : 'stripe_fee'}, platform_fee, status, description, election_id, metadata, created_at)
       VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7, $8, CURRENT_TIMESTAMP)`,
      [
        creatorId,
        amount, // Use parsed amount
        netAmount,
        gatewayFee,
        platformFee,
        creatorDescription,
        electionId,
        JSON.stringify({
          voterPaid: amount,
          gatewayFee: gatewayFee,
          platformFee: platformFee,
          netAmount: netAmount,
          gateway: payment.gateway_used,
          locked: true,
          lockedUntil: lockedUntil,
          platformFeeType: processingFeeConfig.type,
          platformFeeValue: processingFeeConfig.type === 'fixed' ? processingFeeConfig.fixedAmount : processingFeeConfig.percentage
        })
      ]
    );

    console.log('✅ Creator transaction recorded');

    // ✅ NEW: Record platform fee transaction
    if (platformFee > 0) {
      const platformDescription = `Platform fee from election "${election.title}" - Creator: ${creatorId} | Fee: $${platformFee.toFixed(2)} (${processingFeeConfig.type === 'fixed' ? 'Fixed $' + processingFeeConfig.fixedAmount.toFixed(2) : processingFeeConfig.percentage + '%'})`;

      await client.query(
        `INSERT INTO votteryy_transactions
         (user_id, transaction_type, amount, net_amount, status, description, election_id, metadata, created_at)
         VALUES (1, 'platform_fee_revenue', $1, $1, 'success', $2, $3, $4, CURRENT_TIMESTAMP)`,
        [
          platformFee,
          platformDescription,
          electionId,
          JSON.stringify({
            creatorId: creatorId,
            electionId: electionId,
            voterPaid: amount,
            platformFee: platformFee,
            feeType: processingFeeConfig.type,
            feeValue: processingFeeConfig.type === 'fixed' ? processingFeeConfig.fixedAmount : processingFeeConfig.percentage
          })
        ]
      );

      console.log('✅ Platform fee transaction recorded');
    }

    const voterDescription = `Paid $${amount.toFixed(2)} to participate in "${election.title}"`;

    await client.query(
      `INSERT INTO votteryy_transactions
       (user_id, transaction_type, amount, net_amount, status, description, election_id, metadata, created_at)
       VALUES ($1, 'election_participation_fee', $2, $3, 'success', $4, $5, $6, CURRENT_TIMESTAMP)`,
      [
        payment.user_id,
        amount, // Use parsed amount
        amount, // Voter pays full amount
        voterDescription,
        electionId,
        JSON.stringify({
          amountPaid: amount,
          gateway: payment.gateway_used,
          paymentId: payment.id,
          electionId: electionId,
          electionTitle: election.title
        })
      ]
    );

    console.log('✅ Voter transaction recorded');

    await client.query('COMMIT');

    console.log('✅ Payment confirmed successfully!\n');

    return { 
      success: true, 
      payment, 
      breakdown: {
        voterPaid: amount,
        gatewayFee,
        platformFee,
        creatorReceives: netAmount,
        lockedUntil
      }
    };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Confirm payment error:', error);
    throw error;
  } finally {
    client.release();
  }
}


  // ✅ CHANGED: Get processing fee from subscription plan ONLY - NO DEFAULT
  // ✅ FIXED: Get processing fee from subscription plan
async getUserProcessingFee(userId) {
  try {
    const result = await pool.query(
      `SELECT 
         sp.processing_fee_enabled,
         sp.processing_fee_mandatory,
         sp.processing_fee_type,
         sp.processing_fee_fixed_amount,
         sp.processing_fee_percentage,
         sp.plan_type,
         sp.duration_days
       FROM votteryy_user_subscriptions us
       JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
       WHERE us.user_id = $1 
         AND us.status = 'active'
         AND (
           -- Pay-as-you-go: no expiration (duration_days = 0), always valid if active
           sp.duration_days = 0
           OR
           -- Other plans: check end_date hasn't passed
           us.end_date > NOW()
         )
       ORDER BY us.created_at DESC
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // ✅ FREE USER = No subscription = 0% platform fee
      console.log(`📋 User ${userId}: No active subscription - FREE (0% platform fee)`);
      return {
        enabled: false,
        mandatory: false,
        type: 'percentage',
        fixedAmount: 0,
        percentage: 0
      };
    }

    const plan = result.rows[0];
    
    console.log(`📋 User ${userId}: Active subscription found - ${plan.plan_type}`);
    console.log(`   Fee Type: ${plan.processing_fee_type}, Value: ${plan.processing_fee_type === 'fixed' ? '$' + plan.processing_fee_fixed_amount : plan.processing_fee_percentage + '%'}`);

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


  calculateProcessingFee(amount, feeConfig) {
    // ✅ FIXED: Apply fee if configured, regardless of enabled flag
    // If there's no fee amount configured, return 0
    if (feeConfig.type === 'fixed') {
      const fixedFee = parseFloat(feeConfig.fixedAmount) || 0;
      return fixedFee;
    } else {
      const percentage = parseFloat(feeConfig.percentage) || 0;
      return (amount * percentage) / 100;
    }
  }

  async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const walletResult = await client.query(
        `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
        [userId]
      );

      if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
        throw new Error('Insufficient balance');
      }

      const withdrawalResult = await client.query(
        `INSERT INTO votteryy_withdrawal_requests
         (user_id, amount, payment_method, payment_details, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
      );

      const withdrawal = withdrawalResult.rows[0];

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

  async executeWithdrawal(requestId, adminId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

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

      await client.query(
        `UPDATE votteryy_wallets
         SET balance = balance - $1
         WHERE user_id = $2`,
        [request.amount, request.user_id]
      );

      await client.query(
        `INSERT INTO votteryy_transactions
         (user_id, transaction_type, amount, status, description)
         VALUES ($1, $2, $3, $4, $5)`,
        [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
      );

      await client.query(
        `UPDATE votteryy_withdrawal_requests
         SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
         WHERE request_id = $2`,
        [adminId, requestId]
      );

      await client.query('COMMIT');

      return { success: true, message: 'Withdrawal processed successfully' };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ✅ NOT CHANGED: Release blocked accounts remains the same
  async releaseBlockedAccounts(electionId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      console.log('🔓 Releasing blocked accounts for election:', electionId);

      const blockedResult = await client.query(
        `SELECT * FROM votteryy_blocked_accounts
         WHERE election_id = $1 AND status = 'locked'`,
        [electionId]
      );

      console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

      for (const blocked of blockedResult.rows) {
        // ✅ FIX: Convert PostgreSQL numeric to JavaScript number
        const amount = parseFloat(blocked.amount);
        const platformFee = parseFloat(blocked.platform_fee) || 0;
        const stripeFee = parseFloat(blocked.stripe_fee) || 0;

        await client.query(
          `UPDATE votteryy_wallets
           SET balance = balance + $1,
               blocked_balance = blocked_balance - $1
           WHERE user_id = $2`,
          [amount, blocked.user_id]
        );

        await client.query(
          `UPDATE votteryy_blocked_accounts
           SET status = 'released', released_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [blocked.id]
        );

        await client.query(
          `INSERT INTO votteryy_transactions
           (user_id, transaction_type, amount, election_id, status, description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            blocked.user_id, 
            'election_funds_released', 
            amount, // ✅ Use the parsed number
            electionId, 
            'success', 
            `Election #${electionId} ended - $${amount.toFixed(2)} released and available for withdrawal` // ✅ Now .toFixed() works
          ]
        );

        console.log(`✅ Released $${amount.toFixed(2)} for user ${blocked.user_id}`);
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
//last workable code. for default fee removed and better handling
// // src/services/payment.service.js - COMPLETE FILE
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';
// import axios from 'axios';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     if (config.gateway_name === 'both') {
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }

//   // createPaddlePayment
//   async createPaddlePayment(amount, currency, metadata) {
//     try {
//       console.log('🟣 Creating Paddle payment:', { amount, currency, metadata });

//       // Step 1: Create a one-time price
//       const pricePayload = {
//         description: `Election #${metadata.electionId} Participation Fee`,
//         name: 'Election Participation',
//         type: 'standard',
//         billing_cycle: null,
//         trial_period: null,
//         tax_mode: 'account_setting',
//         unit_price: {
//           amount: String(Math.round(amount * 100)),
//           currency_code: currency.toUpperCase()
//         },
//         quantity: {
//           minimum: 1,
//           maximum: 1
//         }
//       };

//       const apiKey = paddleConfig.apiKey.trim();

//       console.log('🟣 Step 1: Creating price...');
      
//       const priceResponse = await axios({
//         method: 'POST',
//         url: `${paddleConfig.baseURL}/prices`,
//         headers: {
//           'Authorization': `Bearer ${apiKey}`,
//           'Content-Type': 'application/json'
//         },
//         data: pricePayload
//       });

//       const priceId = priceResponse.data.data.id;
//       console.log('✅ Price created:', priceId);

//       // Step 2: Create transaction with the price
//       const transactionPayload = {
//         items: [{
//           price_id: priceId,
//           quantity: 1
//         }],
//         customer_email: metadata.email || 'voter@vottery.com',
//         custom_data: {
//           userId: String(metadata.userId),
//           electionId: String(metadata.electionId),
//           creatorId: String(metadata.creatorId),
//           type: metadata.type
//         }
//       };

//       console.log('🟣 Step 2: Creating transaction...');

//       const transactionResponse = await axios({
//         method: 'POST',
//         url: `${paddleConfig.baseURL}/transactions`,
//         headers: {
//           'Authorization': `Bearer ${apiKey}`,
//           'Content-Type': 'application/json'
//         },
//         data: transactionPayload
//       });

//       console.log('✅ Paddle transaction response:', JSON.stringify(transactionResponse.data, null, 2));

//       const transaction = transactionResponse.data.data;
      
//       // Get checkout URL from transaction
//       const checkoutUrl = `https://buy.paddle.com/checkout/${transaction.id}`;

//       return {
//         success: true,
//         checkoutUrl: checkoutUrl,
//         orderId: transaction.id,
//         gateway: 'paddle'
//       };

//     } catch (error) {
//       console.error('❌ Paddle error:', error.response?.data || error.message);
//       throw new Error(`Paddle payment failed: ${error.response?.data?.error?.detail || error.message}`);
//     }
//   }

//   // ✅ UPDATED: Process election participation payment with Paddle support
//   async processElectionPayment(userId, electionId, amount, regionCode, gateway = 'stripe', userEmail = null) {
//     const client = await pool.connect();
    
//     try {
//       await client.query('BEGIN');

//       console.log('💳 Processing election payment:', { userId, electionId, amount, gateway });

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const creatorId = electionResult.rows[0].creator_id;
//       console.log('👤 Election creator:', creatorId);

//       // ✅ Check if payment already exists
//       const existingPaymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments 
//          WHERE user_id = $1 AND election_id = $2 
//          ORDER BY created_at DESC 
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       if (existingPaymentResult.rows.length > 0) {
//         const existingPayment = existingPaymentResult.rows[0];
        
//         console.log('📋 Existing payment found:', existingPayment);

//         if (existingPayment.status === 'succeeded') {
//           console.log('✅ Payment already completed');
//           await client.query('COMMIT');
//           return {
//             alreadyPaid: true,
//             payment: existingPayment,
//             message: 'You have already paid for this election'
//           };
//         }

//         // If pending or failed, reuse it
//         if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//           console.log('♻️ Reusing existing payment record');
          
//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
//              WHERE id = $1`,
//             [existingPayment.id]
//           );

//           // ✅ Create payment based on gateway
//           let paymentResponse;
//           if (gateway === 'paddle') {
//             paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment',
//               email: userEmail
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET gateway_transaction_id = $1, gateway_used = 'paddle'
//                WHERE id = $2`,
//               [paymentResponse.orderId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               checkoutUrl: paymentResponse.checkoutUrl,
//               orderId: paymentResponse.orderId,
//               gateway: 'paddle'
//             };
//           } else {
//             paymentResponse = await this.createStripePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment'
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET payment_intent_id = $1 
//                WHERE id = $2`,
//               [paymentResponse.paymentIntentId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               clientSecret: paymentResponse.clientSecret,
//               paymentIntentId: paymentResponse.paymentIntentId,
//               gateway: 'stripe'
//             };
//           }
//         }
//       }

//       // ✅ Create new payment based on gateway
//       console.log('🆕 Creating new payment record');

//       let paymentResponse;
//       let paymentResult;

//       if (gateway === 'paddle') {
//         paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment',
//           email: userEmail
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, gateway_transaction_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.orderId, 
//             'paddle', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           checkoutUrl: paymentResponse.checkoutUrl,
//           orderId: paymentResponse.orderId,
//           gateway: 'paddle'
//         };
//       } else {
//         paymentResponse = await this.createStripePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment'
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.paymentIntentId, 
//             'stripe', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           clientSecret: paymentResponse.clientSecret,
//           paymentIntentId: paymentResponse.paymentIntentId,
//           gateway: 'stripe'
//         };
//       }

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Process election payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }










//   // ✅ FIXED: Confirm payment with proper transaction recording

// async confirmPaymentAndBlock(paymentIntentId, electionId) {
//   const client = await pool.connect();
//   try {
//     await client.query('BEGIN');

//     console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

//     // Get payment record (works for both payment_intent_id and gateway_transaction_id)
//     const paymentResult = await client.query(
//       `SELECT * FROM votteryy_election_payments
//        WHERE (payment_intent_id = $1 OR gateway_transaction_id = $1)
//        AND election_id = $2`,
//       [paymentIntentId, electionId]
//     );

//     if (paymentResult.rows.length === 0) {
//       throw new Error('Payment not found');
//     }

//     const payment = paymentResult.rows[0];

//     // ✅ FIX: Convert amount to number
//     const amount = parseFloat(payment.amount);
    
//     if (isNaN(amount)) {
//       throw new Error('Invalid payment amount');
//     }

//     // Already succeeded? Skip
//     if (payment.status === 'succeeded') {
//       console.log('⚠️ Payment already confirmed');
//       await client.query('ROLLBACK');
//       return { success: true, alreadyProcessed: true };
//     }

//     // ✅ Get election details including title
//     const electionResult = await client.query(
//       `SELECT creator_id, title, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       throw new Error('Election not found');
//     }

//     const election = electionResult.rows[0];
//     const creatorId = election.creator_id;
    
//     // ✅ Calculate lock date
//     let lockedUntil;
//     if (election.end_date) {
//       lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);
//       if (isNaN(lockedUntil.getTime())) {
//         lockedUntil = new Date();
//         lockedUntil.setDate(lockedUntil.getDate() + 30);
//       }
//     } else {
//       lockedUntil = new Date();
//       lockedUntil.setDate(lockedUntil.getDate() + 30);
//     }

//     console.log('👤 Creator ID:', creatorId);
//     console.log('🔒 Locked until:', lockedUntil);

//     // ✅ GET CREATOR'S PLATFORM FEE (or use 5% default)
//     const processingFeeConfig = await this.getUserProcessingFee(creatorId);
    
//     // ✅ Calculate fees based on gateway (using parsed amount)
//     let gatewayFee, platformFee, netAmount;
    
//     if (payment.gateway_used === 'paddle') {
//       // Paddle: 5% + $0.50
//       gatewayFee = (amount * 0.05) + 0.50;
//       platformFee = this.calculateProcessingFee(amount, processingFeeConfig);
//       netAmount = amount - gatewayFee - platformFee;

//       console.log('\n💰 PAYMENT BREAKDOWN (Paddle):');
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//       console.log(`Voter Paid:           $${amount.toFixed(2)}`);
//       console.log(`- Paddle Fee (5%+$0.50): -$${gatewayFee.toFixed(2)}`);
//       console.log(`- Platform Fee (${processingFeeConfig.percentage}%):    -$${platformFee.toFixed(2)}`);
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//       console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
//       console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

//       await client.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'succeeded', 
//              paddle_fee = $1,
//              platform_fee = $2,
//              net_amount = $3,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE id = $4`,
//         [gatewayFee, platformFee, netAmount, payment.id]
//       );
//     } else {
//       // Stripe: 2.9% + $0.30
//       gatewayFee = (amount * 0.029) + 0.30;
//       platformFee = this.calculateProcessingFee(amount, processingFeeConfig);
//       netAmount = amount - gatewayFee - platformFee;

//       console.log('\n💰 PAYMENT BREAKDOWN (Stripe):');
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//       console.log(`Voter Paid:           $${amount.toFixed(2)}`);
//       console.log(`- Stripe Fee (2.9%+$0.30): -$${gatewayFee.toFixed(2)}`);
//       console.log(`- Platform Fee (${processingFeeConfig.percentage}%):    -$${platformFee.toFixed(2)}`);
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//       console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
//       console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
//       console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

//       await client.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'succeeded', 
//              stripe_fee = $1,
//              platform_fee = $2,
//              net_amount = $3,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE id = $4`,
//         [gatewayFee, platformFee, netAmount, payment.id]
//       );
//     }

//     // ✅ Ensure creator has a wallet
//     await client.query(
//       `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//        VALUES ($1, 0, 0, 'USD')
//        ON CONFLICT (user_id) DO NOTHING`,
//       [creatorId]
//     );

//     // ✅ Add to creator's BLOCKED balance (NOT available - frozen until election ends)
//     await client.query(
//       `UPDATE votteryy_wallets
//        SET blocked_balance = blocked_balance + $1,
//            updated_at = CURRENT_TIMESTAMP
//        WHERE user_id = $2`,
//       [netAmount, creatorId]
//     );

//     console.log(`🔒 FROZEN: $${netAmount.toFixed(2)} added to creator's blocked balance`);
//     console.log(`📅 Will be released when election ends: ${lockedUntil.toLocaleString()}\n`);

//     // ✅ Create blocked account record
//     if (payment.gateway_used === 'paddle') {
//       await client.query(
//         `INSERT INTO votteryy_blocked_accounts
//          (user_id, election_id, amount, paddle_fee, platform_fee, status, locked_until)
//          VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//          ON CONFLICT (user_id, election_id) 
//          DO UPDATE SET 
//            amount = votteryy_blocked_accounts.amount + $3,
//            paddle_fee = COALESCE(votteryy_blocked_accounts.paddle_fee, 0) + $4,
//            platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//         [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//       );
//     } else {
//       await client.query(
//         `INSERT INTO votteryy_blocked_accounts
//          (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
//          VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//          ON CONFLICT (user_id, election_id) 
//          DO UPDATE SET 
//            amount = votteryy_blocked_accounts.amount + $3,
//            stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
//            platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//         [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//       );
//     }

//     // ✅ Record transaction for CREATOR with detailed breakdown (using parsed amount)
//     const creatorDescription = payment.gateway_used === 'paddle'
//       ? `Revenue from "${election.title}" - Voter paid $${amount.toFixed(2)} | Paddle fee: -$${gatewayFee.toFixed(2)} | Platform fee: -$${platformFee.toFixed(2)} | Net earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`
//       : `Revenue from "${election.title}" - Voter paid $${amount.toFixed(2)} | Stripe fee: -$${gatewayFee.toFixed(2)} | Platform fee: -$${platformFee.toFixed(2)} | Net earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`;

//     await client.query(
//       `INSERT INTO votteryy_transactions
//        (user_id, transaction_type, amount, net_amount, ${payment.gateway_used === 'paddle' ? 'paddle_fee' : 'stripe_fee'}, platform_fee, status, description, election_id, metadata, created_at)
//        VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7, $8, CURRENT_TIMESTAMP)`,
//       [
//         creatorId,
//         amount, // Use parsed amount
//         netAmount,
//         gatewayFee,
//         platformFee,
//         creatorDescription,
//         electionId,
//         JSON.stringify({
//           voterPaid: amount,
//           gatewayFee: gatewayFee,
//           platformFee: platformFee,
//           netAmount: netAmount,
//           gateway: payment.gateway_used,
//           locked: true,
//           lockedUntil: lockedUntil,
//           platformFeePercent: processingFeeConfig.percentage
//         })
//       ]
//     );

//     console.log('✅ Creator transaction recorded');



// const voterDescription = `Paid $${amount.toFixed(2)} to participate in "${election.title}"`;

//     await client.query(
//       `INSERT INTO votteryy_transactions
//        (user_id, transaction_type, amount, net_amount, status, description, election_id, metadata, created_at)
//        VALUES ($1, 'election_participation_fee', $2, $3, 'success', $4, $5, $6, CURRENT_TIMESTAMP)`,
//       [
//         payment.user_id,
//         amount, // Use parsed amount
//         amount, // Voter pays full amount
//         voterDescription,
//         electionId,
//         JSON.stringify({
//           amountPaid: amount,
//           gateway: payment.gateway_used,
//           paymentId: payment.id,
//           electionId: electionId,
//           electionTitle: election.title
//         })
//       ]
//     );

//     console.log('✅ Voter transaction recorded');

//     await client.query('COMMIT');

//     console.log('✅ Payment confirmed successfully!\n');

//     return { 
//       success: true, 
//       payment, 
//       breakdown: {
//         voterPaid: amount,
//         gatewayFee,
//         platformFee,
//         creatorReceives: netAmount,
//         lockedUntil
//       }
//     };
//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('❌ Confirm payment error:', error);
//     throw error;
//   } finally {
//     client.release();
//   }
// }


//   // ✅ FIXED: Default platform fee is 5%
//   async getUserProcessingFee(userId) {
//     try {
//       const result = await pool.query(
//         `SELECT 
//            sp.processing_fee_enabled,
//            sp.processing_fee_mandatory,
//            sp.processing_fee_type,
//            sp.processing_fee_fixed_amount,
//            sp.processing_fee_percentage
//          FROM votteryy_user_subscriptions us
//          JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//          WHERE us.user_id = $1 
//            AND us.status = 'active'
//            AND us.end_date > NOW()
//          ORDER BY us.created_at DESC
//          LIMIT 1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         // ✅ DEFAULT: 5% platform fee for users with NO subscription
//         return {
//           enabled: true,
//           mandatory: true,
//           type: 'percentage',
//           fixedAmount: 0,
//           percentage: 5.0
//         };
//       }

//       const plan = result.rows[0];
//       return {
//         enabled: plan.processing_fee_enabled,
//         mandatory: plan.processing_fee_mandatory,
//         type: plan.processing_fee_type,
//         fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//         percentage: parseFloat(plan.processing_fee_percentage || 0)
//       };
//     } catch (error) {
//       console.error('Get user processing fee error:', error);
//       throw error;
//     }
//   }

//   calculateProcessingFee(amount, feeConfig) {
//     if (!feeConfig.enabled) return 0;
    
//     if (feeConfig.type === 'fixed') {
//       return feeConfig.fixedAmount;
//     } else {
//       return (amount * feeConfig.percentage) / 100;
//     }
//   }

//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// async releaseBlockedAccounts(electionId) {
//   const client = await pool.connect();
//   try {
//     await client.query('BEGIN');

//     console.log('🔓 Releasing blocked accounts for election:', electionId);

//     const blockedResult = await client.query(
//       `SELECT * FROM votteryy_blocked_accounts
//        WHERE election_id = $1 AND status = 'locked'`,
//       [electionId]
//     );

//     console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//     for (const blocked of blockedResult.rows) {
//       // ✅ FIX: Convert PostgreSQL numeric to JavaScript number
//       const amount = parseFloat(blocked.amount);
//       const platformFee = parseFloat(blocked.platform_fee) || 0;
//       const stripeFee = parseFloat(blocked.stripe_fee) || 0;

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance + $1,
//              blocked_balance = blocked_balance - $1
//          WHERE user_id = $2`,
//         [amount, blocked.user_id]
//       );

//       await client.query(
//         `UPDATE votteryy_blocked_accounts
//          SET status = 'released', released_at = CURRENT_TIMESTAMP
//          WHERE id = $1`,
//         [blocked.id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, election_id, status, description)
//          VALUES ($1, $2, $3, $4, $5, $6)`,
//         [
//           blocked.user_id, 
//           'election_funds_released', 
//           amount, // ✅ Use the parsed number
//           electionId, 
//           'success', 
//           `Election #${electionId} ended - $${amount.toFixed(2)} released and available for withdrawal` // ✅ Now .toFixed() works
//         ]
//       );

//       console.log(`✅ Released $${amount.toFixed(2)} for user ${blocked.user_id}`);
//     }

//     await client.query('COMMIT');

//     return { success: true, releasedCount: blockedResult.rows.length };
//   } catch (error) {
//     await client.query('ROLLBACK');
//     throw error;
//   } finally {
//     client.release();
//   }
// }
//   // async releaseBlockedAccounts(electionId) {
//   //   const client = await pool.connect();
//   //   try {
//   //     await client.query('BEGIN');

//   //     console.log('🔓 Releasing blocked accounts for election:', electionId);

//   //     const blockedResult = await client.query(
//   //       `SELECT * FROM votteryy_blocked_accounts
//   //        WHERE election_id = $1 AND status = 'locked'`,
//   //       [electionId]
//   //     );

//   //     console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//   //     for (const blocked of blockedResult.rows) {
//   //       await client.query(
//   //         `UPDATE votteryy_wallets
//   //          SET balance = balance + $1,
//   //              blocked_balance = blocked_balance - $1
//   //          WHERE user_id = $2`,
//   //         [blocked.amount, blocked.user_id]
//   //       );

//   //       await client.query(
//   //         `UPDATE votteryy_blocked_accounts
//   //          SET status = 'released', released_at = CURRENT_TIMESTAMP
//   //          WHERE id = $1`,
//   //         [blocked.id]
//   //       );

//   //       await client.query(
//   //         `INSERT INTO votteryy_transactions
//   //          (user_id, transaction_type, amount, election_id, status, description)
//   //          VALUES ($1, $2, $3, $4, $5, $6)`,
//   //         [
//   //           blocked.user_id, 
//   //           'election_funds_released', 
//   //           blocked.amount, 
//   //           electionId, 
//   //           'success', 
//   //           `Election #${electionId} ended - $${blocked.amount.toFixed(2)} released and available for withdrawal`
//   //         ]
//   //       );

//   //       console.log(`✅ Released $${blocked.amount} for user ${blocked.user_id}`);
//   //     }

//   //     await client.query('COMMIT');

//   //     return { success: true, releasedCount: blockedResult.rows.length };
//   //   } catch (error) {
//   //     await client.query('ROLLBACK');
//   //     throw error;
//   //   } finally {
//   //     client.release();
//   //   }
//   // }
// }

// export default new PaymentService();
//last workable code
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';
// import axios from 'axios';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     if (config.gateway_name === 'both') {
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }


// // createPaddlePayment
// async createPaddlePayment(amount, currency, metadata) {
//   try {
//     console.log('🟣 Creating Paddle payment:', { amount, currency, metadata });

//     // ✅ CORRECT: Use /prices endpoint to create a one-time price, then /transactions
    
//     // Step 1: Create a one-time price
//     const pricePayload = {
//       description: `Election #${metadata.electionId} Participation Fee`,
//       name: 'Election Participation',
//       type: 'standard',
//       billing_cycle: null,
//       trial_period: null,
//       tax_mode: 'account_setting',
//       unit_price: {
//         amount: String(Math.round(amount * 100)),
//         currency_code: currency.toUpperCase()
//       },
//       quantity: {
//         minimum: 1,
//         maximum: 1
//       }
//     };

//     const apiKey = paddleConfig.apiKey.trim();

//     console.log('🟣 Step 1: Creating price...');
    
//     const priceResponse = await axios({
//       method: 'POST',
//       url: `${paddleConfig.baseURL}/prices`,
//       headers: {
//         'Authorization': `Bearer ${apiKey}`,
//         'Content-Type': 'application/json'
//       },
//       data: pricePayload
//     });

//     const priceId = priceResponse.data.data.id;
//     console.log('✅ Price created:', priceId);

//     // Step 2: Create transaction with the price
//     const transactionPayload = {
//       items: [{
//         price_id: priceId,
//         quantity: 1
//       }],
//       customer_email: metadata.email || 'voter@vottery.com',
//       custom_data: {
//         userId: String(metadata.userId),
//         electionId: String(metadata.electionId),
//         creatorId: String(metadata.creatorId),
//         type: metadata.type
//       }
//     };

//     console.log('🟣 Step 2: Creating transaction...');

//     const transactionResponse = await axios({
//       method: 'POST',
//       url: `${paddleConfig.baseURL}/transactions`,
//       headers: {
//         'Authorization': `Bearer ${apiKey}`,
//         'Content-Type': 'application/json'
//       },
//       data: transactionPayload
//     });

//     console.log('✅ Paddle transaction response:', JSON.stringify(transactionResponse.data, null, 2));

//     const transaction = transactionResponse.data.data;
    
//     // Get checkout URL from transaction
//     const checkoutUrl = `https://buy.paddle.com/checkout/${transaction.id}`;

//     return {
//       success: true,
//       checkoutUrl: checkoutUrl,
//       orderId: transaction.id,
//       gateway: 'paddle'
//     };

//   } catch (error) {
//     console.error('❌ Paddle error:', error.response?.data || error.message);
//     throw new Error(`Paddle payment failed: ${error.response?.data?.error?.detail || error.message}`);
//   }
// }

  

//   // ✅ UPDATED: Process election participation payment with Paddle support
//   async processElectionPayment(userId, electionId, amount, regionCode, gateway = 'stripe', userEmail = null) {
//     const client = await pool.connect();
    
//     try {
//       await client.query('BEGIN');

//       console.log('💳 Processing election payment:', { userId, electionId, amount, gateway });

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const creatorId = electionResult.rows[0].creator_id;
//       console.log('👤 Election creator:', creatorId);

//       // ✅ Check if payment already exists
//       const existingPaymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments 
//          WHERE user_id = $1 AND election_id = $2 
//          ORDER BY created_at DESC 
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       if (existingPaymentResult.rows.length > 0) {
//         const existingPayment = existingPaymentResult.rows[0];
        
//         console.log('📋 Existing payment found:', existingPayment);

//         if (existingPayment.status === 'succeeded') {
//           console.log('✅ Payment already completed');
//           await client.query('COMMIT');
//           return {
//             alreadyPaid: true,
//             payment: existingPayment,
//             message: 'You have already paid for this election'
//           };
//         }

//         // If pending or failed, reuse it
//         if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//           console.log('♻️ Reusing existing payment record');
          
//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
//              WHERE id = $1`,
//             [existingPayment.id]
//           );

//           // ✅ Create payment based on gateway
//           let paymentResponse;
//           if (gateway === 'paddle') {
//             paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment',
//               email: userEmail
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET gateway_transaction_id = $1, gateway_used = 'paddle'
//                WHERE id = $2`,
//               [paymentResponse.orderId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               checkoutUrl: paymentResponse.checkoutUrl,
//               orderId: paymentResponse.orderId,
//               gateway: 'paddle'
//             };
//           } else {
//             paymentResponse = await this.createStripePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment'
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET payment_intent_id = $1 
//                WHERE id = $2`,
//               [paymentResponse.paymentIntentId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               clientSecret: paymentResponse.clientSecret,
//               paymentIntentId: paymentResponse.paymentIntentId,
//               gateway: 'stripe'
//             };
//           }
//         }
//       }

//       // ✅ Create new payment based on gateway
//       console.log('🆕 Creating new payment record');

//       let paymentResponse;
//       let paymentResult;

//       if (gateway === 'paddle') {
//         paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment',
//           email: userEmail
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, gateway_transaction_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.orderId, 
//             'paddle', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           checkoutUrl: paymentResponse.checkoutUrl,
//           orderId: paymentResponse.orderId,
//           gateway: 'paddle'
//         };
//       } else {
//         paymentResponse = await this.createStripePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment'
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.paymentIntentId, 
//             'stripe', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           clientSecret: paymentResponse.clientSecret,
//           paymentIntentId: paymentResponse.paymentIntentId,
//           gateway: 'stripe'
//         };
//       }

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Process election payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }





//   // ✅ FIXED: Confirm payment with proper fee calculation and detailed breakdown
//   async confirmPaymentAndBlock(paymentIntentId, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

//       // Get payment record (works for both payment_intent_id and gateway_transaction_id)
//       const paymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE payment_intent_id = $1 OR gateway_transaction_id = $1`,
//         [paymentIntentId]
//       );

//       if (paymentResult.rows.length === 0) {
//         throw new Error('Payment not found');
//       }

//       const payment = paymentResult.rows[0];

//       // Already succeeded? Skip
//       if (payment.status === 'succeeded') {
//         console.log('⚠️ Payment already confirmed');
//         await client.query('ROLLBACK');
//         return { success: true, alreadyProcessed: true };
//       }

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const election = electionResult.rows[0];
//       const creatorId = election.creator_id;
      
//       // ✅ Handle invalid or missing end_date/end_time
//       let lockedUntil;
//       if (election.end_date) {
//         lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);
//         if (isNaN(lockedUntil.getTime())) {
//           lockedUntil = new Date();
//           lockedUntil.setDate(lockedUntil.getDate() + 30);
//         }
//       } else {
//         lockedUntil = new Date();
//         lockedUntil.setDate(lockedUntil.getDate() + 30);
//       }

//       console.log('👤 Creator ID:', creatorId);
//       console.log('🔒 Locked until:', lockedUntil);

//       // ✅ GET CREATOR'S PLATFORM FEE (or use 5% default)
//       const processingFeeConfig = await this.getUserProcessingFee(creatorId);
      
//       // ✅ Calculate fees based on gateway
//       let gatewayFee, platformFee, netAmount;
      
//       if (payment.gateway_used === 'paddle') {
//         // Paddle: 5% + $0.50
//         gatewayFee = (payment.amount * 0.05) + 0.50;
//         platformFee = this.calculateProcessingFee(payment.amount, processingFeeConfig);
//         netAmount = payment.amount - gatewayFee - platformFee;

//         console.log('\n💰 PAYMENT BREAKDOWN (Paddle):');
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//         console.log(`Voter Paid:           $${payment.amount.toFixed(2)}`);
//         console.log(`- Paddle Fee (5%+$0.50): -$${gatewayFee.toFixed(2)}`);
//         console.log(`- Platform Fee (${processingFeeConfig.percentage}%):    -$${platformFee.toFixed(2)}`);
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//         console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
//         console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

//         await client.query(
//           `UPDATE votteryy_election_payments
//            SET status = 'succeeded', 
//                paddle_fee = $1,
//                platform_fee = $2,
//                net_amount = $3,
//                updated_at = CURRENT_TIMESTAMP
//            WHERE id = $4`,
//           [gatewayFee, platformFee, netAmount, payment.id]
//         );
//       } else {
//         // Stripe: 2.9% + $0.30
//         gatewayFee = (payment.amount * 0.029) + 0.30;
//         platformFee = this.calculateProcessingFee(payment.amount, processingFeeConfig);
//         netAmount = payment.amount - gatewayFee - platformFee;

//         console.log('\n💰 PAYMENT BREAKDOWN (Stripe):');
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//         console.log(`Voter Paid:           $${payment.amount.toFixed(2)}`);
//         console.log(`- Stripe Fee (2.9%+$0.30): -$${gatewayFee.toFixed(2)}`);
//         console.log(`- Platform Fee (${processingFeeConfig.percentage}%):    -$${platformFee.toFixed(2)}`);
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//         console.log(`Creator Receives:     $${netAmount.toFixed(2)} (FROZEN)`);
//         console.log(`Locked Until:         ${lockedUntil.toLocaleString()}`);
//         console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

//         await client.query(
//           `UPDATE votteryy_election_payments
//            SET status = 'succeeded', 
//                stripe_fee = $1,
//                platform_fee = $2,
//                net_amount = $3,
//                updated_at = CURRENT_TIMESTAMP
//            WHERE payment_intent_id = $4`,
//           [gatewayFee, platformFee, netAmount, paymentIntentId]
//         );
//       }

//       // ✅ Ensure creator has a wallet
//       await client.query(
//         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, 0, 0, 'USD')
//          ON CONFLICT (user_id) DO NOTHING`,
//         [creatorId]
//       );

//       // ✅ Add to creator's BLOCKED balance (NOT available - frozen until election ends)
//       await client.query(
//         `UPDATE votteryy_wallets
//          SET blocked_balance = blocked_balance + $1,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [netAmount, creatorId]
//       );

//       console.log(`🔒 FROZEN: $${netAmount.toFixed(2)} added to creator's blocked balance`);
//       console.log(`📅 Will be released when election ends: ${lockedUntil.toLocaleString()}\n`);

//       // ✅ Create blocked account record
//       if (payment.gateway_used === 'paddle') {
//         await client.query(
//           `INSERT INTO votteryy_blocked_accounts
//            (user_id, election_id, amount, paddle_fee, platform_fee, status, locked_until)
//            VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//            ON CONFLICT (user_id, election_id) 
//            DO UPDATE SET 
//              amount = votteryy_blocked_accounts.amount + $3,
//              paddle_fee = COALESCE(votteryy_blocked_accounts.paddle_fee, 0) + $4,
//              platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//           [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//         );
//       } else {
//         await client.query(
//           `INSERT INTO votteryy_blocked_accounts
//            (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
//            VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//            ON CONFLICT (user_id, election_id) 
//            DO UPDATE SET 
//              amount = votteryy_blocked_accounts.amount + $3,
//              stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
//              platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//           [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//         );
//       }

//       // ✅ Record transaction for CREATOR with detailed description
//       const creatorDescription = payment.gateway_used === 'paddle'
//         ? `Revenue from Election #${electionId} | Voter paid $${payment.amount.toFixed(2)} | Paddle fee: $${gatewayFee.toFixed(2)} | Platform fee: $${platformFee.toFixed(2)} | Your earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`
//         : `Revenue from Election #${electionId} | Voter paid $${payment.amount.toFixed(2)} | Stripe fee: $${gatewayFee.toFixed(2)} | Platform fee: $${platformFee.toFixed(2)} | Your earnings: $${netAmount.toFixed(2)} (FROZEN until ${lockedUntil.toLocaleDateString()})`;

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, net_amount, ${payment.gateway_used === 'paddle' ? 'paddle_fee' : 'stripe_fee'}, platform_fee, status, description, election_id)
//          VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7)`,
//         [
//           creatorId,
//           payment.amount,
//           netAmount,
//           gatewayFee,
//           platformFee,
//           creatorDescription,
//           electionId
//         ]
//       );

//       // ✅ Record transaction for VOTER
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description, election_id)
//          VALUES ($1, 'election_participation_fee', $2, 'success', $3, $4)`,
//         [
//           payment.user_id,
//           payment.amount,
//           `Paid $${payment.amount.toFixed(2)} to vote in Election #${electionId}`,
//           electionId
//         ]
//       );

//       await client.query('COMMIT');

//       console.log('✅ Payment confirmed successfully!\n');

//       return { 
//         success: true, 
//         payment, 
//         breakdown: {
//           voterPaid: payment.amount,
//           gatewayFee,
//           platformFee,
//           creatorReceives: netAmount,
//           lockedUntil
//         }
//       };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Confirm payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }








  

//   // ✅ FIXED: Default platform fee is 5%
//   async getUserProcessingFee(userId) {
//     try {
//       const result = await pool.query(
//         `SELECT 
//            sp.processing_fee_enabled,
//            sp.processing_fee_mandatory,
//            sp.processing_fee_type,
//            sp.processing_fee_fixed_amount,
//            sp.processing_fee_percentage
//          FROM votteryy_user_subscriptions us
//          JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//          WHERE us.user_id = $1 
//            AND us.status = 'active'
//            AND us.end_date > NOW()
//          ORDER BY us.created_at DESC
//          LIMIT 1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         // ✅ DEFAULT: 5% platform fee for users with NO subscription
//         return {
//           enabled: true,
//           mandatory: true,
//           type: 'percentage',
//           fixedAmount: 0,
//           percentage: 5.0
//         };
//       }

//       const plan = result.rows[0];
//       return {
//         enabled: plan.processing_fee_enabled,
//         mandatory: plan.processing_fee_mandatory,
//         type: plan.processing_fee_type,
//         fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//         percentage: parseFloat(plan.processing_fee_percentage || 0)
//       };
//     } catch (error) {
//       console.error('Get user processing fee error:', error);
//       throw error;
//     }
//   }

//   calculateProcessingFee(amount, feeConfig) {
//     if (!feeConfig.enabled) return 0;
    
//     if (feeConfig.type === 'fixed') {
//       return feeConfig.fixedAmount;
//     } else {
//       return (amount * feeConfig.percentage) / 100;
//     }
//   }

//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async releaseBlockedAccounts(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔓 Releasing blocked accounts for election:', electionId);

//       const blockedResult = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE election_id = $1 AND status = 'locked'`,
//         [electionId]
//       );

//       console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//       for (const blocked of blockedResult.rows) {
//         await client.query(
//           `UPDATE votteryy_wallets
//            SET balance = balance + $1,
//                blocked_balance = blocked_balance - $1
//            WHERE user_id = $2`,
//           [blocked.amount, blocked.user_id]
//         );

//         await client.query(
//           `UPDATE votteryy_blocked_accounts
//            SET status = 'released', released_at = CURRENT_TIMESTAMP
//            WHERE id = $1`,
//           [blocked.id]
//         );

//         await client.query(
//           `INSERT INTO votteryy_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [
//             blocked.user_id, 
//             'election_funds_released', 
//             blocked.amount, 
//             electionId, 
//             'success', 
//             `Election #${electionId} ended - $${blocked.amount.toFixed(2)} released and available for withdrawal`
//           ]
//         );

//         console.log(`✅ Released $${blocked.amount} for user ${blocked.user_id}`);
//       }

//       await client.query('COMMIT');

//       return { success: true, releasedCount: blockedResult.rows.length };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// }

// export default new PaymentService();

//last workable code
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';
// import axios from 'axios';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     if (config.gateway_name === 'both') {
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }


// // createPaddlePayment
// async createPaddlePayment(amount, currency, metadata) {
//   try {
//     console.log('🟣 Creating Paddle payment:', { amount, currency, metadata });

//     // ✅ CORRECT: Use /prices endpoint to create a one-time price, then /transactions
    
//     // Step 1: Create a one-time price
//     const pricePayload = {
//       description: `Election #${metadata.electionId} Participation Fee`,
//       name: 'Election Participation',
//       type: 'standard',
//       billing_cycle: null,
//       trial_period: null,
//       tax_mode: 'account_setting',
//       unit_price: {
//         amount: String(Math.round(amount * 100)),
//         currency_code: currency.toUpperCase()
//       },
//       quantity: {
//         minimum: 1,
//         maximum: 1
//       }
//     };

//     const apiKey = paddleConfig.apiKey.trim();

//     console.log('🟣 Step 1: Creating price...');
    
//     const priceResponse = await axios({
//       method: 'POST',
//       url: `${paddleConfig.baseURL}/prices`,
//       headers: {
//         'Authorization': `Bearer ${apiKey}`,
//         'Content-Type': 'application/json'
//       },
//       data: pricePayload
//     });

//     const priceId = priceResponse.data.data.id;
//     console.log('✅ Price created:', priceId);

//     // Step 2: Create transaction with the price
//     const transactionPayload = {
//       items: [{
//         price_id: priceId,
//         quantity: 1
//       }],
//       customer_email: metadata.email || 'voter@vottery.com',
//       custom_data: {
//         userId: String(metadata.userId),
//         electionId: String(metadata.electionId),
//         creatorId: String(metadata.creatorId),
//         type: metadata.type
//       }
//     };

//     console.log('🟣 Step 2: Creating transaction...');

//     const transactionResponse = await axios({
//       method: 'POST',
//       url: `${paddleConfig.baseURL}/transactions`,
//       headers: {
//         'Authorization': `Bearer ${apiKey}`,
//         'Content-Type': 'application/json'
//       },
//       data: transactionPayload
//     });

//     console.log('✅ Paddle transaction response:', JSON.stringify(transactionResponse.data, null, 2));

//     const transaction = transactionResponse.data.data;
    
//     // Get checkout URL from transaction
//     const checkoutUrl = `https://buy.paddle.com/checkout/${transaction.id}`;

//     return {
//       success: true,
//       checkoutUrl: checkoutUrl,
//       orderId: transaction.id,
//       gateway: 'paddle'
//     };

//   } catch (error) {
//     console.error(' Paddle error:', error.response?.data || error.message);
//     throw new Error(`Paddle payment failed: ${error.response?.data?.error?.detail || error.message}`);
//   }
// }

  

//   // ✅ UPDATED: Process election participation payment with Paddle support
//   async processElectionPayment(userId, electionId, amount, regionCode, gateway = 'stripe', userEmail = null) {
//     const client = await pool.connect();
    
//     try {
//       await client.query('BEGIN');

//       console.log('💳 Processing election payment:', { userId, electionId, amount, gateway });

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const creatorId = electionResult.rows[0].creator_id;
//       console.log('👤 Election creator:', creatorId);

//       // ✅ Check if payment already exists
//       const existingPaymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments 
//          WHERE user_id = $1 AND election_id = $2 
//          ORDER BY created_at DESC 
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       if (existingPaymentResult.rows.length > 0) {
//         const existingPayment = existingPaymentResult.rows[0];
        
//         console.log('📋 Existing payment found:', existingPayment);

//         if (existingPayment.status === 'succeeded') {
//           console.log('✅ Payment already completed');
//           await client.query('COMMIT');
//           return {
//             alreadyPaid: true,
//             payment: existingPayment,
//             message: 'You have already paid for this election'
//           };
//         }

//         // If pending or failed, reuse it
//         if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//           console.log('♻️ Reusing existing payment record');
          
//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
//              WHERE id = $1`,
//             [existingPayment.id]
//           );

//           // ✅ Create payment based on gateway
//           let paymentResponse;
//           if (gateway === 'paddle') {
//             paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment',
//               email: userEmail
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET gateway_transaction_id = $1, gateway_used = 'paddle'
//                WHERE id = $2`,
//               [paymentResponse.orderId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               checkoutUrl: paymentResponse.paymentUrl,
//               orderId: paymentResponse.orderId,
//               gateway: 'paddle'
//             };
//           } else {
//             paymentResponse = await this.createStripePayment(amount, 'USD', {
//               userId,
//               electionId,
//               creatorId,
//               type: 'election_payment'
//             });

//             await client.query(
//               `UPDATE votteryy_election_payments 
//                SET payment_intent_id = $1 
//                WHERE id = $2`,
//               [paymentResponse.paymentIntentId, existingPayment.id]
//             );

//             await client.query('COMMIT');

//             return {
//               payment: existingPayment,
//               clientSecret: paymentResponse.clientSecret,
//               paymentIntentId: paymentResponse.paymentIntentId,
//               gateway: 'stripe'
//             };
//           }
//         }
//       }

//       // ✅ Create new payment based on gateway
//       console.log('🆕 Creating new payment record');

//       let paymentResponse;
//       let paymentResult;

//       if (gateway === 'paddle') {
//         paymentResponse = await this.createPaddlePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment',
//           email: userEmail
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, gateway_transaction_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.orderId, 
//             'paddle', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           checkoutUrl: paymentResponse.paymentUrl,
//           orderId: paymentResponse.orderId,
//           gateway: 'paddle'
//         };
//       } else {
//         paymentResponse = await this.createStripePayment(amount, 'USD', {
//           userId,
//           electionId,
//           creatorId,
//           type: 'election_payment'
//         });

//         paymentResult = await client.query(
//           `INSERT INTO votteryy_election_payments 
//            (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
//            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//            RETURNING *`,
//           [
//             userId, 
//             electionId, 
//             amount, 
//             'USD', 
//             'pending', 
//             paymentResponse.paymentIntentId, 
//             'stripe', 
//             regionCode,
//             JSON.stringify({ creatorId })
//           ]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: paymentResult.rows[0],
//           clientSecret: paymentResponse.clientSecret,
//           paymentIntentId: paymentResponse.paymentIntentId,
//           gateway: 'stripe'
//         };
//       }

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Process election payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // ✅ UPDATED: Confirm payment and credit to CREATOR's blocked wallet (works for both Stripe and Paddle)
//   async confirmPaymentAndBlock(paymentIntentId, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

//       // Get payment record (works for both payment_intent_id and gateway_transaction_id)
//       const paymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE payment_intent_id = $1 OR gateway_transaction_id = $1`,
//         [paymentIntentId]
//       );

//       if (paymentResult.rows.length === 0) {
//         throw new Error('Payment not found');
//       }

//       const payment = paymentResult.rows[0];

//       // Already succeeded? Skip
//       if (payment.status === 'succeeded') {
//         console.log('⚠️ Payment already confirmed');
//         await client.query('ROLLBACK');
//         return { success: true, alreadyProcessed: true };
//       }

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const election = electionResult.rows[0];
//       const creatorId = election.creator_id;
      
//       // ✅ Handle invalid or missing end_date/end_time
//       let lockedUntil;
//       if (election.end_date) {
//         lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);
//         if (isNaN(lockedUntil.getTime())) {
//           lockedUntil = new Date();
//           lockedUntil.setDate(lockedUntil.getDate() + 30);
//         }
//       } else {
//         lockedUntil = new Date();
//         lockedUntil.setDate(lockedUntil.getDate() + 30);
//       }

//       console.log('👤 Creator ID:', creatorId);
//       console.log('🔒 Locked until:', lockedUntil);

//       // ✅ Calculate fees based on gateway
//       let gatewayFee, platformFee, netAmount;
      
//       if (payment.gateway_used === 'paddle') {
//         gatewayFee = (payment.amount * 0.05) + 0.50;
//         platformFee = payment.amount * 0.02;
//         netAmount = payment.amount - gatewayFee - platformFee;

//         console.log('💰 Paddle fee breakdown:', {
//           gross: payment.amount,
//           paddleFee: gatewayFee.toFixed(2),
//           platformFee: platformFee.toFixed(2),
//           net: netAmount.toFixed(2)
//         });

//         await client.query(
//           `UPDATE votteryy_election_payments
//            SET status = 'succeeded', 
//                paddle_fee = $1,
//                platform_fee = $2,
//                net_amount = $3,
//                updated_at = CURRENT_TIMESTAMP
//            WHERE id = $4`,
//           [gatewayFee, platformFee, netAmount, payment.id]
//         );
//       } else {
//         gatewayFee = (payment.amount * 0.029) + 0.30;
//         platformFee = payment.amount * 0.02;
//         netAmount = payment.amount - gatewayFee - platformFee;

//         console.log('💰 Stripe fee breakdown:', {
//           gross: payment.amount,
//           stripeFee: gatewayFee.toFixed(2),
//           platformFee: platformFee.toFixed(2),
//           net: netAmount.toFixed(2)
//         });

//         await client.query(
//           `UPDATE votteryy_election_payments
//            SET status = 'succeeded', 
//                stripe_fee = $1,
//                platform_fee = $2,
//                net_amount = $3,
//                updated_at = CURRENT_TIMESTAMP
//            WHERE payment_intent_id = $4`,
//           [gatewayFee, platformFee, netAmount, paymentIntentId]
//         );
//       }

//       // ✅ Ensure creator has a wallet
//       await client.query(
//         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, 0, 0, 'USD')
//          ON CONFLICT (user_id) DO NOTHING`,
//         [creatorId]
//       );

//       // ✅ Add to creator's BLOCKED balance
//       await client.query(
//         `UPDATE votteryy_wallets
//          SET blocked_balance = blocked_balance + $1,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [netAmount, creatorId]
//       );

//       console.log(`✅ Added $${netAmount.toFixed(2)} to creator's blocked balance`);

//       // ✅ Create blocked account record
//       if (payment.gateway_used === 'paddle') {
//         await client.query(
//           `INSERT INTO votteryy_blocked_accounts
//            (user_id, election_id, amount, paddle_fee, platform_fee, status, locked_until)
//            VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//            ON CONFLICT (user_id, election_id) 
//            DO UPDATE SET 
//              amount = votteryy_blocked_accounts.amount + $3,
//              paddle_fee = COALESCE(votteryy_blocked_accounts.paddle_fee, 0) + $4,
//              platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//           [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//         );
//       } else {
//         await client.query(
//           `INSERT INTO votteryy_blocked_accounts
//            (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
//            VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//            ON CONFLICT (user_id, election_id) 
//            DO UPDATE SET 
//              amount = votteryy_blocked_accounts.amount + $3,
//              stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
//              platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//           [creatorId, electionId, netAmount, gatewayFee, platformFee, lockedUntil]
//         );
//       }

//       // ✅ Record transaction for CREATOR
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, net_amount, ${payment.gateway_used === 'paddle' ? 'paddle_fee' : 'stripe_fee'}, platform_fee, status, description, election_id)
//          VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7)`,
//         [
//           creatorId,
//           payment.amount,
//           netAmount,
//           gatewayFee,
//           platformFee,
//           `Revenue from voter participation in Election #${electionId} (blocked until election ends)`,
//           electionId
//         ]
//       );

//       // ✅ Record transaction for VOTER
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description, election_id)
//          VALUES ($1, 'election_participation_fee', $2, 'success', $3, $4)`,
//         [
//           payment.user_id,
//           payment.amount,
//           `Paid to vote in Election #${electionId}`,
//           electionId
//         ]
//       );

//       await client.query('COMMIT');

//       console.log('✅ Payment confirmed and credited to creator\'s blocked wallet');

//       return { success: true, payment, netAmount, creatorId };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Confirm payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // [REST OF THE CODE - UNCHANGED]
//   async getUserProcessingFee(userId) {
//     try {
//       const result = await pool.query(
//         `SELECT 
//            sp.processing_fee_enabled,
//            sp.processing_fee_mandatory,
//            sp.processing_fee_type,
//            sp.processing_fee_fixed_amount,
//            sp.processing_fee_percentage
//          FROM votteryy_user_subscriptions us
//          JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//          WHERE us.user_id = $1 
//            AND us.status = 'active'
//            AND us.end_date > NOW()
//          ORDER BY us.created_at DESC
//          LIMIT 1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         return {
//           enabled: true,
//           mandatory: true,
//           type: 'percentage',
//           fixedAmount: 0,
//           percentage: 5.0
//         };
//       }

//       const plan = result.rows[0];
//       return {
//         enabled: plan.processing_fee_enabled,
//         mandatory: plan.processing_fee_mandatory,
//         type: plan.processing_fee_type,
//         fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//         percentage: parseFloat(plan.processing_fee_percentage || 0)
//       };
//     } catch (error) {
//       console.error('Get user processing fee error:', error);
//       throw error;
//     }
//   }

//   calculateProcessingFee(amount, feeConfig) {
//     if (!feeConfig.enabled) return 0;
    
//     if (feeConfig.type === 'fixed') {
//       return feeConfig.fixedAmount;
//     } else {
//       return (amount * feeConfig.percentage) / 100;
//     }
//   }

//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   async releaseBlockedAccounts(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔓 Releasing blocked accounts for election:', electionId);

//       const blockedResult = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE election_id = $1 AND status = 'locked'`,
//         [electionId]
//       );

//       console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//       for (const blocked of blockedResult.rows) {
//         await client.query(
//           `UPDATE votteryy_wallets
//            SET balance = balance + $1,
//                blocked_balance = blocked_balance - $1
//            WHERE user_id = $2`,
//           [blocked.amount, blocked.user_id]
//         );

//         await client.query(
//           `UPDATE votteryy_blocked_accounts
//            SET status = 'released', released_at = CURRENT_TIMESTAMP
//            WHERE id = $1`,
//           [blocked.id]
//         );

//         await client.query(
//           `INSERT INTO votteryy_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [
//             blocked.user_id, 
//             'election_funds_released', 
//             blocked.amount, 
//             electionId, 
//             'success', 
//             `Election #${electionId} ended - funds released and available for withdrawal`
//           ]
//         );

//         console.log(`✅ Released $${blocked.amount} for user ${blocked.user_id}`);
//       }

//       await client.query('COMMIT');

//       return { success: true, releasedCount: blockedResult.rows.length };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// }

// export default new PaymentService();
//last successful workable code for stripe
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     if (config.gateway_name === 'both') {
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }

//   // Create Paddle payment
//   async createPaddlePayment(amount, currency, metadata) {
//     try {
//       const response = await paddleClient.post('/product/generate_pay_link', {
//         vendor_id: paddleConfig.vendorId,
//         vendor_auth_code: paddleConfig.apiKey,
//         prices: [`${currency}:${amount}`],
//         customer_email: metadata.email,
//         passthrough: JSON.stringify(metadata)
//       });

//       return {
//         success: true,
//         paymentUrl: response.data.response.url,
//         gateway: 'paddle'
//       };
//     } catch (error) {
//       throw new Error(`Paddle payment failed: ${error.message}`);
//     }
//   }

//   // ✅ NEW: Process election participation payment (CORRECT FLOW)
//   async processElectionPayment(userId, electionId, amount, regionCode) {
//     const client = await pool.connect();
    
//     try {
//       await client.query('BEGIN');

//       console.log('💳 Processing election payment:', { userId, electionId, amount });

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const creatorId = electionResult.rows[0].creator_id;
//       console.log('👤 Election creator:', creatorId);

//       // ✅ Check if payment already exists
//       const existingPaymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments 
//          WHERE user_id = $1 AND election_id = $2 
//          ORDER BY created_at DESC 
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       if (existingPaymentResult.rows.length > 0) {
//         const existingPayment = existingPaymentResult.rows[0];
        
//         console.log('📋 Existing payment found:', existingPayment);

//         if (existingPayment.status === 'succeeded') {
//           console.log('✅ Payment already completed');
//           await client.query('COMMIT');
//           return {
//             alreadyPaid: true,
//             payment: existingPayment,
//             message: 'You have already paid for this election'
//           };
//         }

//         // If pending or failed, reuse it
//         if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//           console.log('♻️ Reusing existing payment record');
          
//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
//              WHERE id = $1`,
//             [existingPayment.id]
//           );

//           const paymentIntent = await this.createStripePayment(amount, 'USD', {
//             userId,
//             electionId,
//             creatorId,
//             type: 'election_payment'
//           });

//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET payment_intent_id = $1 
//              WHERE id = $2`,
//             [paymentIntent.paymentIntentId, existingPayment.id]
//           );

//           await client.query('COMMIT');

//           return {
//             payment: existingPayment,
//             clientSecret: paymentIntent.clientSecret,
//             paymentIntentId: paymentIntent.paymentIntentId,
//             gateway: 'stripe'
//           };
//         }
//       }

//       // ✅ Create new payment
//       console.log('🆕 Creating new payment record');

//       const paymentIntent = await this.createStripePayment(amount, 'USD', {
//         userId,
//         electionId,
//         creatorId,
//         type: 'election_payment'
//       });

//       const paymentResult = await client.query(
//         `INSERT INTO votteryy_election_payments 
//          (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//          RETURNING *`,
//         [
//           userId, 
//           electionId, 
//           amount, 
//           'USD', 
//           'pending', 
//           paymentIntent.paymentIntentId, 
//           'stripe', 
//           regionCode,
//           JSON.stringify({ creatorId })
//         ]
//       );

//       await client.query('COMMIT');

//       return {
//         payment: paymentResult.rows[0],
//         clientSecret: paymentIntent.clientSecret,
//         paymentIntentId: paymentIntent.paymentIntentId,
//         gateway: 'stripe'
//       };

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Process election payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // ✅ NEW: Confirm payment and credit to CREATOR's blocked wallet
//   async confirmPaymentAndBlock(paymentIntentId, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

//       // Get payment record
//       const paymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE payment_intent_id = $1`,
//         [paymentIntentId]
//       );

//       if (paymentResult.rows.length === 0) {
//         throw new Error('Payment not found');
//       }

//       const payment = paymentResult.rows[0];

//       // Already succeeded? Skip
//       if (payment.status === 'succeeded') {
//         console.log('⚠️ Payment already confirmed');
//         await client.query('ROLLBACK');
//         return { success: true, alreadyProcessed: true };
//       }

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const election = electionResult.rows[0];
//       const creatorId = election.creator_id;
      
//       // ✅ Handle invalid or missing end_date/end_time
//       let lockedUntil;
//       if (election.end_date) {
//         lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);
//         // If date is invalid, default to 30 days from now
//         if (isNaN(lockedUntil.getTime())) {
//           lockedUntil = new Date();
//           lockedUntil.setDate(lockedUntil.getDate() + 30);
//         }
//       } else {
//         // No end date set, default to 30 days from now
//         lockedUntil = new Date();
//         lockedUntil.setDate(lockedUntil.getDate() + 30);
//       }

//       console.log('👤 Creator ID:', creatorId);
//       console.log('🔒 Locked until:', lockedUntil);

//       // ✅ Calculate fees
//       const stripeFee = (payment.amount * 0.029) + 0.30;
//       const platformFee = payment.amount * 0.02; // 2% platform fee
//       const netAmount = payment.amount - stripeFee - platformFee;

//       console.log('💰 Fee breakdown:', {
//         gross: payment.amount,
//         stripeFee: stripeFee.toFixed(2),
//         platformFee: platformFee.toFixed(2),
//         net: netAmount.toFixed(2)
//       });

//       // ✅ Update payment status with fees
//       await client.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'succeeded', 
//              stripe_fee = $1,
//              platform_fee = $2,
//              net_amount = $3,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE payment_intent_id = $4`,
//         [stripeFee, platformFee, netAmount, paymentIntentId]
//       );

//       // ✅ Ensure creator has a wallet
//       await client.query(
//         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, 0, 0, 'USD')
//          ON CONFLICT (user_id) DO NOTHING`,
//         [creatorId]
//       );

//       // ✅ Add to creator's BLOCKED balance
//       await client.query(
//         `UPDATE votteryy_wallets
//          SET blocked_balance = blocked_balance + $1,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [netAmount, creatorId]
//       );

//       console.log(`✅ Added $${netAmount.toFixed(2)} to creator's blocked balance`);

//       // ✅ Create blocked account record
//       await client.query(
//         `INSERT INTO votteryy_blocked_accounts
//          (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
//          VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//          ON CONFLICT (user_id, election_id) 
//          DO UPDATE SET 
//            amount = votteryy_blocked_accounts.amount + $3,
//            stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
//            platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//         [creatorId, electionId, netAmount, stripeFee, platformFee, lockedUntil]
//       );

//       // ✅ Record transaction for CREATOR (revenue)
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, net_amount, stripe_fee, platform_fee, status, description, election_id)
//          VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7)`,
//         [
//           creatorId,
//           payment.amount,
//           netAmount,
//           stripeFee,
//           platformFee,
//           `Revenue from voter participation in Election #${electionId} (blocked until election ends)`,
//           electionId
//         ]
//       );

//       // ✅ Record transaction for VOTER (just a receipt)
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description, election_id)
//          VALUES ($1, 'election_participation_fee', $2, 'success', $3, $4)`,
//         [
//           payment.user_id,
//           payment.amount,
//           `Paid to vote in Election #${electionId}`,
//           electionId
//         ]
//       );

//       await client.query('COMMIT');

//       console.log('✅ Payment confirmed and credited to creator\'s blocked wallet');

//       return { success: true, payment, netAmount, creatorId };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Confirm payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Get processing fee from subscription
//   async getUserProcessingFee(userId) {
//     try {
//       const result = await pool.query(
//         `SELECT 
//            sp.processing_fee_enabled,
//            sp.processing_fee_mandatory,
//            sp.processing_fee_type,
//            sp.processing_fee_fixed_amount,
//            sp.processing_fee_percentage
//          FROM votteryy_user_subscriptions us
//          JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//          WHERE us.user_id = $1 
//            AND us.status = 'active'
//            AND us.end_date > NOW()
//          ORDER BY us.created_at DESC
//          LIMIT 1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         return {
//           enabled: true,
//           mandatory: true,
//           type: 'percentage',
//           fixedAmount: 0,
//           percentage: 5.0
//         };
//       }

//       const plan = result.rows[0];
//       return {
//         enabled: plan.processing_fee_enabled,
//         mandatory: plan.processing_fee_mandatory,
//         type: plan.processing_fee_type,
//         fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//         percentage: parseFloat(plan.processing_fee_percentage || 0)
//       };
//     } catch (error) {
//       console.error('Get user processing fee error:', error);
//       throw error;
//     }
//   }

//   // Calculate processing fee
//   calculateProcessingFee(amount, feeConfig) {
//     if (!feeConfig.enabled) return 0;
    
//     if (feeConfig.type === 'fixed') {
//       return feeConfig.fixedAmount;
//     } else {
//       return (amount * feeConfig.percentage) / 100;
//     }
//   }

//   // Process withdrawal
//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Execute withdrawal
//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // ✅ Release blocked accounts after election ends
//   async releaseBlockedAccounts(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔓 Releasing blocked accounts for election:', electionId);

//       const blockedResult = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE election_id = $1 AND status = 'locked'`,
//         [electionId]
//       );

//       console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//       for (const blocked of blockedResult.rows) {
//         // Move from blocked to available balance
//         await client.query(
//           `UPDATE votteryy_wallets
//            SET balance = balance + $1,
//                blocked_balance = blocked_balance - $1
//            WHERE user_id = $2`,
//           [blocked.amount, blocked.user_id]
//         );

//         // Update blocked account status
//         await client.query(
//           `UPDATE votteryy_blocked_accounts
//            SET status = 'released', released_at = CURRENT_TIMESTAMP
//            WHERE id = $1`,
//           [blocked.id]
//         );

//         // Record transaction
//         await client.query(
//           `INSERT INTO votteryy_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [
//             blocked.user_id, 
//             'election_funds_released', 
//             blocked.amount, 
//             electionId, 
//             'success', 
//             `Election #${electionId} ended - funds released and available for withdrawal`
//           ]
//         );

//         console.log(`✅ Released $${blocked.amount} for user ${blocked.user_id}`);
//       }

//       await client.query('COMMIT');

//       return { success: true, releasedCount: blockedResult.rows.length };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// }

// export default new PaymentService();
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     if (config.gateway_name === 'both') {
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }

//   // Create Paddle payment
//   async createPaddlePayment(amount, currency, metadata) {
//     try {
//       const response = await paddleClient.post('/product/generate_pay_link', {
//         vendor_id: paddleConfig.vendorId,
//         vendor_auth_code: paddleConfig.apiKey,
//         prices: [`${currency}:${amount}`],
//         customer_email: metadata.email,
//         passthrough: JSON.stringify(metadata)
//       });

//       return {
//         success: true,
//         paymentUrl: response.data.response.url,
//         gateway: 'paddle'
//       };
//     } catch (error) {
//       throw new Error(`Paddle payment failed: ${error.message}`);
//     }
//   }

//   // ✅ NEW: Process election participation payment (CORRECT FLOW)
//   async processElectionPayment(userId, electionId, amount, regionCode) {
//     const client = await pool.connect();
    
//     try {
//       await client.query('BEGIN');

//       console.log('💳 Processing election payment:', { userId, electionId, amount });

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const creatorId = electionResult.rows[0].creator_id;
//       console.log('👤 Election creator:', creatorId);

//       // ✅ Check if payment already exists
//       const existingPaymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments 
//          WHERE user_id = $1 AND election_id = $2 
//          ORDER BY created_at DESC 
//          LIMIT 1`,
//         [userId, electionId]
//       );

//       if (existingPaymentResult.rows.length > 0) {
//         const existingPayment = existingPaymentResult.rows[0];
        
//         console.log('📋 Existing payment found:', existingPayment);

//         if (existingPayment.status === 'succeeded') {
//           console.log('✅ Payment already completed');
//           await client.query('COMMIT');
//           return {
//             alreadyPaid: true,
//             payment: existingPayment,
//             message: 'You have already paid for this election'
//           };
//         }

//         // If pending or failed, reuse it
//         if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//           console.log('♻️ Reusing existing payment record');
          
//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET status = 'pending', updated_at = CURRENT_TIMESTAMP 
//              WHERE id = $1`,
//             [existingPayment.id]
//           );

//           const paymentIntent = await this.createStripePayment(amount, 'USD', {
//             userId,
//             electionId,
//             creatorId,
//             type: 'election_payment'
//           });

//           await client.query(
//             `UPDATE votteryy_election_payments 
//              SET payment_intent_id = $1 
//              WHERE id = $2`,
//             [paymentIntent.paymentIntentId, existingPayment.id]
//           );

//           await client.query('COMMIT');

//           return {
//             payment: existingPayment,
//             clientSecret: paymentIntent.clientSecret,
//             paymentIntentId: paymentIntent.paymentIntentId,
//             gateway: 'stripe'
//           };
//         }
//       }

//       // ✅ Create new payment
//       console.log('🆕 Creating new payment record');

//       const paymentIntent = await this.createStripePayment(amount, 'USD', {
//         userId,
//         electionId,
//         creatorId,
//         type: 'election_payment'
//       });

//       const paymentResult = await client.query(
//         `INSERT INTO votteryy_election_payments 
//          (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code, metadata)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
//          RETURNING *`,
//         [
//           userId, 
//           electionId, 
//           amount, 
//           'USD', 
//           'pending', 
//           paymentIntent.paymentIntentId, 
//           'stripe', 
//           regionCode,
//           JSON.stringify({ creatorId })
//         ]
//       );

//       await client.query('COMMIT');

//       return {
//         payment: paymentResult.rows[0],
//         clientSecret: paymentIntent.clientSecret,
//         paymentIntentId: paymentIntent.paymentIntentId,
//         gateway: 'stripe'
//       };

//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Process election payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // ✅ NEW: Confirm payment and credit to CREATOR's blocked wallet
//   async confirmPaymentAndBlock(paymentIntentId, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔔 Confirming payment:', { paymentIntentId, electionId });

//       // Get payment record
//       const paymentResult = await client.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE payment_intent_id = $1`,
//         [paymentIntentId]
//       );

//       if (paymentResult.rows.length === 0) {
//         throw new Error('Payment not found');
//       }

//       const payment = paymentResult.rows[0];

//       // Already succeeded? Skip
//       if (payment.status === 'succeeded') {
//         console.log('⚠️ Payment already confirmed');
//         await client.query('ROLLBACK');
//         return { success: true, alreadyProcessed: true };
//       }

//       // ✅ Get election creator
//       const electionResult = await client.query(
//         `SELECT creator_id, end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       if (electionResult.rows.length === 0) {
//         throw new Error('Election not found');
//       }

//       const election = electionResult.rows[0];
//       const creatorId = election.creator_id;
//       const lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//       console.log('👤 Creator ID:', creatorId);

//       // ✅ Calculate fees
//       const stripeFee = (payment.amount * 0.029) + 0.30;
//       const platformFee = payment.amount * 0.02; // 2% platform fee
//       const netAmount = payment.amount - stripeFee - platformFee;

//       console.log('💰 Fee breakdown:', {
//         gross: payment.amount,
//         stripeFee: stripeFee.toFixed(2),
//         platformFee: platformFee.toFixed(2),
//         net: netAmount.toFixed(2)
//       });

//       // ✅ Update payment status with fees
//       await client.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'succeeded', 
//              stripe_fee = $1,
//              platform_fee = $2,
//              net_amount = $3,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE payment_intent_id = $4`,
//         [stripeFee, platformFee, netAmount, paymentIntentId]
//       );

//       // ✅ Ensure creator has a wallet
//       await client.query(
//         `INSERT INTO votteryy_wallets (user_id, balance, blocked_balance, currency)
//          VALUES ($1, 0, 0, 'USD')
//          ON CONFLICT (user_id) DO NOTHING`,
//         [creatorId]
//       );

//       // ✅ Add to creator's BLOCKED balance
//       await client.query(
//         `UPDATE votteryy_wallets
//          SET blocked_balance = blocked_balance + $1,
//              updated_at = CURRENT_TIMESTAMP
//          WHERE user_id = $2`,
//         [netAmount, creatorId]
//       );

//       console.log(`✅ Added $${netAmount.toFixed(2)} to creator's blocked balance`);

//       // ✅ Create blocked account record
//       await client.query(
//         `INSERT INTO votteryy_blocked_accounts
//          (user_id, election_id, amount, stripe_fee, platform_fee, status, locked_until)
//          VALUES ($1, $2, $3, $4, $5, 'locked', $6)
//          ON CONFLICT (user_id, election_id) 
//          DO UPDATE SET 
//            amount = votteryy_blocked_accounts.amount + $3,
//            stripe_fee = votteryy_blocked_accounts.stripe_fee + $4,
//            platform_fee = votteryy_blocked_accounts.platform_fee + $5`,
//         [creatorId, electionId, netAmount, stripeFee, platformFee, lockedUntil]
//       );

//       // ✅ Record transaction for CREATOR (revenue)
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, net_amount, stripe_fee, platform_fee, status, description, election_id)
//          VALUES ($1, 'election_revenue', $2, $3, $4, $5, 'success', $6, $7)`,
//         [
//           creatorId,
//           payment.amount,
//           netAmount,
//           stripeFee,
//           platformFee,
//           `Revenue from voter participation in Election #${electionId} (blocked until election ends)`,
//           electionId
//         ]
//       );

//       // ✅ Record transaction for VOTER (just a receipt)
//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description, election_id)
//          VALUES ($1, 'election_participation_fee', $2, 'success', $3, $4)`,
//         [
//           payment.user_id,
//           payment.amount,
//           `Paid to vote in Election #${electionId}`,
//           electionId
//         ]
//       );

//       await client.query('COMMIT');

//       console.log('✅ Payment confirmed and credited to creator\'s blocked wallet');

//       return { success: true, payment, netAmount, creatorId };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       console.error('❌ Confirm payment error:', error);
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Get processing fee from subscription
//   async getUserProcessingFee(userId) {
//     try {
//       const result = await pool.query(
//         `SELECT 
//            sp.processing_fee_enabled,
//            sp.processing_fee_mandatory,
//            sp.processing_fee_type,
//            sp.processing_fee_fixed_amount,
//            sp.processing_fee_percentage
//          FROM votteryy_user_subscriptions us
//          JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//          WHERE us.user_id = $1 
//            AND us.status = 'active'
//            AND us.end_date > NOW()
//          ORDER BY us.created_at DESC
//          LIMIT 1`,
//         [userId]
//       );

//       if (result.rows.length === 0) {
//         return {
//           enabled: true,
//           mandatory: true,
//           type: 'percentage',
//           fixedAmount: 0,
//           percentage: 5.0
//         };
//       }

//       const plan = result.rows[0];
//       return {
//         enabled: plan.processing_fee_enabled,
//         mandatory: plan.processing_fee_mandatory,
//         type: plan.processing_fee_type,
//         fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//         percentage: parseFloat(plan.processing_fee_percentage || 0)
//       };
//     } catch (error) {
//       console.error('Get user processing fee error:', error);
//       throw error;
//     }
//   }

//   // Calculate processing fee
//   calculateProcessingFee(amount, feeConfig) {
//     if (!feeConfig.enabled) return 0;
    
//     if (feeConfig.type === 'fixed') {
//       return feeConfig.fixedAmount;
//     } else {
//       return (amount * feeConfig.percentage) / 100;
//     }
//   }

//   // Process withdrawal
//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Execute withdrawal
//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       await client.query(
//         `UPDATE votteryy_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       await client.query(
//         `INSERT INTO votteryy_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // ✅ Release blocked accounts after election ends
//   async releaseBlockedAccounts(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       console.log('🔓 Releasing blocked accounts for election:', electionId);

//       const blockedResult = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE election_id = $1 AND status = 'locked'`,
//         [electionId]
//       );

//       console.log(`📊 Found ${blockedResult.rows.length} blocked accounts to release`);

//       for (const blocked of blockedResult.rows) {
//         // Move from blocked to available balance
//         await client.query(
//           `UPDATE votteryy_wallets
//            SET balance = balance + $1,
//                blocked_balance = blocked_balance - $1
//            WHERE user_id = $2`,
//           [blocked.amount, blocked.user_id]
//         );

//         // Update blocked account status
//         await client.query(
//           `UPDATE votteryy_blocked_accounts
//            SET status = 'released', released_at = CURRENT_TIMESTAMP
//            WHERE id = $1`,
//           [blocked.id]
//         );

//         // Record transaction
//         await client.query(
//           `INSERT INTO votteryy_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [
//             blocked.user_id, 
//             'election_funds_released', 
//             blocked.amount, 
//             electionId, 
//             'success', 
//             `Election #${electionId} ended - funds released and available for withdrawal`
//           ]
//         );

//         console.log(`✅ Released $${blocked.amount} for user ${blocked.user_id}`);
//       }

//       await client.query('COMMIT');

//       return { success: true, releasedCount: blockedResult.rows.length };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// }










// export default new PaymentService();
// import stripe from '../config/stripe.js';
// import paddleClient, { paddleConfig } from '../config/paddle.js';
// import pool from '../config/database.js';

// class PaymentService {

//   // Get payment gateway for region
//   async getGatewayForRegion(regionCode) {
//     // Map region codes to zone numbers
//     const regionMap = {
//       'region_1_us_canada': 1,
//       'region_2_western_europe': 2,
//       'region_3_eastern_europe': 3,
//       'region_4_africa': 4,
//       'region_5_latin_america': 5,
//       'region_6_middle_east_asia': 6,
//       'region_7_australasia': 7,
//       'region_8_china': 8
//     };

//     const regionZone = regionMap[regionCode] || 1;

//     const result = await pool.query(
//       `SELECT * FROM votteryy_payment_gateway_config WHERE region_zone = $1`,
//       [regionZone]
//     );

//     if (result.rows.length === 0) {
//       return { gateway: 'stripe', splitPercentage: 100 };
//     }

//     const config = result.rows[0];

//     // Determine which gateway to use
//     if (config.gateway_name === 'both') {
//       // 50/50 split - randomly choose
//       return Math.random() < 0.5 ? { gateway: 'stripe', splitPercentage: 50 } : { gateway: 'paddle', splitPercentage: 50 };
//     }

//     return { gateway: config.gateway_name, splitPercentage: config.split_percentage };
//   }

//   // Create Stripe payment intent
//   async createStripePayment(amount, currency, metadata) {
//     try {
//       console.log('🔵 Creating Stripe PaymentIntent:', {
//         amount: Math.round(amount * 100),
//         currency: currency.toLowerCase(),
//         metadata
//       });

//       const paymentIntent = await stripe.paymentIntents.create({
//         amount: Math.round(amount * 100), // Convert to cents
//         currency: currency.toLowerCase(),
//         metadata,
//         automatic_payment_methods: { enabled: true }
//       });

//       console.log('✅ Stripe PaymentIntent created:', {
//         id: paymentIntent.id,
//         client_secret: paymentIntent.client_secret ? 'exists' : 'NULL',
//         status: paymentIntent.status
//       });

//       return {
//         success: true,
//         paymentIntentId: paymentIntent.id,
//         clientSecret: paymentIntent.client_secret,
//         gateway: 'stripe'
//       };
//     } catch (error) {
//       console.error('❌ Stripe error:', error.message);
//       throw new Error(`Stripe payment failed: ${error.message}`);
//     }
//   }

//   // Create Paddle payment
//   async createPaddlePayment(amount, currency, metadata) {
//     try {
//       const response = await paddleClient.post('/product/generate_pay_link', {
//         vendor_id: paddleConfig.vendorId,
//         vendor_auth_code: paddleConfig.apiKey,
//         prices: [`${currency}:${amount}`],
//         customer_email: metadata.email,
//         passthrough: JSON.stringify(metadata)
//       });

//       return {
//         success: true,
//         paymentUrl: response.data.response.url,
//         gateway: 'paddle'
//       };
//     } catch (error) {
//       throw new Error(`Paddle payment failed: ${error.message}`);
//     }
//   }

//   // Process election participation payment
// // payment.service.js - processElectionPayment function

// async processElectionPayment(userId, electionId, amount, regionCode) {
//   const client = await pool.connect();
  
//   try {
//     await client.query('BEGIN');

//     // ✅ STEP 1: Check if payment already exists
//     const existingPaymentResult = await client.query(
//       `SELECT * FROM votteryy_election_payments 
//        WHERE user_id = $1 AND election_id = $2 
//        ORDER BY created_at DESC 
//        LIMIT 1`,
//       [userId, electionId]
//     );

//     // ✅ If payment exists and is succeeded, return early
//     if (existingPaymentResult.rows.length > 0) {
//       const existingPayment = existingPaymentResult.rows[0];
      
//       console.log('📋 Existing payment found:', existingPayment);

//       if (existingPayment.status === 'succeeded') {
//         console.log('✅ Payment already completed');
//         await client.query('COMMIT');
//         return {
//           alreadyPaid: true,
//           payment: existingPayment,
//           message: 'You have already paid for this election'
//         };
//       }

//       // ✅ If payment is pending or failed, reuse it
//       if (existingPayment.status === 'pending' || existingPayment.status === 'failed') {
//         console.log('♻️ Reusing existing payment record');
        
//         // Update the payment record
//         await client.query(
//           `UPDATE votteryy_election_payments 
//            SET status = 'pending', 
//                updated_at = CURRENT_TIMESTAMP 
//            WHERE id = $1`,
//           [existingPayment.id]
//         );

//         // Create new Stripe payment intent
//         const paymentIntent = await this.createStripePayment(amount, 'USD', {
//           userId,
//           electionId,
//           type: 'election_payment'
//         });

//         console.log('💳 New PaymentIntent created:', {
//           id: paymentIntent.paymentIntentId,
//           client_secret: 'exists',
//           status: paymentIntent.status
//         });

//         // Update with new payment intent ID
//         await client.query(
//           `UPDATE votteryy_election_payments 
//            SET payment_intent_id = $1 
//            WHERE id = $2`,
//           [paymentIntent.paymentIntentId, existingPayment.id]
//         );

//         await client.query('COMMIT');

//         return {
//           payment: existingPayment,
//           clientSecret: paymentIntent.clientSecret,
//           paymentIntentId: paymentIntent.paymentIntentId,
//           gateway: 'stripe'
//         };
//       }
//     }

//     // ✅ STEP 2: No existing payment found, create new one
//     console.log('🆕 Creating new payment record');

//     const paymentIntent = await this.createStripePayment(amount, 'USD', {
//       userId,
//       electionId,
//       type: 'election_payment'
//     });

//     console.log('💳 PaymentIntent created:', {
//       id: paymentIntent.paymentIntentId,
//       client_secret: 'exists',
//       status: paymentIntent.status
//     });

//     // Insert new payment record
//     const paymentResult = await client.query(
//       `INSERT INTO votteryy_election_payments 
//        (user_id, election_id, amount, currency, status, payment_intent_id, gateway_used, region_code)
//        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
//        RETURNING *`,
//       [userId, electionId, amount, 'USD', 'pending', paymentIntent.paymentIntentId, 'stripe', regionCode]
//     );

//     await client.query('COMMIT');

//     return {
//       payment: paymentResult.rows[0],
//       clientSecret: paymentIntent.clientSecret,
//       paymentIntentId: paymentIntent.paymentIntentId,
//       gateway: 'stripe'
//     };

//   } catch (error) {
//     await client.query('ROLLBACK');
//     console.error('❌ Process election payment error:', error);
//     throw error;
//   } finally {
//     client.release();
//   }
// }

//   // Confirm payment and create blocked account
//   async confirmPaymentAndBlock(paymentIntentId, electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // ✅ Check if payment already confirmed
//       const existingPayment = await client.query(
//         `SELECT * FROM votteryy_election_payments
//          WHERE payment_intent_id = $1`,
//         [paymentIntentId]
//       );

//       if (existingPayment.rows.length === 0) {
//         throw new Error('Payment not found');
//       }

//       const payment = existingPayment.rows[0];

//       // ✅ If already succeeded, don't process again
//       if (payment.status === 'succeeded') {
//         console.log('⚠️ Payment already confirmed:', paymentIntentId);
//         await client.query('ROLLBACK');
//         return { 
//           success: true, 
//           payment: payment,
//           alreadyProcessed: true 
//         };
//       }

//       // Update payment status
//       const paymentResult = await client.query(
//         `UPDATE votteryy_election_payments
//          SET status = 'succeeded', updated_at = CURRENT_TIMESTAMP
//          WHERE payment_intent_id = $1
//          RETURNING *`,
//         [paymentIntentId]
//       );

//       const updatedPayment = paymentResult.rows[0];

//       // Get election end date
//       const electionResult = await client.query(
//         `SELECT end_date, end_time FROM votteryyy_elections WHERE id = $1`,
//         [electionId]
//       );

//       const election = electionResult.rows[0];
//       const lockedUntil = new Date(`${election.end_date} ${election.end_time || '23:59:59'}`);

//       // ✅ Check if blocked account already exists
//       const existingBlocked = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE user_id = $1 AND election_id = $2`,
//         [updatedPayment.user_id, electionId]
//       );

//       if (existingBlocked.rows.length === 0) {
//         // Create blocked account
//         await client.query(
//           `INSERT INTO votteryy_blocked_accounts
//            (user_id, election_id, amount, platform_fee, locked_until)
//            VALUES ($1, $2, $3, $4, $5)`,
//           [updatedPayment.user_id, electionId, updatedPayment.amount - updatedPayment.platform_fee, updatedPayment.platform_fee, lockedUntil]
//         );

//         // Update wallet
//         await client.query(
//           `INSERT INTO votteryy_user_wallets (user_id, blocked_balance)
//            VALUES ($1, $2)
//            ON CONFLICT (user_id) 
//            DO UPDATE SET blocked_balance = votteryy_user_wallets.blocked_balance + $2`,
//           [updatedPayment.user_id, updatedPayment.amount - updatedPayment.platform_fee]
//         );
//       }

//       await client.query('COMMIT');

//       return { success: true, payment: updatedPayment };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Process withdrawal
//   async processWithdrawal(userId, amount, paymentMethod, paymentDetails) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Check wallet balance
//       const walletResult = await client.query(
//         `SELECT balance FROM votteryy_user_wallets WHERE user_id = $1`,
//         [userId]
//       );

//       if (walletResult.rows.length === 0 || walletResult.rows[0].balance < amount) {
//         throw new Error('Insufficient balance');
//       }

//       // Create withdrawal request
//       const withdrawalResult = await client.query(
//         `INSERT INTO votteryy_withdrawal_requests
//          (user_id, amount, payment_method, payment_details, status)
//          VALUES ($1, $2, $3, $4, $5)
//          RETURNING *`,
//         [userId, amount, paymentMethod, JSON.stringify(paymentDetails), amount >= 5000 ? 'pending' : 'approved']
//       );

//       const withdrawal = withdrawalResult.rows[0];

//       // If auto-approved (< threshold), process immediately
//       if (amount < 5000) {
//         await this.executeWithdrawal(withdrawal.request_id, userId);
//       }

//       await client.query('COMMIT');

//       return withdrawal;
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }


//   // payment.service.js - ADD THESE METHODS

// // ✅ Get processing fee from user's active subscription
// async getUserProcessingFee(userId) {
//   try {
//     const result = await pool.query(
//       `SELECT 
//          sp.processing_fee_enabled,
//          sp.processing_fee_mandatory,
//          sp.processing_fee_type,
//          sp.processing_fee_fixed_amount,
//          sp.processing_fee_percentage
//        FROM votteryy_user_subscriptions us
//        JOIN votteryy_subscription_plans sp ON us.plan_id = sp.id
//        WHERE us.user_id = $1 
//          AND us.status = 'active'
//          AND us.end_date > NOW()
//        ORDER BY us.created_at DESC
//        LIMIT 1`,
//       [userId]
//     );

//     if (result.rows.length === 0) {
//       // No subscription - FREE user defaults
//       return {
//         enabled: true,
//         mandatory: true,
//         type: 'percentage',
//         fixedAmount: 0,
//         percentage: 5.0 // Free users pay 5%
//       };
//     }

//     const plan = result.rows[0];
//     return {
//       enabled: plan.processing_fee_enabled,
//       mandatory: plan.processing_fee_mandatory,
//       type: plan.processing_fee_type,
//       fixedAmount: parseFloat(plan.processing_fee_fixed_amount || 0),
//       percentage: parseFloat(plan.processing_fee_percentage || 0)
//     };
//   } catch (error) {
//     console.error('Get user processing fee error:', error);
//     throw error;
//   }
// }

// // ✅ Calculate processing fee
// calculateProcessingFee(amount, feeConfig) {
//   if (!feeConfig.enabled) return 0;
  
//   if (feeConfig.type === 'fixed') {
//     return feeConfig.fixedAmount;
//   } else {
//     return (amount * feeConfig.percentage) / 100;
//   }
// }

//   // Execute withdrawal (called by admin or automatically)
//   async executeWithdrawal(requestId, adminId = null) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Get withdrawal request
//       const requestResult = await client.query(
//         `SELECT * FROM votteryy_withdrawal_requests WHERE request_id = $1`,
//         [requestId]
//       );

//       if (requestResult.rows.length === 0) {
//         throw new Error('Withdrawal request not found');
//       }

//       const request = requestResult.rows[0];

//       if (request.status !== 'approved') {
//         throw new Error('Withdrawal not approved');
//       }

//       // Deduct from wallet
//       await client.query(
//         `UPDATE votteryy_user_wallets
//          SET balance = balance - $1
//          WHERE user_id = $2`,
//         [request.amount, request.user_id]
//       );

//       // Record transaction
//       await client.query(
//         `INSERT INTO votteryy_wallet_transactions
//          (user_id, transaction_type, amount, status, description)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [request.user_id, 'withdraw', request.amount, 'success', 'Withdrawal to ' + request.payment_method]
//       );

//       // Update withdrawal request
//       await client.query(
//         `UPDATE votteryy_withdrawal_requests
//          SET status = 'completed', completed_at = CURRENT_TIMESTAMP, approved_by = $1
//          WHERE request_id = $2`,
//         [adminId, requestId]
//       );

//       await client.query('COMMIT');

//       // TODO: Actually send money via Stripe/Paddle
//       // This would call the payment gateway API to transfer funds

//       return { success: true, message: 'Withdrawal processed successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Release blocked accounts after election ends
//   async releaseBlockedAccounts(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Get all blocked accounts for this election
//       const blockedResult = await client.query(
//         `SELECT * FROM votteryy_blocked_accounts
//          WHERE election_id = $1 AND status = 'locked'`,
//         [electionId]
//       );

//       for (const blocked of blockedResult.rows) {
//         // Move from blocked to available balance
//         await client.query(
//           `UPDATE votteryy_user_wallets
//            SET balance = balance + $1,
//                blocked_balance = blocked_balance - $1
//            WHERE user_id = $2`,
//           [blocked.amount, blocked.user_id]
//         );

//         // Update blocked account status
//         await client.query(
//           `UPDATE votteryy_blocked_accounts
//            SET status = 'released', released_at = CURRENT_TIMESTAMP
//            WHERE id = $1`,
//           [blocked.id]
//         );

//         // Record transaction
//         await client.query(
//           `INSERT INTO votteryy_wallet_transactions
//            (user_id, transaction_type, amount, election_id, status, description)
//            VALUES ($1, $2, $3, $4, $5, $6)`,
//           [blocked.user_id, 'election_refund', blocked.amount, electionId, 'success', 'Election participation fee released']
//         );
//       }

//       await client.query('COMMIT');

//       return { success: true, releasedCount: blockedResult.rows.length };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }
// }

// export default new PaymentService();