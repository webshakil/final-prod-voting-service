import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const paddleClient = axios.create({
  baseURL: 'https://vendors.paddle.com/api/2.0',
  headers: {
    'Content-Type': 'application/json'
  }
});

export const paddleConfig = {
  vendorId: process.env.PADDLE_VENDOR_ID,
  apiKey: process.env.PADDLE_API_KEY,
  publicKey: process.env.PADDLE_PUBLIC_KEY
};

export default paddleClient;