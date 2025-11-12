// src/middleware/videoWatch.js
import pool from '../config/database.js';

export const videoWatch = async (req, res, next) => {
  try {
    const { electionId } = req.params;
    const userId = req.user?.userId || req.headers['x-user-id'];

    // Get election
    const electionResult = await pool.query(
      `SELECT video_watch_required, minimum_watch_percentage 
       FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];

    // If video not required, skip check
    if (!election.video_watch_required) {
      return next();
    }

    // Check video progress
    const progressResult = await pool.query(
      `SELECT watch_percentage, completed 
       FROM votteryy_video_watch_progress
       WHERE user_id = $1 AND election_id = $2`,
      [userId, electionId]
    );

    if (progressResult.rows.length === 0) {
      return res.status(403).json({
        error: 'Video watch requirement not met',
        required: true,
        minimumPercentage: election.minimum_watch_percentage,
        currentPercentage: 0,
      });
    }

    const progress = progressResult.rows[0];
    const minPercentage = parseFloat(election.minimum_watch_percentage);

    if (progress.watch_percentage < minPercentage) {
      return res.status(403).json({
        error: 'Video watch requirement not met',
        required: true,
        minimumPercentage: minPercentage,
        currentPercentage: progress.watch_percentage,
      });
    }

    next();
  } catch (error) {
    console.error('Video watch check error:', error);
    res.status(500).json({ error: 'Video watch verification failed' });
  }
};
export default videoWatch
// import pool from '../config/database.js';

// const videoWatch = async (req, res, next) => {
//   try {
//     const { electionId } = req.params;
//     const userId = req.user.userId;

//     // Get election video requirements
//     const electionResult = await pool.query(
//       `SELECT video_watch_required, minimum_watch_percentage
//        FROM votteryyy_elections WHERE id = $1`,
//       [electionId]
//     );

//     if (electionResult.rows.length === 0) {
//       return res.status(404).json({ error: 'Election not found' });
//     }

//     const election = electionResult.rows[0];

//     // If video watch not required, skip
//     if (!election.video_watch_required) {
//       return next();
//     }

//     // Check if user completed video watch
//     const watchResult = await pool.query(
//       `SELECT completed, watch_percentage
//        FROM votteryy_video_watch_progress
//        WHERE user_id = $1 AND election_id = $2`,
//       [userId, electionId]
//     );

//     if (watchResult.rows.length === 0 || !watchResult.rows[0].completed) {
//       return res.status(403).json({ 
//         error: 'Video watch requirement not met',
//         required: true,
//         minimumPercentage: election.minimum_watch_percentage,
//         currentPercentage: watchResult.rows[0]?.watch_percentage || 0
//       });
//     }

//     next();

//   } catch (error) {
//     console.error('Video watch check error:', error);
//     res.status(500).json({ error: 'Video watch verification failed' });
//   }
// };

// export default videoWatch;