// controllers/paymentController.js
import Stripe from 'stripe';
import paymentService from '../services/payment.service.js';
import { getStripeSecretKey } from '../utils/paymentConfigHelper.js';
import {
  emitPaymentInitiated,
  emitPaymentSuccess,
  emitPaymentFailed
} from '../socket/combinedSocket.js';

// ✅ Initialize Stripe dynamically from database
let stripeInstance = null;

async function getStripeInstance() {
  if (!stripeInstance) {
    const secretKey = await getStripeSecretKey();
    stripeInstance = new Stripe(secretKey);
  }
  return stripeInstance;
}

/**
 * Create payment intent for election
 */
export const createPaymentIntent = async (req, res) => {
  try {
    const { electionId } = req.params;
    const { amount, currency, region, processingFee, frozenAmount } = req.body;
    
    // Get user from x-user-data header
    let userId = null;
    let userEmail = null;
    
    try {
      const userDataHeader = req.headers['x-user-data'];
      if (userDataHeader) {
        const userData = JSON.parse(userDataHeader);
        userId = userData.userId;
        userEmail = userData.email;
        console.log('👤 User from header:', { userId, userEmail });
      }
    } catch (err) {
      console.error('Error parsing x-user-data:', err);
    }
    
    if (!userId) {
      console.warn('⚠️ No user data found, using test user');
      userId = 5;
      userEmail = 'ar.abhi@gmail.com';
    }

    console.log('Creating payment intent:', {
      electionId,
      amount,
      currency,
      userId,
      region
    });

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Missing required fields: amount, currency' });
    }

    const amountInCents = Math.round(amount * 100);

    // ✅ Get Stripe instance from database
    const stripe = await getStripeInstance();

    // ✅ EMIT: Payment Initiated
    setImmediate(() => {
      try {
        emitPaymentInitiated(userId, {
          paymentId: `pending-${Date.now()}`,
          amount: amount,
          electionId: electionId,
          electionTitle: 'Election',
          gateway: 'stripe'
        });
      } catch (notifError) {
        console.error('⚠️ Failed to emit payment initiated:', notifError.message);
      }
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: currency.toLowerCase(),
      metadata: {
        electionId: electionId.toString(),
        userId: userId.toString(),
        email: userEmail,
        region: region || 'unknown',
        processingFee: (processingFee || 0).toString(),
        frozenAmount: (frozenAmount || 0).toString(),
        type: 'election_voting'
      },
      description: `Vote payment for Election #${electionId}`,
      automatic_payment_methods: {
        enabled: true,
      },
    });

    console.log('✅ Payment intent created:', paymentIntent.id);

    return res.status(201).json({
      success: true,
      message: 'Payment intent created',
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        gateway: 'stripe',
        amount,
        currency
      }
    });

  } catch (error) {
    console.error('❌ Create payment intent error:', error);
    
    // ✅ EMIT: Payment Failed
    setImmediate(() => {
      try {
        const userDataHeader = req.headers['x-user-data'];
        if (userDataHeader) {
          const userData = JSON.parse(userDataHeader);
          emitPaymentFailed(userData.userId, {
            paymentId: 'failed',
            amount: 0,
            electionId: req.params.electionId,
            electionTitle: 'Unknown',
            error: error.message
          });
        }
      } catch (notifError) {
        console.error('⚠️ Failed to emit payment failed:', notifError.message);
      }
    });
    
    return res.status(500).json({ error: error.message });
  }
};

/**
 * Stripe webhook handler - Confirms payment and BLOCKS funds until election ends
 */
