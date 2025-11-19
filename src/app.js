import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
// ✅ FIXED: Use single combined socket instead of two separate ones
import { initializeCombinedSocket } from './socket/combinedSocket.js';

// Import routes
import votingRoutes from './routes/voting.routes.js';
import lotteryRoutes from './routes/lottery.routes.js';
import walletRoutes from './routes/wallet.routes.js';
import verificationRoutes from './routes/verification.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';

// Import middleware
import errorHandler from './ middleware/errorHandler.js';

// Import services
import lotteryController from './controllers/lottery.controller.js';
import paymentService from './services/payment.service.js';

// Import database
import pool from './config/database.js';

dotenv.config();

const app = express();

// ✅ CREATE HTTP SERVER (REQUIRED FOR SOCKET.IO)
const server = http.createServer(app);

// ✅ FIXED: Initialize SINGLE combined socket
initializeCombinedSocket(server);

const PORT = process.env.PORT || 5003;

// ===========================
// MIDDLEWARE
// ===========================

// Security
app.use(helmet());

const corsOptions = {
  origin: [
    'http://localhost:3000',
    'https://prod-client-omega.vercel.app', 
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: '*',
  exposedHeaders: ['*'],
};

app.use(cors(corsOptions));

// Handle preflight requests explicitly
app.options('*', cors(corsOptions));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Mock auth middleware (replace with actual auth service call)
app.use((req, res, next) => {
  const userId = req.headers['x-user-id'] || req.headers['authorization']?.split(' ')[1];
  
  if (userId) {
    req.user = { userId };
  }
  
  next();
});

// ===========================
// ROUTES
// ===========================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'voting-service',
    timestamp: new Date().toISOString()
  });
});

