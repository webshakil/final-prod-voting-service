import express from 'express';
//import roleCheck from '../middleware/roleCheck.js';
//import * as paymentController from '../controllers/paymentController.js';
import roleCheck from '../ middleware/roleCheck.js';
import paymentController from '../controllers/paymentController.js';

const router = express.Router();

// Create payment intent
router.post(
  '/election/:electionId/create-intent',
  paymentController.createPaymentIntent
);

// Stripe webhook (no auth)
router.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  paymentController.stripeWebhook
);

// Verify payment
router.get(
  '/verify/:paymentId',
  paymentController.verifyPayment
);

// ✅ Admin routes for payment config (Manager role only)
router.get(
  '/admin/configs',
  roleCheck(['Manager']),
  paymentController.getPaymentConfigs
);

router.post(
  '/admin/configs',
  roleCheck(['Manager']),
  paymentController.savePaymentConfigs
);

// ✅ Public endpoint for frontend keys
router.get(
  '/public-keys',
  paymentController.getPublicKeys
);

export default router;