// src/middleware/videoWatch.js
import pool from '../config/database.js';

export const videoWatch = async (req, res, next) => {
  try {
    const { electionId } = req.params;
    const userId = String(req.user?.userId || req.headers['x-user-id']); // ✅ Convert to string

    console.log('🎬 Video watch middleware - checking userId:', userId, 'electionId:', electionId);

    // Get election
    const electionResult = await pool.query(
      `SELECT video_watch_required, minimum_watch_percentage 
       FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      console.log('❌ Election not found');
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];
    
    console.log('📹 Video settings:', {
      required: election.video_watch_required,
      minPercentage: election.minimum_watch_percentage
    });

    // ✅ If video not required, skip check
    if (!election.video_watch_required) {
      console.log('✅ Video not required, proceeding...');
      return next();
    }

    // ✅ Check video progress with STRING user_id
    const progressResult = await pool.query(
      `SELECT watch_percentage, completed 
       FROM votteryy_video_watch_progress
       WHERE user_id = $1 AND election_id = $2`,
      [userId, electionId] // ✅ userId is now a string
    );

    console.log('📹 Progress check result:', progressResult.rows[0] || 'NO PROGRESS FOUND');

    if (progressResult.rows.length === 0) {
      console.log('❌ No progress record found');
      return res.status(403).json({
        error: 'Video watch requirement not met',
        required: true,
        minimumPercentage: election.minimum_watch_percentage,
        currentPercentage: 0,
      });
    }

    const progress = progressResult.rows[0];
    const minPercentage = parseFloat(election.minimum_watch_percentage);
    const currentPercentage = parseFloat(progress.watch_percentage); // ✅ Parse to number

    console.log('📊 Comparison:', {
      current: currentPercentage,
      required: minPercentage,
      completed: progress.completed
    });

    // ✅ Check BOTH completed flag AND percentage
    if (progress.completed || currentPercentage >= minPercentage) {
      console.log('✅ Video requirement met! Proceeding to vote...');
      return next();
    }

    console.log('❌ Video requirement NOT met');
    return res.status(403).json({
      error: 'Video watch requirement not met',
      required: true,
      minimumPercentage: minPercentage,
      currentPercentage: currentPercentage,
    });

  } catch (error) {
    console.error('❌ Video watch middleware error:', error);
    res.status(500).json({ error: 'Video watch verification failed' });
  }
};

export default videoWatch;