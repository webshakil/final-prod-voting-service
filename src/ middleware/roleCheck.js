import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ROLE_SERVICE_URL = process.env.ROLE_SERVICE_URL || 'http://localhost:5005';

const roleCheck = (allowedRoles = []) => {
  return async (req, res, next) => {
    try {
      // Get user from request (set by auth service)
      const userId = req.user?.userId;

      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      // Call role service to get user roles
      try {
        const response = await axios.get(`${ROLE_SERVICE_URL}/api/roles/user/${userId}/roles`);
        const userRoles = response.data.roles || [];

        // Extract role names
        const roleNames = userRoles.map(r => r.role_name);

        // Check if user has any of the allowed roles
        const hasRole = allowedRoles.some(role => roleNames.includes(role));

        if (!hasRole && allowedRoles.length > 0) {
          return res.status(403).json({ 
            error: 'Insufficient permissions',
            required: allowedRoles,
            current: roleNames
          });
        }

        // Attach roles to request
        req.user.roles = roleNames;
        next();

      } catch (roleError) {
        console.error('Role service error:', roleError.message);
        // Default to voter role if role service is down
        req.user.roles = ['voter'];
        
        if (allowedRoles.length > 0 && !allowedRoles.includes('voter')) {
          return res.status(403).json({ error: 'Role verification failed' });
        }
        
        next();
      }

    } catch (error) {
      console.error('Role check error:', error);
      res.status(500).json({ error: 'Role verification failed' });
    }
  };
};

export default roleCheck;