// src/socket/analyticsSocket.js
// VOTING-SERVICE (3007) - Real-time analytics updates

import pool from '../config/database.js';

let io = null;
let broadcastInterval = null;

export const initAnalyticsSocket = (socketIO) => {
  io = socketIO;
  
  const analyticsNamespace = io.of('/analytics');
  
  analyticsNamespace.on('connection', (socket) => {
    console.log('📊 Analytics client connected:', socket.id);
    
    sendRealTimeStats(socket);
    
    socket.on('subscribe:dashboard', () => {
      socket.join('dashboard');
      sendRealTimeStats(socket);
    });

    socket.on('request:stats', async () => {
      await sendRealTimeStats(socket);
    });

    socket.on('disconnect', () => {
      console.log('📊 Analytics client disconnected:', socket.id);
    });
  });

  if (broadcastInterval) clearInterval(broadcastInterval);
  broadcastInterval = setInterval(async () => {
    if (!io) return;
    const stats = await fetchRealTimeStats();
    if (stats) io.of('/analytics').to('dashboard').emit('stats:update', stats);
  }, 30000);

  console.log('✅ Analytics Socket initialized');
  return analyticsNamespace;
};

async function fetchRealTimeStats() {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM votteryy_user_details) as total_users,
        (SELECT COUNT(*) FROM votteryyy_elections) as total_elections,
        (SELECT COUNT(*) FROM votteryyy_elections WHERE status = 'active') as active_elections,
        (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid') as total_votes,
        (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid' AND created_at >= NOW() - INTERVAL '1 hour') as votes_last_hour,
        (SELECT COUNT(*) FROM votteryy_votes WHERE status = 'valid' AND created_at >= NOW() - INTERVAL '24 hours') as votes_24h,
        (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_revenue,
        (SELECT COALESCE(SUM(platform_fee), 0) FROM votteryy_election_payments WHERE status = 'succeeded') as total_platform_fees,
        (SELECT COALESCE(SUM(amount), 0) FROM votteryy_election_payments WHERE status = 'succeeded' AND created_at >= NOW() - INTERVAL '24 hours') as revenue_24h,
        (SELECT COUNT(*) FROM votteryy_user_subscriptions WHERE status = 'active') as active_subscriptions,
        (SELECT COUNT(*) FROM votteryy_user_details WHERE collected_at >= NOW() - INTERVAL '24 hours') as new_users_24h
    `);

    const stats = result.rows[0];
    
    return {
      timestamp: new Date().toISOString(),
      overview: {
        totalUsers: parseInt(stats.total_users),
        totalElections: parseInt(stats.total_elections),
        activeElections: parseInt(stats.active_elections),
        totalVotes: parseInt(stats.total_votes),
        totalRevenue: parseFloat(stats.total_revenue),
        totalPlatformFees: parseFloat(stats.total_platform_fees),
        activeSubscriptions: parseInt(stats.active_subscriptions)
      },
      activity: {
        votesLastHour: parseInt(stats.votes_last_hour),
        votes24h: parseInt(stats.votes_24h),
        revenue24h: parseFloat(stats.revenue_24h),
        newUsers24h: parseInt(stats.new_users_24h)
      }
    };
  } catch (error) {
    console.error('Error fetching real-time stats:', error);
    return null;
  }
}

async function sendRealTimeStats(socket) {
  const stats = await fetchRealTimeStats();
  if (stats) socket.emit('stats:update', stats);
}

export const emitNewVote = async (voteData) => {
  if (!io) return;
  io.of('/analytics').to('dashboard').emit('vote:new', { timestamp: new Date().toISOString(), electionId: voteData.electionId });
  const stats = await fetchRealTimeStats();
  if (stats) io.of('/analytics').to('dashboard').emit('stats:update', stats);
};

export const emitNewElection = async (electionData) => {
  if (!io) return;
  io.of('/analytics').to('dashboard').emit('election:new', { timestamp: new Date().toISOString(), electionId: electionData.id, title: electionData.title });
  const stats = await fetchRealTimeStats();
  if (stats) io.of('/analytics').to('dashboard').emit('stats:update', stats);
};

export const emitPaymentProcessed = async (paymentData) => {
  if (!io) return;
  io.of('/analytics').to('dashboard').emit('payment:processed', { timestamp: new Date().toISOString(), amount: paymentData.amount, gateway: paymentData.gateway });
  const stats = await fetchRealTimeStats();
  if (stats) io.of('/analytics').to('dashboard').emit('stats:update', stats);
};

export const emitNewUser = async (userData) => {
  if (!io) return;
  io.of('/analytics').to('dashboard').emit('user:new', { timestamp: new Date().toISOString(), country: userData.country });
  const stats = await fetchRealTimeStats();
  if (stats) io.of('/analytics').to('dashboard').emit('stats:update', stats);
};

export default { initAnalyticsSocket, emitNewVote, emitNewElection, emitPaymentProcessed, emitNewUser };