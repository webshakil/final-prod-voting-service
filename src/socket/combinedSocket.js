// voting-service/socket/combinedSocket.js
// ✅ UNIFIED SOCKET.IO SERVER - Handles both voting and notifications
import { Server } from 'socket.io';

let io;

/**
 * Initialize a SINGLE Socket.IO server with multiple event handlers
 * This prevents the "handleUpgrade called more than once" error
 */
export const initializeCombinedSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: [
        'http://localhost:3000',
        'https://prod-client-omega.vercel.app'
      ],
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    allowEIO3: true,
  });

  io.on('connection', (socket) => {
    console.log(`✅ [COMBINED SOCKET] Client connected: ${socket.id}`);

    // ========================================
    // NOTIFICATION EVENTS
    // ========================================
    socket.on('join-notifications', (userId) => {
      socket.join(`user-${userId}`);
      socket.join('all-users');
      console.log(`🔔 User ${userId} joined notification rooms`);
    });

    socket.on('leave-notifications', (userId) => {
      socket.leave(`user-${userId}`);
      console.log(`👋 User ${userId} left notification room`);
    });

    // ========================================
    // VOTING/ELECTION EVENTS
    // ========================================
    socket.on('join-election', (electionId) => {
      socket.join(`election-${electionId}`);
      console.log(`📊 Client joined election room: ${electionId}`);
    });

    socket.on('leave-election', (electionId) => {
      socket.leave(`election-${electionId}`);
      console.log(`👋 Client left election room: ${electionId}`);
    });

    // ========================================
    // DISCONNECT
    // ========================================
    socket.on('disconnect', () => {
      console.log(`❌ [COMBINED SOCKET] Client disconnected: ${socket.id}`);
    });
  });

  console.log('✅ Combined Socket.IO server initialized (Voting + Notifications)');
  return io;
};

/**
 * Get Socket.IO instance
 */
export const getIO = () => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

// ========================================
// VOTING/LIVE RESULTS EMISSIONS
// ========================================

export const emitVoteCast = (electionId, voteData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }
  
  console.log(`🗳️ Emitting vote cast for election ${electionId}`);
  io.to(`election-${electionId}`).emit('vote-cast', voteData);
};

export const emitLiveResultsUpdate = (electionId, resultsData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }
  
  console.log(`📊 Emitting live results update for election ${electionId}`);
  io.to(`election-${electionId}`).emit('live-results-update', resultsData);
};

// ========================================
// PAYMENT NOTIFICATIONS
// ========================================

export const emitPaymentInitiated = (userId, paymentData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'payment_initiated',
    title: 'Payment Processing',
    message: `Payment of $${paymentData.amount} is being processed...`,
    data: {
      paymentId: paymentData.paymentId,
      amount: paymentData.amount,
      electionId: paymentData.electionId,
      electionTitle: paymentData.electionTitle,
      gateway: paymentData.gateway,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`💳 Sending payment initiated notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

export const emitPaymentSuccess = (userId, paymentData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'payment_success',
    title: 'Payment Successful',
    message: `Your payment of $${paymentData.amount} was successful! You can now vote.`,
    link: `/election/${paymentData.electionId}/vote`,
    data: {
      paymentId: paymentData.paymentId,
      amount: paymentData.amount,
      electionId: paymentData.electionId,
      electionTitle: paymentData.electionTitle,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`✅ Sending payment success notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

export const emitPaymentFailed = (userId, paymentData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'payment_failed',
    title: 'Payment Failed',
    message: `Payment of $${paymentData.amount} failed. Please try again.`,
    link: `/election/${paymentData.electionId}`,
    data: {
      paymentId: paymentData.paymentId,
      amount: paymentData.amount,
      electionId: paymentData.electionId,
      electionTitle: paymentData.electionTitle,
      error: paymentData.error,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`❌ Sending payment failed notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

// ========================================
// VOTING NOTIFICATIONS
// ========================================

export const emitVoteCastConfirmation = (userId, voteData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'vote_cast',
    title: 'Vote Recorded Successfully',
    message: `Your vote in "${voteData.electionTitle}" has been recorded!`,
    link: `/election/${voteData.electionId}/results`,
    data: {
      electionId: voteData.electionId,
      electionTitle: voteData.electionTitle,
      votingId: voteData.votingId,
      receiptId: voteData.receiptId,
      voteHash: voteData.voteHash,
      isAnonymous: voteData.isAnonymous,
      isEdit: voteData.isEdit,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`🗳️ Sending vote confirmation to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

export const emitVoteUpdated = (userId, voteData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'vote_updated',
    title: 'Vote Updated Successfully',
    message: `Your vote in "${voteData.electionTitle}" has been updated!`,
    link: `/election/${voteData.electionId}/results`,
    data: {
      electionId: voteData.electionId,
      electionTitle: voteData.electionTitle,
      votingId: voteData.votingId,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`📝 Sending vote update notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

export const emitNewVoteToElection = (electionId, voteData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'new_vote',
    electionId: electionId,
    totalVotes: voteData.totalVotes,
    timestamp: new Date().toISOString(),
  };

  console.log(`📊 Broadcasting new vote to election ${electionId} watchers`);
  io.to(`election-${electionId}`).emit('new-vote', notification);
};

// ========================================
// LOTTERY NOTIFICATIONS
// ========================================

export const emitLotteryTicketCreated = (userId, lotteryData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'lottery_ticket_created',
    title: 'Lottery Ticket Created',
    message: `You've been entered into the lottery for "${lotteryData.electionTitle}"!`,
    link: `/election/${lotteryData.electionId}/lottery`,
    data: {
      electionId: lotteryData.electionId,
      electionTitle: lotteryData.electionTitle,
      ticketNumber: lotteryData.ticketNumber,
      ballNumber: lotteryData.ballNumber,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`🎫 Sending lottery ticket notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

export const emitLotteryWinner = (userId, winnerData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const notification = {
    type: 'lottery_winner',
    title: '🎉 Congratulations! You Won!',
    message: `You won ${winnerData.prizeDescription} in "${winnerData.electionTitle}"!`,
    link: `/dashboard/wallet`,
    data: {
      electionId: winnerData.electionId,
      electionTitle: winnerData.electionTitle,
      prizeAmount: winnerData.prizeAmount,
      rank: winnerData.rank,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(`🏆 Sending lottery winner notification to user ${userId}`);
  io.to(`user-${userId}`).emit('notification', notification);
};

// ========================================
// GENERAL NOTIFICATIONS
// ========================================

export const emitToUser = (userId, notification) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  console.log(`📡 Sending notification to user ${userId}:`, notification.title);
  
  io.to(`user-${userId}`).emit('notification', {
    ...notification,
    timestamp: new Date().toISOString(),
  });
};

export const emitToAll = (notification) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  console.log(`📢 Broadcasting notification to all users:`, notification.title);
  
  io.to('all-users').emit('notification', {
    ...notification,
    timestamp: new Date().toISOString(),
  });
};

export default {
  initializeCombinedSocket,
  getIO,
  // Voting emissions
  emitVoteCast,
  emitLiveResultsUpdate,
  // Payment notifications
  emitPaymentInitiated,
  emitPaymentSuccess,
  emitPaymentFailed,
  // Vote notifications
  emitVoteCastConfirmation,
  emitVoteUpdated,
  emitNewVoteToElection,
  // Lottery notifications
  emitLotteryTicketCreated,
  emitLotteryWinner,
  // General notifications
  emitToUser,
  emitToAll,
};