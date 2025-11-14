import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const PADDLE_API_BASE = process.env.PADDLE_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-api.paddle.com'
  : 'https://api.paddle.com';

const paddleClient = axios.create({
  baseURL: PADDLE_API_BASE,
  headers: {
    'Authorization': `Bearer ${process.env.PADDLE_API_KEY}`,
    'Content-Type': 'application/json'
  }
});

export const paddleConfig = {
  apiKey: process.env.PADDLE_API_KEY,
  environment: process.env.PADDLE_ENVIRONMENT || 'sandbox',
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET
};

export default paddleClient;