import express from 'express';
import verificationController from '../controllers/verification.controller.js';
import roleCheck from '../ middleware/roleCheck.js';
//import roleCheck from '../middleware/roleCheck.js';

const router = express.Router();

// Verify vote by receipt ID (public)
router.get(
  '/verify/receipt/:receiptId',
  verificationController.verifyByReceipt
);

// Verify vote by hash (public)
router.get(
  '/verify/hash/:voteHash',
  verificationController.verifyByHash
);

// Verify encryption (Issue #1)
router.post(
  '/verify/encryption/:electionId',
  roleCheck(['voter']),
  verificationController.verifyEncryption
);

// Get user's verification data
router.get(
  '/verify/my-vote/:electionId',
  roleCheck(['voter']),
  verificationController.getMyVerificationData
);

// Get public bulletin board (public)
router.get(
  '/verify/bulletin-board/:electionId',
  verificationController.getPublicBulletinBoard
);

// Verify audit trail integrity (Issue #3)
router.get(
  '/verify/audit-trail/:electionId/integrity',
  verificationController.verifyAuditTrail
);

// Get audit trail (Issue #3)
router.get(
  '/verify/audit-trail/:electionId',
  verificationController.getAuditTrail
);

// Export audit trail
router.get(
  '/verify/audit-trail/:electionId/export',
  verificationController.exportAuditTrail
);

// Get user's verifications
router.get(
  '/verify/my-verifications',
  roleCheck(['voter']),
  verificationController.getUserVerifications
);

router.get(
  '/verify/:receiptId',
  verificationController.verifyByReceipt
);

export default router;