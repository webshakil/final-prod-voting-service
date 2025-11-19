// // voting-service/socket/notificationSocket.js
// import { Server } from 'socket.io';

// let io;

// /**
//  * Initialize Socket.IO server for real-time notifications
//  */
// export const initializeNotificationSocket = (server) => {
//   io = new Server(server, {
//     cors: {
//       origin: [
//         'http://localhost:3000',
//         'https://prod-client-omega.vercel.app'
//       ],
//       methods: ['GET', 'POST'],
//       credentials: true,
//     },
//     path: '/socket.io',
//     transports: ['websocket', 'polling'],
//   });

//   io.on('connection', (socket) => {
//     console.log(`✅ [NOTIFICATIONS] Client connected: ${socket.id}`);

//     // User joins their personal notification room
//     socket.on('join-notifications', (userId) => {
//       socket.join(`user-${userId}`);
//       socket.join('all-users'); // Global notifications room
//       console.log(`🔔 User ${userId} joined notification rooms`);
//     });

//     // Join election-specific room
//     socket.on('join-election', (electionId) => {
//       socket.join(`election-${electionId}`);
//       console.log(`📊 Client joined election room: ${electionId}`);
//     });

//     // Leave election room
//     socket.on('leave-election', (electionId) => {
//       socket.leave(`election-${electionId}`);
//       console.log(`👋 Client left election room: ${electionId}`);
//     });

//     // Leave notification room
//     socket.on('leave-notifications', (userId) => {
//       socket.leave(`user-${userId}`);
//       console.log(`👋 User ${userId} left notification room`);
//     });

//     socket.on('disconnect', () => {
//       console.log(`❌ [NOTIFICATIONS] Client disconnected: ${socket.id}`);
//     });
//   });

//   console.log('✅ Notification Socket.IO server initialized on Voting Service');
//   return io;
// };

// /**
//  * Get Socket.IO instance
//  */
// export const getIO = () => {
//   if (!io) {
//     throw new Error('Socket.IO not initialized');
//   }
//   return io;
// };

// // ========================================
// // PAYMENT NOTIFICATIONS
// // ========================================

// /**
//  * Emit payment initiated notification
//  */
// export const emitPaymentInitiated = (userId, paymentData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'payment_initiated',
//     title: 'Payment Processing',
//     message: `Payment of $${paymentData.amount} is being processed...`,
//     data: {
//       paymentId: paymentData.paymentId,
//       amount: paymentData.amount,
//       electionId: paymentData.electionId,
//       electionTitle: paymentData.electionTitle,
//       gateway: paymentData.gateway,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`💳 Sending payment initiated notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// /**
//  * Emit payment success notification
//  */
// export const emitPaymentSuccess = (userId, paymentData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'payment_success',
//     title: 'Payment Successful',
//     message: `Your payment of $${paymentData.amount} was successful! You can now vote.`,
//     link: `/election/${paymentData.electionId}/vote`,
//     data: {
//       paymentId: paymentData.paymentId,
//       amount: paymentData.amount,
//       electionId: paymentData.electionId,
//       electionTitle: paymentData.electionTitle,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`✅ Sending payment success notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// /**
//  * Emit payment failure notification
//  */
// export const emitPaymentFailed = (userId, paymentData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'payment_failed',
//     title: 'Payment Failed',
//     message: `Payment of $${paymentData.amount} failed. Please try again.`,
//     link: `/election/${paymentData.electionId}`,
//     data: {
//       paymentId: paymentData.paymentId,
//       amount: paymentData.amount,
//       electionId: paymentData.electionId,
//       electionTitle: paymentData.electionTitle,
//       error: paymentData.error,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`❌ Sending payment failed notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// // ========================================
// // VOTING NOTIFICATIONS
// // ========================================

