import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const ROLE_SERVICE_URL = process.env.ROLE_SERVICE_URL || 'http://localhost:3005';

const roleCheck = (allowedRoles = []) => {
  return async (req, res, next) => {
    try {
      // Extract user data from x-user-data header
      const userDataHeader = req.headers['x-user-data'];
      
      if (!userDataHeader) {
        console.log('❌ No x-user-data header found');
        return res.status(401).json({ error: 'User data required' });
      }

      let userData;
      try {
        userData = JSON.parse(userDataHeader);
      } catch (parseError) {
        console.error('❌ Failed to parse x-user-data header:', parseError);
        return res.status(400).json({ error: 'Invalid user data format' });
      }

      const userId = userData.userId;

      if (!userId) {
        console.log('❌ No userId in user data');
        return res.status(401).json({ error: 'User ID required' });
      }

      // Attach user to request
      req.user = {
        userId: userData.userId,
        email: userData.email,
        phone: userData.phone,
        roles: userData.roles || ['Voter'],
      };

      // ✅ FIXED: Normalize roles - extract base role name (remove parentheses and content)
      const normalizeRole = (role) => {
        // "Voter (Free)" -> "voter"
        // "Individual Election Creator (Free)" -> "individual election creator"
        return String(role)
          .replace(/\s*\([^)]*\)/g, '') // Remove anything in parentheses
          .toLowerCase()
          .trim();
      };

      const userRoles = (userData.roles || ['Voter']).map(normalizeRole);
      const normalizedAllowedRoles = allowedRoles.map(normalizeRole);

      console.log('🔍 Role check:', {
        userId,
        originalUserRoles: userData.roles,
        normalizedUserRoles: userRoles,
        normalizedAllowedRoles
      });

      // Check if user has any of the allowed roles
      const hasRole = normalizedAllowedRoles.some(role => userRoles.includes(role));

      if (!hasRole && allowedRoles.length > 0) {
        console.log('❌ Role check failed - insufficient permissions');
        return res.status(403).json({ 
          error: 'Insufficient permissions',
          required: allowedRoles,
          current: userData.roles
        });
      }

      console.log('✅ Role check passed');
      next();

    } catch (error) {
      console.error('❌ Role check error:', error);
      res.status(500).json({ error: 'Role verification failed' });
    }
  };
};

export default roleCheck;
// import axios from 'axios';
// import dotenv from 'dotenv';

// dotenv.config();

// const ROLE_SERVICE_URL = process.env.ROLE_SERVICE_URL || 'http://localhost:3005';

// const roleCheck = (allowedRoles = []) => {
//   return async (req, res, next) => {
//     try {
//       // ✅ Extract user data from x-user-data header (no token check)
//       const userDataHeader = req.headers['x-user-data'];
      
//       if (!userDataHeader) {
//         console.log('❌ No x-user-data header found');
//         return res.status(401).json({ error: 'User data required' });
//       }

//       let userData;
//       try {
//         userData = JSON.parse(userDataHeader);
//       } catch (parseError) {
//         console.error('❌ Failed to parse x-user-data header:', parseError);
//         return res.status(400).json({ error: 'Invalid user data format' });
//       }

//       const userId = userData.userId;

//       if (!userId) {
//         console.log('❌ No userId in user data');
//         return res.status(401).json({ error: 'User ID required' });
//       }

//       // Attach user to request
//       req.user = {
//         userId: userData.userId,
//         email: userData.email,
//         phone: userData.phone,
//         roles: userData.roles || ['Voter'],
//       };

//       // ✅ Use roles from header directly (faster, no extra API call)
//       const userRoles = (userData.roles || ['Voter']).map(r => String(r).toLowerCase().trim());
//       const normalizedAllowedRoles = allowedRoles.map(r => String(r).toLowerCase().trim());

//       console.log('🔍 Role check:', {
//         userId,
//         userRoles,
//         allowedRoles: normalizedAllowedRoles
//       });

//       // Check if user has any of the allowed roles
//       const hasRole = normalizedAllowedRoles.some(role => userRoles.includes(role));

//       if (!hasRole && allowedRoles.length > 0) {
//         console.log('❌ Role check failed - insufficient permissions');
//         return res.status(403).json({ 
//           error: 'Insufficient permissions',
//           required: allowedRoles,
//           current: userData.roles
//         });
//       }

//       console.log('✅ Role check passed');
//       next();

//     } catch (error) {
//       console.error('❌ Role check error:', error);
//       res.status(500).json({ error: 'Role verification failed' });
//     }
//   };
// };

// export default roleCheck;
// import axios from 'axios';
// import dotenv from 'dotenv';

// dotenv.config();

// const ROLE_SERVICE_URL = process.env.ROLE_SERVICE_URL || 'http://localhost:3005';

// const roleCheck = (allowedRoles = []) => {
//   return async (req, res, next) => {
//     try {
//       // Get user from request (set by auth service)
//       const userId = req.user?.userId;

//       if (!userId) {
//         return res.status(401).json({ error: 'Authentication required' });
//       }

//       // Call role service to get user roles
//       try {
//         const response = await axios.get(`${ROLE_SERVICE_URL}/api/roles/user/${userId}/roles`);
//         const userRoles = response.data.roles || [];

//         // Extract role names
//         const roleNames = userRoles.map(r => r.role_name);

//         // Check if user has any of the allowed roles
//         const hasRole = allowedRoles.some(role => roleNames.includes(role));

//         if (!hasRole && allowedRoles.length > 0) {
//           return res.status(403).json({ 
//             error: 'Insufficient permissions',
//             required: allowedRoles,
//             current: roleNames
//           });
//         }

//         // Attach roles to request
//         req.user.roles = roleNames;
//         next();

//       } catch (roleError) {
//         console.error('Role service error:', roleError.message);
//         // Default to voter role if role service is down
//         req.user.roles = ['voter'];
        
//         if (allowedRoles.length > 0 && !allowedRoles.includes('voter')) {
//           return res.status(403).json({ error: 'Role verification failed' });
//         }
        
//         next();
//       }

//     } catch (error) {
//       console.error('Role check error:', error);
//       res.status(500).json({ error: 'Role verification failed' });
//     }
//   };
// };

// export default roleCheck;