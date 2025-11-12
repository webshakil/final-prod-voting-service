import pool from '../config/database.js';

const electionAccess = async (req, res, next) => {
  try {
    const { electionId } = req.params;
    const userId = req.user.userId;

    // Get election
    const electionResult = await pool.query(
      `SELECT * FROM votteryyy_elections WHERE id = $1`,
      [electionId]
    );

    if (electionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Election not found' });
    }

    const election = electionResult.rows[0];

    // Check permission type
    switch (election.permission_type) {
      case 'public':
        // Anyone can access
        break;

      case 'country_specific':
        // Check user's country
        const userResult = await pool.query(
          `SELECT country FROM votteryy_user_details WHERE user_id = $1`,
          [userId]
        );

        if (userResult.rows.length === 0) {
          return res.status(403).json({ error: 'User profile required' });
        }

        const userCountry = userResult.rows[0].country;
        const allowedCountries = election.allowed_countries || [];

        if (!allowedCountries.includes(userCountry)) {
          return res.status(403).json({ error: 'Election not available in your country' });
        }
        break;

      case 'specific_group':
        // Check group membership
        const groupCheck = await pool.query(
          `SELECT vgm.* FROM votteryy_voter_group_members vgm
           JOIN votteryy_election_group_access ega ON vgm.group_id = ega.group_id
           WHERE ega.election_id = $1 AND vgm.user_id = $2`,
          [electionId, userId]
        );

        if (groupCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Group membership required' });
        }
        break;

      case 'organization_only':
        // Check organization membership
        const orgCheck = await pool.query(
          `SELECT * FROM votteryy_organization_members
           WHERE organization_id = $1 AND user_id = $2`,
          [election.organization_id, userId]
        );

        if (orgCheck.rows.length === 0) {
          return res.status(403).json({ error: 'Organization membership required' });
        }
        break;
    }

    // Attach election to request
    req.election = election;
    next();

  } catch (error) {
    console.error('Election access check error:', error);
    res.status(500).json({ error: 'Access verification failed' });
  }
};

export default electionAccess;