export const stripeWebhook = async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    
    // Get webhook secret from database
    const { getConfigFromDB } = await import('../utils/paymentConfigHelper.js');
    const webhookSecret = await getConfigFromDB('stripe_webhook_secret');
    
    if (!webhookSecret) {
      console.error('❌ No webhook secret configured');
      return res.status(400).json({ error: 'Webhook secret not configured' });
    }

    const stripe = await getStripeInstance();
    const event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);

    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        console.log('✅ Payment succeeded:', paymentIntent.id);
        
        try {
          const { electionId, userId } = paymentIntent.metadata;

          // ✅ Confirm payment AND block funds (freezes until election ends)
          await paymentService.confirmPaymentAndBlock(
            paymentIntent.id,
            parseInt(electionId)
          );

          // ✅ EMIT: Payment Success
          setImmediate(() => {
            try {
              emitPaymentSuccess(parseInt(userId), {
                paymentId: paymentIntent.id,
                amount: paymentIntent.amount / 100,
                electionId: parseInt(electionId),
                electionTitle: 'Election',
                gateway: 'stripe'
              });
            } catch (notifError) {
              console.error('⚠️ Failed to emit payment success:', notifError.message);
            }
          });

          console.log('💰 Payment confirmed and funds BLOCKED until election ends');
        } catch (err) {
          console.error('Error confirming payment:', err);
        }
        break;

      case 'payment_intent.payment_failed':
        const failedPayment = event.data.object;
        console.log('❌ Payment failed:', failedPayment.id);
        
        // ✅ EMIT: Payment Failed
        setImmediate(() => {
          try {
            const { userId, electionId } = failedPayment.metadata;
            if (userId) {
              emitPaymentFailed(parseInt(userId), {
                paymentId: failedPayment.id,
                amount: failedPayment.amount / 100,
                electionId: parseInt(electionId),
                electionTitle: 'Election',
                error: 'Payment failed'
              });
            }
          } catch (notifError) {
            console.error('⚠️ Failed to emit payment failed:', notifError.message);
          }
        });
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(400).json({ error: error.message });
  }
};

/**
 * Verify payment status
 */
export const verifyPayment = async (req, res) => {
  try {
    const { paymentId } = req.params;
    
    let userId = null;
    try {
      const userDataHeader = req.headers['x-user-data'];
      if (userDataHeader) {
        const userData = JSON.parse(userDataHeader);
        userId = userData.userId;
      }
    } catch (err) {
      console.error('Error parsing x-user-data:', err);
    }

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // ✅ Get Stripe instance from database
    const stripe = await getStripeInstance();
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentId);

    return res.json({
      success: true,
      data: {
        status: paymentIntent.status,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency,
        metadata: paymentIntent.metadata
      }
    });

  } catch (error) {
    console.error('Verify payment error:', error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * ✅ NEW: Get payment configs for admin
 */
export const getPaymentConfigs = async (req, res) => {
  try {
    const { getAllPaymentConfigs } = await import('../utils/paymentConfigHelper.js');
    const configs = await getAllPaymentConfigs();
    
    return res.json({
      success: true,
      message: 'Payment configs retrieved',
      data: configs
    });
  } catch (error) {
    console.error('❌ Get payment configs error:', error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * ✅ NEW: Save payment configs (admin only)
 */
export const savePaymentConfigs = async (req, res) => {
  try {
    const { saveAllPaymentConfigs } = await import('../utils/paymentConfigHelper.js');
    await saveAllPaymentConfigs(req.body);
    
    // Reset Stripe instance to use new keys
    stripeInstance = null;
    
    return res.status(201).json({
      success: true,
      message: 'Payment configs saved successfully'
    });
  } catch (error) {
    console.error('❌ Save payment configs error:', error);
    return res.status(500).json({ error: error.message });
  }
};

/**
 * ✅ NEW: Get public keys for frontend
 */
export const getPublicKeys = async (req, res) => {
  try {
    const { getPublicPaymentKeys } = await import('../utils/paymentConfigHelper.js');
    const publicKeys = await getPublicPaymentKeys();
    
    return res.json({
      success: true,
      message: 'Public keys retrieved',
      data: publicKeys
    });
  } catch (error) {
    console.error('❌ Get public keys error:', error);
    return res.status(500).json({ error: error.message });
  }
};

export default {
  createPaymentIntent,
  stripeWebhook,
  verifyPayment,
  getPaymentConfigs,
  savePaymentConfigs,
  getPublicKeys
};