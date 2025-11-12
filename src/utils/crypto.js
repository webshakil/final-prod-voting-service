import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = process.env.ENCRYPTION_ALGORITHM || 'aes-256-cbc';
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex').slice(0, 32));
const IV_LENGTH = 16;

// Encrypt data
export function encrypt(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Decrypt data
export function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = parts.join(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Generate SHA-256 hash
export function generateHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
// export function generateHash(data) {
//   return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
// }

// Generate random bytes
export function generateSecureRandom(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// Generate RSA key pair
export function generateRSAKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });
  return { publicKey, privateKey };
}

// RSA Encrypt
export function rsaEncrypt(data, publicKey) {
  const buffer = Buffer.from(JSON.stringify(data));
  const encrypted = crypto.publicEncrypt(publicKey, buffer);
  return encrypted.toString('base64');
}

// RSA Decrypt
export function rsaDecrypt(encryptedData, privateKey) {
  const buffer = Buffer.from(encryptedData, 'base64');
  const decrypted = crypto.privateDecrypt(privateKey, buffer);
  return JSON.parse(decrypted.toString('utf8'));
}

// Create hash chain
// export function createHashChain(data, previousHash) {
//   const combinedData = JSON.stringify(data) + (previousHash || '');
//   return generateHash(combinedData);
// }
export function createHashChain(eventObject, previousHash) {
  const dataToHash = JSON.stringify(eventObject) + (previousHash || '');
  return crypto.createHash('sha256').update(dataToHash).digest('hex');
}

// Verify hash chain
export function verifyHashChain(data, hash, previousHash) {
  const expectedHash = createHashChain(data, previousHash);
  return expectedHash === hash;
}

export default {
  encrypt,
  decrypt,
  generateHash,
  generateSecureRandom,
  generateRSAKeyPair,
  rsaEncrypt,
  rsaDecrypt,
  createHashChain,
  verifyHashChain
};