// /**
//  * Emit vote cast notification (personal)
//  */
// export const emitVoteCastConfirmation = (userId, voteData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'vote_cast',
//     title: 'Vote Recorded Successfully',
//     message: `Your vote in "${voteData.electionTitle}" has been recorded!`,
//     link: `/election/${voteData.electionId}/results`,
//     data: {
//       electionId: voteData.electionId,
//       electionTitle: voteData.electionTitle,
//       votingId: voteData.votingId,
//       receiptId: voteData.receiptId,
//       voteHash: voteData.voteHash,
//       isAnonymous: voteData.isAnonymous,
//       isEdit: voteData.isEdit,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`🗳️ Sending vote confirmation to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// /**
//  * Emit vote update notification (when editing vote)
//  */
// export const emitVoteUpdated = (userId, voteData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'vote_updated',
//     title: 'Vote Updated Successfully',
//     message: `Your vote in "${voteData.electionTitle}" has been updated!`,
//     link: `/election/${voteData.electionId}/results`,
//     data: {
//       electionId: voteData.electionId,
//       electionTitle: voteData.electionTitle,
//       votingId: voteData.votingId,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`📝 Sending vote update notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// /**
//  * Emit new vote notification to election watchers (live updates)
//  */
// export const emitNewVoteToElection = (electionId, voteData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'new_vote',
//     electionId: electionId,
//     totalVotes: voteData.totalVotes,
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`📊 Broadcasting new vote to election ${electionId} watchers`);
//   io.to(`election-${electionId}`).emit('new-vote', notification);
// };

// // ========================================
// // LOTTERY NOTIFICATIONS
// // ========================================

// /**
//  * Emit lottery ticket created notification
//  */
// export const emitLotteryTicketCreated = (userId, lotteryData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'lottery_ticket_created',
//     title: 'Lottery Ticket Created',
//     message: `You've been entered into the lottery for "${lotteryData.electionTitle}"!`,
//     link: `/election/${lotteryData.electionId}/lottery`,
//     data: {
//       electionId: lotteryData.electionId,
//       electionTitle: lotteryData.electionTitle,
//       ticketNumber: lotteryData.ticketNumber,
//       ballNumber: lotteryData.ballNumber,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`🎫 Sending lottery ticket notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// /**
//  * Emit lottery winner notification
//  */
// export const emitLotteryWinner = (userId, winnerData) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   const notification = {
//     type: 'lottery_winner',
//     title: '🎉 Congratulations! You Won!',
//     message: `You won ${winnerData.prizeDescription} in "${winnerData.electionTitle}"!`,
//     link: `/dashboard/wallet`,
//     data: {
//       electionId: winnerData.electionId,
//       electionTitle: winnerData.electionTitle,
//       prizeAmount: winnerData.prizeAmount,
//       rank: winnerData.rank,
//     },
//     timestamp: new Date().toISOString(),
//   };

//   console.log(`🏆 Sending lottery winner notification to user ${userId}`);
//   io.to(`user-${userId}`).emit('notification', notification);
// };

// // ========================================
// // GENERAL NOTIFICATIONS
// // ========================================

// /**
//  * Emit notification to specific user
//  */
// export const emitToUser = (userId, notification) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   console.log(`📡 Sending notification to user ${userId}:`, notification.title);
  
//   io.to(`user-${userId}`).emit('notification', {
//     ...notification,
//     timestamp: new Date().toISOString(),
//   });
// };

// /**
//  * Emit notification to all users
//  */
// export const emitToAll = (notification) => {
//   if (!io) {
//     console.error('❌ Socket.IO not initialized');
//     return;
//   }

//   console.log(`📢 Broadcasting notification to all users:`, notification.title);
  
//   io.to('all-users').emit('notification', {
//     ...notification,
//     timestamp: new Date().toISOString(),
//   });
// };

// export default {
//   initializeNotificationSocket,
//   getIO,
//   emitPaymentInitiated,
//   emitPaymentSuccess,
//   emitPaymentFailed,
//   emitVoteCastConfirmation,
//   emitVoteUpdated,
//   emitNewVoteToElection,
//   emitLotteryTicketCreated,
//   emitLotteryWinner,
//   emitToUser,
//   emitToAll,
// };