// API Routes
app.use('/api/voting', votingRoutes);
app.use('/api/lottery', lotteryRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/analytics', analyticsRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use(errorHandler);

// ===========================
// CRON JOBS
// ===========================

// Auto-draw lotteries for completed elections (runs every hour)
if (process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true') {
  cron.schedule('0 * * * *', async () => {
    console.log('🎰 Running auto-lottery draw cron job...');
    
    try {
      const result = await pool.query(
        `SELECT e.id FROM votteryyy_elections e
         LEFT JOIN votteryy_lottery_draws ld ON e.id = ld.election_id
         WHERE e.lottery_enabled = true
         AND e.status = 'completed'
         AND ld.id IS NULL
         AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
      );

      console.log(`Found ${result.rows.length} elections ready for lottery draw`);

      for (const row of result.rows) {
        try {
          await lotteryController.autoDrawLottery(row.id);
          console.log(`✅ Auto-drew lottery for election ${row.id}`);
        } catch (error) {
          console.error(`❌ Failed to draw lottery for election ${row.id}:`, error.message);
        }
      }

    } catch (error) {
      console.error('Auto-lottery cron error:', error);
    }
  });
}

// Release blocked accounts for completed elections (runs every hour)
cron.schedule('0 * * * *', async () => {
  console.log('💰 Running blocked accounts release cron job...');
  
  try {
    const result = await pool.query(
      `SELECT DISTINCT e.id FROM votteryyy_elections e
       JOIN votteryy_blocked_accounts ba ON e.id = ba.election_id
       WHERE ba.status = 'locked'
       AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
    );

    console.log(`Found ${result.rows.length} elections with blocked accounts to release`);

    for (const row of result.rows) {
      try {
        await paymentService.releaseBlockedAccounts(row.id);
        console.log(`✅ Released blocked accounts for election ${row.id}`);
      } catch (error) {
        console.error(`❌ Failed to release blocked accounts for election ${row.id}:`, error.message);
      }
    }

  } catch (error) {
    console.error('Blocked accounts release cron error:', error);
  }
});

// ===========================
// START SERVER
// ===========================

server.listen(PORT, () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🗳️  VOTTERY VOTING SERVICE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Database: ${process.env.DB_NAME}`);
  console.log(`🎰 Auto-lottery: ${process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🔔 Notifications: ENABLED`);  // ✅ ADDED
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📋 Available Routes:');
  console.log('  GET  /health');
  console.log('  POST /api/voting/elections/:id/vote');
  console.log('  GET  /api/lottery/elections/:id/lottery');
  console.log('  POST /api/wallet/deposit');
  console.log('  GET  /api/verification/verify/receipt/:id');
  console.log('  GET  /api/analytics/elections/:id/analytics');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

export default app;
//last workable code just to add socket.io above code
// import express from 'express';
// import http from 'http';
// import cors from 'cors';
// import helmet from 'helmet';
// import dotenv from 'dotenv';
// import rateLimit from 'express-rate-limit';
// import cron from 'node-cron';
// import { initializeSocket } from './socket/votingSocket.js';
// // Import routes
// import votingRoutes from './routes/voting.routes.js';
// import lotteryRoutes from './routes/lottery.routes.js';
// import walletRoutes from './routes/wallet.routes.js';
// import verificationRoutes from './routes/verification.routes.js';
// import analyticsRoutes from './routes/analytics.routes.js';

// // Import middleware
// import errorHandler from './ middleware/errorHandler.js';

// // Import services
// import lotteryController from './controllers/lottery.controller.js';
// import paymentService from './services/payment.service.js';

// // Import database
// import pool from './config/database.js';

// dotenv.config();

// const app = express();


// // ✅ CREATE HTTP SERVER (REQUIRED FOR SOCKET.IO)
// const server = http.createServer(app);

// // ✅ INITIALIZE SOCKET.IO
// initializeSocket(server);
// const PORT = process.env.PORT || 5003;

// // ===========================
// // MIDDLEWARE
// // ===========================

// // Security
// app.use(helmet());
// // ✅ CORRECT - Uncomment this line!
// const corsOptions = {
//   origin: [
//     'http://localhost:3000',
//     'https://prod-client-omega.vercel.app', 
//   ],
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
//   allowedHeaders: '*', // ✅ Allow ALL headers
//   exposedHeaders: ['*'], // ✅ Expose ALL headers
// };

// app.use(cors(corsOptions)); // ✅ MUST BE UNCOMMENTED!

// // Handle preflight requests explicitly
// app.options('*', cors(corsOptions));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Rate limiting
// // const limiter = rateLimit({
// //   windowMs: 15 * 60 * 1000, // 15 minutes
// //   max: 100, // limit each IP to 100 requests per windowMs
// //   message: 'Too many requests, please try again later'
// // });

// //app.use('/api/', limiter);

// // Request logging
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
//   next();
// });

// // Mock auth middleware (replace with actual auth service call)
// app.use((req, res, next) => {
//   // In production, verify JWT token from auth-service
//   // For now, simulate authenticated user
//   const userId = req.headers['x-user-id'] || req.headers['authorization']?.split(' ')[1];
  
//   if (userId) {
//     req.user = { userId };
//   }
  
//   next();
// });

// // ===========================
// // ROUTES
// // ===========================

// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'healthy',
//     service: 'voting-service',
//     timestamp: new Date().toISOString()
//   });
// });

// // API Routes
// app.use('/api/voting', votingRoutes);
// app.use('/api/lottery', lotteryRoutes);
// app.use('/api/wallet', walletRoutes);
// app.use('/api/verification', verificationRoutes);
// app.use('/api/analytics', analyticsRoutes);

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use(errorHandler);

// // ===========================
// // CRON JOBS
// // ===========================

// // Auto-draw lotteries for completed elections (runs every hour)
// if (process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true') {
//   cron.schedule('0 * * * *', async () => {
//     console.log('🎰 Running auto-lottery draw cron job...');
    
//     try {
//       // ✅ FIXED: Proper timestamp concatenation
//       const result = await pool.query(
//         `SELECT e.id FROM votteryyy_elections e
//          LEFT JOIN votteryy_lottery_draws ld ON e.id = ld.election_id
//          WHERE e.lottery_enabled = true
//          AND e.status = 'completed'
//          AND ld.id IS NULL
//          AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//       );

//       console.log(`Found ${result.rows.length} elections ready for lottery draw`);

//       for (const row of result.rows) {
//         try {
//           await lotteryController.autoDrawLottery(row.id);
//           console.log(`✅ Auto-drew lottery for election ${row.id}`);
//         } catch (error) {
//           console.error(`❌ Failed to draw lottery for election ${row.id}:`, error.message);
//         }
//       }

//     } catch (error) {
//       console.error('Auto-lottery cron error:', error);
//     }
//   });
// }

// // Release blocked accounts for completed elections (runs every hour)
// cron.schedule('0 * * * *', async () => {
//   console.log('💰 Running blocked accounts release cron job...');
  
//   try {
//     // ✅ FIXED: Proper timestamp concatenation
//     const result = await pool.query(
//       `SELECT DISTINCT e.id FROM votteryyy_elections e
//        JOIN votteryy_blocked_accounts ba ON e.id = ba.election_id
//        WHERE ba.status = 'locked'
//        AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//     );

//     console.log(`Found ${result.rows.length} elections with blocked accounts to release`);

//     for (const row of result.rows) {
//       try {
//         await paymentService.releaseBlockedAccounts(row.id);
//         console.log(`✅ Released blocked accounts for election ${row.id}`);
//       } catch (error) {
//         console.error(`❌ Failed to release blocked accounts for election ${row.id}:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('Blocked accounts release cron error:', error);
//   }
// });

// // ===========================
// // START SERVER
// // ===========================

// server.listen(PORT, () => {
//   console.log('');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('🗳️  VOTTERY VOTING SERVICE');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
//   console.log(`📊 Database: ${process.env.DB_NAME}`);
//   console.log(`🎰 Auto-lottery: ${process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
//   console.log('📋 Available Routes:');
//   console.log('  GET  /health');
//   console.log('  POST /api/voting/elections/:id/vote');
//   console.log('  GET  /api/lottery/elections/:id/lottery');
//   console.log('  POST /api/wallet/deposit');
//   console.log('  GET  /api/verification/verify/receipt/:id');
//   console.log('  GET  /api/analytics/elections/:id/analytics');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
// });

// // Graceful shutdown
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// process.on('SIGINT', async () => {
//   console.log('SIGINT received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// export default app;
//last workable code. only to implement socket.io above code
// import express from 'express';
// import cors from 'cors';
// import helmet from 'helmet';
// import dotenv from 'dotenv';
// import rateLimit from 'express-rate-limit';
// import cron from 'node-cron';

// // Import routes
// import votingRoutes from './routes/voting.routes.js';
// import lotteryRoutes from './routes/lottery.routes.js';
// import walletRoutes from './routes/wallet.routes.js';
// import verificationRoutes from './routes/verification.routes.js';
// import analyticsRoutes from './routes/analytics.routes.js';

// // Import middleware
// import errorHandler from './ middleware/errorHandler.js';

// // Import services
// import lotteryController from './controllers/lottery.controller.js';
// import paymentService from './services/payment.service.js';

// // Import database
// import pool from './config/database.js';

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5003;

// // ===========================
// // MIDDLEWARE
// // ===========================

// // Security
// app.use(helmet());
// // ✅ CORRECT - Uncomment this line!
// const corsOptions = {
//   origin: [
//     'http://localhost:3000',
//     'https://prod-client-omega.vercel.app', 
//   ],
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
//   allowedHeaders: '*', // ✅ Allow ALL headers
//   exposedHeaders: ['*'], // ✅ Expose ALL headers
// };

// app.use(cors(corsOptions)); // ✅ MUST BE UNCOMMENTED!

// // Handle preflight requests explicitly
// app.options('*', cors(corsOptions));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Rate limiting
// // const limiter = rateLimit({
// //   windowMs: 15 * 60 * 1000, // 15 minutes
// //   max: 100, // limit each IP to 100 requests per windowMs
// //   message: 'Too many requests, please try again later'
// // });

// //app.use('/api/', limiter);

// // Request logging
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
//   next();
// });

// // Mock auth middleware (replace with actual auth service call)
// app.use((req, res, next) => {
//   // In production, verify JWT token from auth-service
//   // For now, simulate authenticated user
//   const userId = req.headers['x-user-id'] || req.headers['authorization']?.split(' ')[1];
  
//   if (userId) {
//     req.user = { userId };
//   }
  
//   next();
// });

// // ===========================
// // ROUTES
// // ===========================

// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'healthy',
//     service: 'voting-service',
//     timestamp: new Date().toISOString()
//   });
// });

// // API Routes
// app.use('/api/voting', votingRoutes);
// app.use('/api/lottery', lotteryRoutes);
// app.use('/api/wallet', walletRoutes);
// app.use('/api/verification', verificationRoutes);
// app.use('/api/analytics', analyticsRoutes);

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use(errorHandler);

// // ===========================
// // CRON JOBS
// // ===========================

// // Auto-draw lotteries for completed elections (runs every hour)
// if (process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true') {
//   cron.schedule('0 * * * *', async () => {
//     console.log('🎰 Running auto-lottery draw cron job...');
    
//     try {
//       // ✅ FIXED: Proper timestamp concatenation
//       const result = await pool.query(
//         `SELECT e.id FROM votteryyy_elections e
//          LEFT JOIN votteryy_lottery_draws ld ON e.id = ld.election_id
//          WHERE e.lottery_enabled = true
//          AND e.status = 'completed'
//          AND ld.id IS NULL
//          AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//       );

//       console.log(`Found ${result.rows.length} elections ready for lottery draw`);

//       for (const row of result.rows) {
//         try {
//           await lotteryController.autoDrawLottery(row.id);
//           console.log(`✅ Auto-drew lottery for election ${row.id}`);
//         } catch (error) {
//           console.error(`❌ Failed to draw lottery for election ${row.id}:`, error.message);
//         }
//       }

//     } catch (error) {
//       console.error('Auto-lottery cron error:', error);
//     }
//   });
// }

// // Release blocked accounts for completed elections (runs every hour)
// cron.schedule('0 * * * *', async () => {
//   console.log('💰 Running blocked accounts release cron job...');
  
//   try {
//     // ✅ FIXED: Proper timestamp concatenation
//     const result = await pool.query(
//       `SELECT DISTINCT e.id FROM votteryyy_elections e
//        JOIN votteryy_blocked_accounts ba ON e.id = ba.election_id
//        WHERE ba.status = 'locked'
//        AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//     );

//     console.log(`Found ${result.rows.length} elections with blocked accounts to release`);

//     for (const row of result.rows) {
//       try {
//         await paymentService.releaseBlockedAccounts(row.id);
//         console.log(`✅ Released blocked accounts for election ${row.id}`);
//       } catch (error) {
//         console.error(`❌ Failed to release blocked accounts for election ${row.id}:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('Blocked accounts release cron error:', error);
//   }
// });

// // ===========================
// // START SERVER
// // ===========================

// app.listen(PORT, () => {
//   console.log('');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('🗳️  VOTTERY VOTING SERVICE');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
//   console.log(`📊 Database: ${process.env.DB_NAME}`);
//   console.log(`🎰 Auto-lottery: ${process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
//   console.log('📋 Available Routes:');
//   console.log('  GET  /health');
//   console.log('  POST /api/voting/elections/:id/vote');
//   console.log('  GET  /api/lottery/elections/:id/lottery');
//   console.log('  POST /api/wallet/deposit');
//   console.log('  GET  /api/verification/verify/receipt/:id');
//   console.log('  GET  /api/analytics/elections/:id/analytics');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
// });

// // Graceful shutdown
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// process.on('SIGINT', async () => {
//   console.log('SIGINT received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// export default app;
//last workable code
// import express from 'express';
// import cors from 'cors';
// import helmet from 'helmet';
// import dotenv from 'dotenv';
// import rateLimit from 'express-rate-limit';
// import cron from 'node-cron';

// // Import routes
// import votingRoutes from './routes/voting.routes.js';
// import lotteryRoutes from './routes/lottery.routes.js';
// import walletRoutes from './routes/wallet.routes.js';
// import verificationRoutes from './routes/verification.routes.js';
// import analyticsRoutes from './routes/analytics.routes.js';

// // Import middleware
// import errorHandler from './ middleware/errorHandler.js';

// // Import services
// import lotteryController from './controllers/lottery.controller.js';
// import paymentService from './services/payment.service.js';

// // Import database
// import pool from './config/database.js';

// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5003;

// // ===========================
// // MIDDLEWARE
// // ===========================

// // Security
// app.use(helmet());

// // CORS
// const corsOptions = {
//   origin: [
//     'http://localhost:3000',
//     'https://prod-client-omega.vercel.app', 
//   ],
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
// };

// app.use(cors(corsOptions));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Rate limiting
// // const limiter = rateLimit({
// //   windowMs: 15 * 60 * 1000, // 15 minutes
// //   max: 100, // limit each IP to 100 requests per windowMs
// //   message: 'Too many requests, please try again later'
// // });

// //app.use('/api/', limiter);

// // Request logging
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
//   next();
// });

// // Mock auth middleware (replace with actual auth service call)
// app.use((req, res, next) => {
//   // In production, verify JWT token from auth-service
//   // For now, simulate authenticated user
//   const userId = req.headers['x-user-id'] || req.headers['authorization']?.split(' ')[1];
  
//   if (userId) {
//     req.user = { userId };
//   }
  
//   next();
// });

// // ===========================
// // ROUTES
// // ===========================

// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'healthy',
//     service: 'voting-service',
//     timestamp: new Date().toISOString()
//   });
// });

// // API Routes
// app.use('/api/voting', votingRoutes);
// app.use('/api/lottery', lotteryRoutes);
// app.use('/api/wallet', walletRoutes);
// app.use('/api/verification', verificationRoutes);
// app.use('/api/analytics', analyticsRoutes);

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use(errorHandler);

// // ===========================
// // CRON JOBS
// // ===========================

// // Auto-draw lotteries for completed elections (runs every hour)
// if (process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true') {
//   cron.schedule('0 * * * *', async () => {
//     console.log('🎰 Running auto-lottery draw cron job...');
    
//     try {
//       // ✅ FIXED: Proper timestamp concatenation
//       const result = await pool.query(
//         `SELECT e.id FROM votteryyy_elections e
//          LEFT JOIN votteryy_lottery_draws ld ON e.id = ld.election_id
//          WHERE e.lottery_enabled = true
//          AND e.status = 'completed'
//          AND ld.id IS NULL
//          AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//       );

//       console.log(`Found ${result.rows.length} elections ready for lottery draw`);

//       for (const row of result.rows) {
//         try {
//           await lotteryController.autoDrawLottery(row.id);
//           console.log(`✅ Auto-drew lottery for election ${row.id}`);
//         } catch (error) {
//           console.error(`❌ Failed to draw lottery for election ${row.id}:`, error.message);
//         }
//       }

//     } catch (error) {
//       console.error('Auto-lottery cron error:', error);
//     }
//   });
// }

// // Release blocked accounts for completed elections (runs every hour)
// cron.schedule('0 * * * *', async () => {
//   console.log('💰 Running blocked accounts release cron job...');
  
//   try {
//     // ✅ FIXED: Proper timestamp concatenation
//     const result = await pool.query(
//       `SELECT DISTINCT e.id FROM votteryyy_elections e
//        JOIN votteryy_blocked_accounts ba ON e.id = ba.election_id
//        WHERE ba.status = 'locked'
//        AND (e.end_date + COALESCE(e.end_time, '23:59:59'::time))::timestamp < NOW()`
//     );

//     console.log(`Found ${result.rows.length} elections with blocked accounts to release`);

//     for (const row of result.rows) {
//       try {
//         await paymentService.releaseBlockedAccounts(row.id);
//         console.log(`✅ Released blocked accounts for election ${row.id}`);
//       } catch (error) {
//         console.error(`❌ Failed to release blocked accounts for election ${row.id}:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('Blocked accounts release cron error:', error);
//   }
// });

// // ===========================
// // START SERVER
// // ===========================

// app.listen(PORT, () => {
//   console.log('');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('🗳️  VOTTERY VOTING SERVICE');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
//   console.log(`📊 Database: ${process.env.DB_NAME}`);
//   console.log(`🎰 Auto-lottery: ${process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
//   console.log('📋 Available Routes:');
//   console.log('  GET  /health');
//   console.log('  POST /api/voting/elections/:id/vote');
//   console.log('  GET  /api/lottery/elections/:id/lottery');
//   console.log('  POST /api/wallet/deposit');
//   console.log('  GET  /api/verification/verify/receipt/:id');
//   console.log('  GET  /api/analytics/elections/:id/analytics');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
// });

// // Graceful shutdown
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// process.on('SIGINT', async () => {
//   console.log('SIGINT received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// export default app;
// import express from 'express';
// import cors from 'cors';
// import helmet from 'helmet';
// import dotenv from 'dotenv';
// import rateLimit from 'express-rate-limit';
// import cron from 'node-cron';

// // Import routes
// import votingRoutes from './routes/voting.routes.js';
// import lotteryRoutes from './routes/lottery.routes.js';
// import walletRoutes from './routes/wallet.routes.js';
// import verificationRoutes from './routes/verification.routes.js';
// import analyticsRoutes from './routes/analytics.routes.js';

// // Import middleware
// import errorHandler from './ middleware/errorHandler.js';

// // Import services
// import lotteryController from './controllers/lottery.controller.js';
// import paymentService from './services/payment.service.js';

// // Import database
// import pool from './config/database.js';


// dotenv.config();

// const app = express();
// const PORT = process.env.PORT || 5003;

// // ===========================
// // MIDDLEWARE
// // ===========================

// // Security
// app.use(helmet());

// // CORS
// app.use(cors({
//   origin: process.env.FRONTEND_URL || 'http://localhost:3000',
//   credentials: true
// }));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Rate limiting
// // const limiter = rateLimit({
// //   windowMs: 15 * 60 * 1000, // 15 minutes
// //   max: 100, // limit each IP to 100 requests per windowMs
// //   message: 'Too many requests, please try again later'
// // });

// //app.use('/api/', limiter);

// // Request logging
// app.use((req, res, next) => {
//   console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
//   next();
// });

// // Mock auth middleware (replace with actual auth service call)
// app.use((req, res, next) => {
//   // In production, verify JWT token from auth-service
//   // For now, simulate authenticated user
//   const userId = req.headers['x-user-id'] || req.headers['authorization']?.split(' ')[1];
  
//   if (userId) {
//     req.user = { userId };
//   }
  
//   next();
// });

// // ===========================
// // ROUTES
// // ===========================

// app.get('/health', (req, res) => {
//   res.json({ 
//     status: 'healthy',
//     service: 'voting-service',
//     timestamp: new Date().toISOString()
//   });
// });

// // API Routes
// app.use('/api/voting', votingRoutes);
// app.use('/api/lottery', lotteryRoutes);
// app.use('/api/wallet', walletRoutes);
// app.use('/api/verification', verificationRoutes);
// app.use('/api/analytics', analyticsRoutes);

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({ error: 'Route not found' });
// });

// // Error handler
// app.use(errorHandler);

// // ===========================
// // CRON JOBS
// // ===========================

// // Auto-draw lotteries for completed elections (runs every hour)
// if (process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true') {
//   cron.schedule('0 * * * *', async () => {
//     console.log('🎰 Running auto-lottery draw cron job...');
    
//     try {
//       // Find elections that ended and have lottery enabled but not drawn
//       const result = await pool.query(
//         `SELECT e.id FROM votteryyy_elections e
//          LEFT JOIN votteryy_lottery_draws ld ON e.id = ld.election_id
//          WHERE e.lottery_enabled = true
//          AND e.status = 'completed'
//          AND ld.id IS NULL
//          AND CONCAT(e.end_date, ' ', COALESCE(e.end_time, '23:59:59'))::timestamp < NOW()`
//       );

//       console.log(`Found ${result.rows.length} elections ready for lottery draw`);

//       for (const row of result.rows) {
//         try {
//           await lotteryController.autoDrawLottery(row.id);
//           console.log(`✅ Auto-drew lottery for election ${row.id}`);
//         } catch (error) {
//           console.error(`❌ Failed to draw lottery for election ${row.id}:`, error.message);
//         }
//       }

//     } catch (error) {
//       console.error('Auto-lottery cron error:', error);
//     }
//   });
// }

// // Release blocked accounts for completed elections (runs every hour)
// cron.schedule('0 * * * *', async () => {
//   console.log('💰 Running blocked accounts release cron job...');
  
//   try {
//     // Find elections that ended
//     const result = await pool.query(
//       `SELECT DISTINCT e.id FROM votteryyy_elections e
//        JOIN votteryy_blocked_accounts ba ON e.id = ba.election_id
//        WHERE ba.status = 'locked'
//        AND CONCAT(e.end_date, ' ', COALESCE(e.end_time, '23:59:59'))::timestamp < NOW()`
//     );

//     console.log(`Found ${result.rows.length} elections with blocked accounts to release`);

//     for (const row of result.rows) {
//       try {
//         await paymentService.releaseBlockedAccounts(row.id);
//         console.log(`✅ Released blocked accounts for election ${row.id}`);
//       } catch (error) {
//         console.error(`❌ Failed to release blocked accounts for election ${row.id}:`, error.message);
//       }
//     }

//   } catch (error) {
//     console.error('Blocked accounts release cron error:', error);
//   }
// });

// // ===========================
// // START SERVER
// // ===========================

// app.listen(PORT, () => {
//   console.log('');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('🗳️  VOTTERY VOTING SERVICE');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
//   console.log(`📊 Database: ${process.env.DB_NAME}`);
//   console.log(`🎰 Auto-lottery: ${process.env.LOTTERY_AUTO_DRAW_ENABLED === 'true' ? 'ENABLED' : 'DISABLED'}`);
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
//   console.log('📋 Available Routes:');
//   console.log('  GET  /health');
//   console.log('  POST /api/voting/elections/:id/vote');
//   console.log('  GET  /api/lottery/elections/:id/lottery');
//   console.log('  POST /api/wallet/deposit');
//   console.log('  GET  /api/verification/verify/receipt/:id');
//   console.log('  GET  /api/analytics/elections/:id/analytics');
//   console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
//   console.log('');
// });

// // Graceful shutdown
// process.on('SIGTERM', async () => {
//   console.log('SIGTERM received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// process.on('SIGINT', async () => {
//   console.log('SIGINT received, shutting down gracefully...');
//   await pool.end();
//   process.exit(0);
// });

// export default app;