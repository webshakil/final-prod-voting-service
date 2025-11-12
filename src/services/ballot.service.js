import pool from '../config/database.js';

class BallotService {

  // Get election ballot with questions and options
  async getElectionBallot(electionId) {
    const client = await pool.connect();
    try {
      // Get election details
      const electionResult = await client.query(
        `SELECT * FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      if (electionResult.rows.length === 0) {
        throw new Error('Election not found');
      }

      const election = electionResult.rows[0];

      // Get questions with options
      const questionsResult = await client.query(
        `SELECT * FROM votteryy_election_questions 
         WHERE election_id = $1 
         ORDER BY question_order ASC`,
        [electionId]
      );

      const questions = [];

      for (const question of questionsResult.rows) {
        // Get options for this question
        const optionsResult = await client.query(
          `SELECT * FROM votteryy_election_options 
           WHERE question_id = $1 
           ORDER BY option_order ASC`,
          [question.id]
        );

        questions.push({
          ...question,
          options: optionsResult.rows
        });
      }

      return {
        election,
        questions,
        votingType: election.voting_type
      };
    } finally {
      client.release();
    }
  }

  // Validate vote based on voting type
  validateVote(votingType, answers, questions) {
    const errors = [];

    for (const question of questions) {
      const answer = answers[question.id];

      if (!answer && question.is_required) {
        errors.push(`Question ${question.id} is required`);
        continue;
      }

      if (!answer) continue;

      switch (votingType) {
        case 'plurality':
          // Single selection only
          if (!Number.isInteger(answer)) {
            errors.push(`Question ${question.id}: Plurality voting requires single selection`);
          }
          // Verify option exists
          const optionExists = question.options.some(opt => opt.id === answer);
          if (!optionExists) {
            errors.push(`Question ${question.id}: Invalid option selected`);
          }
          break;

        case 'ranked_choice':
          // Array of ranked options
          if (!Array.isArray(answer)) {
            errors.push(`Question ${question.id}: Ranked choice requires array of rankings`);
            break;
          }
          
          const ranks = new Set();
          for (const ranking of answer) {
            if (!ranking.optionId || !ranking.rank) {
              errors.push(`Question ${question.id}: Invalid ranking format`);
              break;
            }
            
            // Check for duplicate ranks
            if (ranks.has(ranking.rank)) {
              errors.push(`Question ${question.id}: Duplicate rank ${ranking.rank}`);
              break;
            }
            ranks.add(ranking.rank);

            // Verify option exists
            const optionExists = question.options.some(opt => opt.id === ranking.optionId);
            if (!optionExists) {
              errors.push(`Question ${question.id}: Invalid option in ranking`);
            }
          }
          break;

        case 'approval':
          // Array of approved option IDs
          if (!Array.isArray(answer)) {
            errors.push(`Question ${question.id}: Approval voting requires array of approved options`);
            break;
          }

          for (const optionId of answer) {
            const optionExists = question.options.some(opt => opt.id === optionId);
            if (!optionExists) {
              errors.push(`Question ${question.id}: Invalid option in approval list`);
            }
          }
          break;

        default:
          errors.push(`Unknown voting type: ${votingType}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // Calculate plurality voting results
  async calculatePluralityResults(electionId) {
    const result = await pool.query(
      `SELECT 
         eq.id as question_id,
         eq.question_text,
         eo.id as option_id,
         eo.option_text,
         COUNT(v.id) as vote_count
       FROM votteryy_election_questions eq
       JOIN votteryy_election_options eo ON eq.id = eo.question_id
       LEFT JOIN votteryy_votes v ON v.election_id = $1 
         AND v.status = 'valid'
         AND v.answers->eq.id::text = to_jsonb(eo.id)
       WHERE eq.election_id = $1
       GROUP BY eq.id, eq.question_text, eo.id, eo.option_text
       ORDER BY eq.question_order, eo.option_order`,
      [electionId]
    );

    // Group by question
    const resultsByQuestion = {};
    for (const row of result.rows) {
      if (!resultsByQuestion[row.question_id]) {
        resultsByQuestion[row.question_id] = {
          questionId: row.question_id,
          questionText: row.question_text,
          options: []
        };
      }
      resultsByQuestion[row.question_id].options.push({
        optionId: row.option_id,
        optionText: row.option_text,
        voteCount: parseInt(row.vote_count)
      });
    }

    return Object.values(resultsByQuestion);
  }

  // Calculate ranked choice voting results with elimination rounds
  async calculateRankedChoiceResults(electionId, questionId) {
    const client = await pool.connect();
    try {
      // Get all votes for this question
      const votesResult = await client.query(
        `SELECT v.answers->$1::text as rankings
         FROM votteryy_votes v
         WHERE v.election_id = $2 AND v.status = 'valid'
         AND v.answers ? $1::text`,
        [questionId.toString(), electionId]
      );

      if (votesResult.rows.length === 0) {
        return { rounds: [], winner: null };
      }

      // Get options
      const optionsResult = await client.query(
        `SELECT id, option_text FROM votteryy_election_options 
         WHERE question_id = $1`,
        [questionId]
      );

      let remainingCandidates = optionsResult.rows.map(opt => opt.id);
      const rounds = [];
      const totalVotes = votesResult.rows.length;
      const majorityThreshold = Math.floor(totalVotes / 2) + 1;

      let roundNumber = 1;

      while (remainingCandidates.length > 1) {
        // Count first-choice votes for remaining candidates
        const voteCounts = {};
        remainingCandidates.forEach(candidateId => {
          voteCounts[candidateId] = 0;
        });

        for (const vote of votesResult.rows) {
          const rankings = vote.rankings;
          if (!rankings || !Array.isArray(rankings)) continue;

          // Find highest-ranked remaining candidate
          const sortedRankings = rankings
            .filter(r => remainingCandidates.includes(r.optionId))
            .sort((a, b) => a.rank - b.rank);

          if (sortedRankings.length > 0) {
            const topChoice = sortedRankings[0].optionId;
            voteCounts[topChoice]++;
          }
        }

        // Check for majority winner
        const maxVotes = Math.max(...Object.values(voteCounts));
        const leader = Object.keys(voteCounts).find(id => voteCounts[id] === maxVotes);

        rounds.push({
          round: roundNumber,
          voteCounts: voteCounts,
          eliminated: null,
          winner: maxVotes >= majorityThreshold ? parseInt(leader) : null
        });

        if (maxVotes >= majorityThreshold) {
          // We have a winner
          const winnerOption = optionsResult.rows.find(opt => opt.id === parseInt(leader));
          return {
            rounds,
            winner: {
              optionId: parseInt(leader),
              optionText: winnerOption.option_text,
              finalVotes: maxVotes,
              totalVotes
            }
          };
        }

        // Eliminate candidate with fewest votes
        const minVotes = Math.min(...Object.values(voteCounts));
        const eliminated = Object.keys(voteCounts).find(id => voteCounts[id] === minVotes);
        
        remainingCandidates = remainingCandidates.filter(id => id !== parseInt(eliminated));
        rounds[rounds.length - 1].eliminated = parseInt(eliminated);

        roundNumber++;

        // Prevent infinite loop
        if (roundNumber > 50) {
          break;
        }
      }

      // If we get here, last remaining candidate wins
      const winnerId = remainingCandidates[0];
      const winnerOption = optionsResult.rows.find(opt => opt.id === winnerId);

      return {
        rounds,
        winner: {
          optionId: winnerId,
          optionText: winnerOption.option_text,
          finalVotes: rounds[rounds.length - 1].voteCounts[winnerId],
          totalVotes
        }
      };
    } finally {
      client.release();
    }
  }

  // Calculate approval voting results
  async calculateApprovalResults(electionId) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT 
           eq.id as question_id,
           eq.question_text,
           eo.id as option_id,
           eo.option_text,
           COUNT(DISTINCT v.id) FILTER (
             WHERE v.answers->eq.id::text @> to_jsonb(eo.id)
           ) as approval_count,
           COUNT(DISTINCT v.id) as total_votes
         FROM votteryy_election_questions eq
         JOIN votteryy_election_options eo ON eq.id = eo.question_id
         LEFT JOIN votteryy_votes v ON v.election_id = $1 AND v.status = 'valid'
         WHERE eq.election_id = $1
         GROUP BY eq.id, eq.question_text, eo.id, eo.option_text
         ORDER BY eq.question_order, approval_count DESC`,
        [electionId]
      );

      // Group by question
      const resultsByQuestion = {};
      for (const row of result.rows) {
        if (!resultsByQuestion[row.question_id]) {
          resultsByQuestion[row.question_id] = {
            questionId: row.question_id,
            questionText: row.question_text,
            totalVotes: parseInt(row.total_votes),
            options: []
          };
        }
        
        const approvalCount = parseInt(row.approval_count);
        const totalVotes = parseInt(row.total_votes);
        const approvalPercentage = totalVotes > 0 ? ((approvalCount / totalVotes) * 100).toFixed(2) : 0;

        resultsByQuestion[row.question_id].options.push({
          optionId: row.option_id,
          optionText: row.option_text,
          approvalCount,
          approvalPercentage: parseFloat(approvalPercentage)
        });
      }

      return Object.values(resultsByQuestion);
    } finally {
      client.release();
    }
  }

  // Get real-time results (if enabled)
  async getLiveResults(electionId) {
    const client = await pool.connect();
    try {
      // Check if live results are enabled
      const visibilityResult = await client.query(
        `SELECT visibility_status FROM votteryy_results_visibility
         WHERE election_id = $1`,
        [electionId]
      );

      if (visibilityResult.rows.length === 0 || visibilityResult.rows[0].visibility_status === 'hidden') {
        return { visible: false, message: 'Live results are hidden for this election' };
      }

      // Get election voting type
      const electionResult = await client.query(
        `SELECT voting_type FROM votteryyy_elections WHERE id = $1`,
        [electionId]
      );

      const votingType = electionResult.rows[0].voting_type;

      let results;
      switch (votingType) {
        case 'plurality':
          results = await this.calculatePluralityResults(electionId);
          break;
        case 'approval':
          results = await this.calculateApprovalResults(electionId);
          break;
        case 'ranked_choice':
          // For ranked choice, calculate for each question
          const questionsResult = await client.query(
            `SELECT id FROM votteryy_election_questions WHERE election_id = $1`,
            [electionId]
          );
          results = [];
          for (const question of questionsResult.rows) {
            const rcvResult = await this.calculateRankedChoiceResults(electionId, question.id);
            results.push({ questionId: question.id, ...rcvResult });
          }
          break;
        default:
          throw new Error('Unknown voting type');
      }

      return {
        visible: true,
        votingType,
        results
      };
    } finally {
      client.release();
    }
  }

  // Toggle results visibility (can only go from hidden to visible)
  async toggleResultsVisibility(electionId, newStatus, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current status
      const currentResult = await client.query(
        `SELECT visibility_status, change_history FROM votteryy_results_visibility
         WHERE election_id = $1`,
        [electionId]
      );

      let currentStatus = 'hidden';
      let changeHistory = [];

      if (currentResult.rows.length > 0) {
        currentStatus = currentResult.rows[0].visibility_status;
        changeHistory = currentResult.rows[0].change_history || [];
      }

      // Prevent changing from visible to hidden
      if (currentStatus === 'visible' && newStatus === 'hidden') {
        throw new Error('Cannot change visibility from visible to hidden');
      }

      // Update visibility
      const historyEntry = {
        status: newStatus,
        timestamp: new Date().toISOString(),
        changed_by: userId
      };

      changeHistory.push(historyEntry);

      await client.query(
        `INSERT INTO votteryy_results_visibility 
         (election_id, visibility_status, changed_at, changed_by, change_history)
         VALUES ($1, $2, CURRENT_TIMESTAMP, $3, $4)
         ON CONFLICT (election_id) 
         DO UPDATE SET 
           visibility_status = $2,
           changed_at = CURRENT_TIMESTAMP,
           changed_by = $3,
           change_history = $4`,
        [electionId, newStatus, userId, JSON.stringify(changeHistory)]
      );

      await client.query('COMMIT');

      return { success: true, newStatus, changeHistory };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default new BallotService();