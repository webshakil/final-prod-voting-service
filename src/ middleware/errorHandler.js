const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Joi validation errors
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Validation error',
      details: err.details.map(d => d.message)
    });
  }

  // Database errors
  if (err.code) {
    switch (err.code) {
      case '23505': // Unique violation
        return res.status(409).json({ error: 'Duplicate entry' });
      case '23503': // Foreign key violation
        return res.status(400).json({ error: 'Referenced resource not found' });
      case '23502': // Not null violation
        return res.status(400).json({ error: 'Required field missing' });
      default:
        return res.status(500).json({ error: 'Database error' });
    }
  }

  // Default error
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
};

export default errorHandler;