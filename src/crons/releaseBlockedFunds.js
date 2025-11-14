// src/crons/releaseBlockedFunds.js
// ✅ Runs daily to release blocked funds for ended elections

import cron from 'node-cron';
import pool from '../config/database.js';
import paymentService from '../services/payment.service.js';

// Run every day at 2:00 AM
const releaseBlockedFundsCron = cron.schedule('0 2 * * *', async () => {
  console.log('🕐 [CRON] Starting blocked funds release job');

  const client = await pool.connect();
  
  try {
    // Get all elections that have ended
    const endedElections = await client.query(
      `SELECT id, title, end_date, end_time, creator_id
       FROM votteryyy_elections
       WHERE status = 'published'
         AND CONCAT(end_date::text, ' ', COALESCE(end_time, '23:59:59'))::timestamp < NOW()
         AND id IN (
           SELECT DISTINCT election_id 
           FROM votteryy_blocked_accounts 
           WHERE status = 'locked'
         )`
    );

    console.log(`📊 Found ${endedElections.rows.length} ended elections with blocked funds`);

    for (const election of endedElections.rows) {
      console.log(`\n🗳️ Processing election #${election.id}: ${election.title}`);
      
      try {
        // Release blocked funds for this election
        const result = await paymentService.releaseBlockedAccounts(election.id);
        
        console.log(`✅ Released funds for ${result.releasedCount} accounts`);
        
        // Optional: Mark election as 'completed'
        await client.query(
          `UPDATE votteryyy_elections 
           SET status = 'completed' 
           WHERE id = $1`,
          [election.id]
        );
        
      } catch (error) {
        console.error(`❌ Error releasing funds for election #${election.id}:`, error);
      }
    }

    console.log('\n✅ [CRON] Blocked funds release job completed');

  } catch (error) {
    console.error('❌ [CRON] Error in blocked funds release:', error);
  } finally {
    client.release();
  }
}, {
  scheduled: false, // Start manually
  timezone: "UTC"
});

// Manual trigger endpoint (for testing)
export const manualReleaseBlockedFunds = async () => {
  console.log('🔧 [MANUAL] Triggering blocked funds release');
  releaseBlockedFundsCron.now();
};

export default releaseBlockedFundsCron;