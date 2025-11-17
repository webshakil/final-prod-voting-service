// src/socket/votingSocket.js
// ✅ Real-time WebSocket for Live Voting Results
import { Server } from 'socket.io';

let io;

/**
 * Initialize Socket.IO server
 */
export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);

    // Join election room
    socket.on('join-election', (electionId) => {
      socket.join(`election-${electionId}`);
      console.log(`📊 Client ${socket.id} joined election room: ${electionId}`);
      
      // Send confirmation
      socket.emit('joined-election', { electionId });
    });

    // Leave election room
    socket.on('leave-election', (electionId) => {
      socket.leave(`election-${electionId}`);
      console.log(`👋 Client ${socket.id} left election room: ${electionId}`);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });

  console.log('✅ Socket.IO server initialized');
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

/**
 * Emit vote cast event to all clients in election room
 */
export const emitVoteCast = (electionId, voteData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const roomName = `election-${electionId}`;
  
  console.log(`📡 Broadcasting vote-cast to room: ${roomName}`);
  
  io.to(roomName).emit('vote-cast', {
    electionId,
    timestamp: new Date().toISOString(),
    ...voteData,
  });
};

/**
 * Emit live results update
 */
export const emitLiveResultsUpdate = (electionId, resultsData) => {
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return;
  }

  const roomName = `election-${electionId}`;
  
  console.log(`📊 Broadcasting live-results-update to room: ${roomName}`);
  
  io.to(roomName).emit('live-results-update', {
    electionId,
    timestamp: new Date().toISOString(),
    results: resultsData,
  });
};

export default {
  initializeSocket,
  getIO,
  emitVoteCast,
  emitLiveResultsUpdate,
};