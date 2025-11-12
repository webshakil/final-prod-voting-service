// Get client IP address
// export function getClientIP(req) {
//   return req.headers['x-forwarded-for']?.split(',')[0] || 
//          req.connection.remoteAddress || 
//          req.socket.remoteAddress;
// }

export function getClientIP(req) {
  return req.ip || 
         req.headers['x-forwarded-for']?.split(',')[0] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         'unknown';
}

// Get user agent
// export function getUserAgent(req) {
//   return req.headers['user-agent'] || 'Unknown';
// }
export function getUserAgent(req) {
  return req.headers['user-agent'] || 'unknown';
}

// Format currency
export function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency
  }).format(amount);
}

// Calculate percentage
export function calculatePercentage(value, total) {
  if (total === 0) return 0;
  return ((value / total) * 100).toFixed(2);
}

// Generate OTP code
export function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

// Check if election is active

export function isElectionActive(election) {
  const now = new Date();
  const startDateTime = new Date(`${election.start_date}T${election.start_time || '00:00:00'}`);
  const endDateTime = new Date(`${election.end_date}T${election.end_time || '23:59:59'}`);
  
  // Check status (allow both 'published' and 'active')
  const allowedStatuses = ['published', 'active'];
  const statusValid = allowedStatuses.includes(election.status);
  
  // Check date range
  const dateValid = now >= startDateTime && now <= endDateTime;
  
  return statusValid && dateValid;
}

export function calculateElectionStatus(election) {
  const now = new Date();
  const startDateTime = new Date(`${election.start_date}T${election.start_time || '00:00:00'}`);
  const endDateTime = new Date(`${election.end_date}T${election.end_time || '23:59:59'}`);
  
  // Check DB status first
  if (election.status === 'draft') return 'draft';
  if (election.status === 'cancelled') return 'cancelled';
  
  // Check dates
  if (now < startDateTime) return 'scheduled';
  if (now >= startDateTime && now <= endDateTime) return 'active';
  if (now > endDateTime) return 'completed';
  
  return 'unknown';
}

export function getElectionStatusInfo(election) {
  const status = calculateElectionStatus(election);
  const now = new Date();
  const startDateTime = new Date(`${election.start_date}T${election.start_time || '00:00:00'}`);
  const endDateTime = new Date(`${election.end_date}T${election.end_time || '23:59:59'}`);
  
  const info = {
    status,
    canVote: status === 'active' && ['published', 'active'].includes(election.status),
    message: '',
    details: {},
  };
  
  switch (status) {
    case 'draft':
      info.message = 'Election is in draft mode';
      break;
    case 'scheduled':
      info.message = 'Election has not started yet';
      info.details.startsIn = startDateTime - now;
      info.details.startDate = startDateTime;
      break;
    case 'active':
      info.message = 'Election is currently active';
      info.details.endsIn = endDateTime - now;
      info.details.endDate = endDateTime;
      break;
    case 'completed':
      info.message = 'Election has ended';
      info.details.endedAgo = now - endDateTime;
      info.details.endDate = endDateTime;
      break;
    case 'cancelled':
      info.message = 'Election has been cancelled';
      break;
    default:
      info.message = 'Election status unknown';
  }
  
  return info;
}


export default {
  getClientIP,
  getUserAgent,
  formatCurrency,
  calculatePercentage,
  generateOTP,
  isElectionActive,
  calculateElectionStatus,
  getElectionStatusInfo
};