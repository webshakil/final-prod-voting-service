import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const PADDLE_API_BASE = process.env.PADDLE_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

export const paddleConfig = {
  apiKey: process.env.PADDLE_API_KEY,
  environment: process.env.PADDLE_ENVIRONMENT || 'sandbox',
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET,
  baseURL: PADDLE_API_BASE
};

// Don't export a pre-configured client, just the config
export default paddleConfig;