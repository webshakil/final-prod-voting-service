import express from 'express';
import walletController from '../controllers/wallet.controller.js';
import roleCheck from '../ middleware/roleCheck.js';

const router = express.Router();

// ✅ REMOVE /wallet/ prefix - it's already in app.use('/api/wallet')

// Get user wallet
router.get(
  '/',
  roleCheck(['voter']),
  walletController.getWallet
);

// Get wallet transactions
router.get(
  '/transactions',
  roleCheck(['voter']),
  walletController.getTransactions
);

// Get blocked accounts
router.get(
  '/blocked-accounts',
  roleCheck(['voter']),
  walletController.getBlockedAccounts
);

// Get wallet analytics
router.get(
  '/analytics',
  roleCheck(['voter']),
  walletController.getWalletAnalytics
);

// Deposit funds
router.post(
  '/deposit',
  roleCheck(['voter']),
  walletController.deposit
);

// Confirm deposit (webhook)
router.post(
  '/deposit/confirm',
  walletController.confirmDeposit
);

// Request withdrawal
router.post(
  '/withdraw',
  roleCheck(['voter']),
  walletController.requestWithdrawal
);

// Get withdrawal requests
router.get(
  '/withdrawals',
  roleCheck(['voter']),
  walletController.getWithdrawalRequests
);

// Admin: Get pending withdrawals
router.get(
  '/admin/withdrawals/pending',
  roleCheck(['admin', 'manager']),
  walletController.getPendingWithdrawals
);

// Admin: Review withdrawal
router.put(
  '/admin/withdrawals/:requestId/review',
  roleCheck(['admin', 'manager']),
  walletController.reviewWithdrawal
);

// Pay for election participation
router.post(
  '/pay-election',
  roleCheck(['voter']),
  walletController.payForElection
);

// Confirm election payment (webhook)
router.post(
  '/election-payment/confirm',
  walletController.confirmElectionPayment
);

// Check if user paid for election
router.get(
  '/election-payment/status/:electionId',
  roleCheck(['voter']),
  walletController.checkElectionPaymentStatus
);

// Check if user can vote (before payment)
router.get(
  '/can-vote/:electionId',
  roleCheck(['voter']),
  walletController.canUserVote
);

export default router;
// import express from 'express';
// import walletController from '../controllers/wallet.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// //import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // Get user wallet
// router.get(
//   '/wallet',
//   roleCheck(['voter']),
//   walletController.getWallet
// );

// // Get wallet transactions
// router.get(
//   '/wallet/transactions',
//   roleCheck(['voter']),
//   walletController.getTransactions
// );

// // Get blocked accounts
// router.get(
//   '/wallet/blocked-accounts',
//   roleCheck(['voter']),
//   walletController.getBlockedAccounts
// );

// // Get wallet analytics
// router.get(
//   '/wallet/analytics',
//   roleCheck(['voter']),
//   walletController.getWalletAnalytics
// );

// // Deposit funds
// router.post(
//   '/wallet/deposit',
//   roleCheck(['voter']),
//   walletController.deposit
// );

// // Confirm deposit (webhook)
// router.post(
//   '/wallet/deposit/confirm',
//   walletController.confirmDeposit
// );

// // Request withdrawal
// router.post(
//   '/wallet/withdraw',
//   roleCheck(['voter']),
//   walletController.requestWithdrawal
// );

// // Get withdrawal requests
// router.get(
//   '/wallet/withdrawals',
//   roleCheck(['voter']),
//   walletController.getWithdrawalRequests
// );

// // Admin: Get pending withdrawals
// router.get(
//   '/admin/wallet/withdrawals/pending',
//   roleCheck(['admin', 'manager']),
//   walletController.getPendingWithdrawals
// );

// // Admin: Review withdrawal
// router.put(
//   '/admin/wallet/withdrawals/:requestId/review',
//   roleCheck(['admin', 'manager']),
//   walletController.reviewWithdrawal
// );

// // Pay for election participation
// router.post(
//   '/wallet/pay-election',
//   roleCheck(['voter']),
//   walletController.payForElection
// );

// // Confirm election payment (webhook)
// router.post(
//   '/wallet/election-payment/confirm',
//   walletController.confirmElectionPayment
// );

// // ✅ NEW: Check if user paid for election
// router.get(
//   '/wallet/election-payment/status/:electionId',
//   roleCheck(['voter']),
//   walletController.checkElectionPaymentStatus
// );
// // Check if user can vote (before payment)
// router.get(
//   '/wallet/can-vote/:electionId',
//   roleCheck(['voter']),
//   walletController.canUserVote
// );

// export default router;
// import express from 'express';
// import walletController from '../controllers/wallet.controller.js';
// import roleCheck from '../ middleware/roleCheck.js';
// //import roleCheck from '../middleware/roleCheck.js';

// const router = express.Router();

// // Get user wallet
// router.get(
//   '/wallet',
//   roleCheck(['voter']),
//   walletController.getWallet
// );

// // Get wallet transactions
// router.get(
//   '/wallet/transactions',
//   roleCheck(['voter']),
//   walletController.getTransactions
// );

// // Get blocked accounts
// router.get(
//   '/wallet/blocked-accounts',
//   roleCheck(['voter']),
//   walletController.getBlockedAccounts
// );

// // Get wallet analytics
// router.get(
//   '/wallet/analytics',
//   roleCheck(['voter']),
//   walletController.getWalletAnalytics
// );

// // Deposit funds
// router.post(
//   '/wallet/deposit',
//   roleCheck(['voter']),
//   walletController.deposit
// );

// // Confirm deposit (webhook)
// router.post(
//   '/wallet/deposit/confirm',
//   walletController.confirmDeposit
// );

// // Request withdrawal
// router.post(
//   '/wallet/withdraw',
//   roleCheck(['voter']),
//   walletController.requestWithdrawal
// );

// // Get withdrawal requests
// router.get(
//   '/wallet/withdrawals',
//   roleCheck(['voter']),
//   walletController.getWithdrawalRequests
// );

// // Admin: Get pending withdrawals
// router.get(
//   '/admin/wallet/withdrawals/pending',
//   roleCheck(['admin', 'manager']),
//   walletController.getPendingWithdrawals
// );

// // Admin: Review withdrawal
// router.put(
//   '/admin/wallet/withdrawals/:requestId/review',
//   roleCheck(['admin', 'manager']),
//   walletController.reviewWithdrawal
// );

// // Pay for election participation
// router.post(
//   '/wallet/pay-election',
//   roleCheck(['voter']),
//   walletController.payForElection
// );

// // Confirm election payment (webhook)
// router.post(
//   '/wallet/election-payment/confirm',
//   walletController.confirmElectionPayment
// );

// export default router;