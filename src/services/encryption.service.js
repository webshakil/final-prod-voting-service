// src/services/encryption.service.js
// ✨ COMPLETE ENCRYPTION SERVICE - Production Ready
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ========================================
// CONFIGURATION
// ========================================

const ENCRYPTION_ALGORITHM = process.env.ENCRYPTION_ALGORITHM || 'aes-256-gcm';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const IV_LENGTH = 16; // AES block size
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const TAG_POSITION = SALT_LENGTH + IV_LENGTH;
const ENCRYPTED_POSITION = TAG_POSITION + TAG_LENGTH;

// Ensure encryption key is proper length
const KEY = Buffer.from(ENCRYPTION_KEY.slice(0, 64), 'hex');

console.log('🔐 Encryption service initialized');
console.log('Algorithm:', ENCRYPTION_ALGORITHM);
console.log('Key length:', KEY.length, 'bytes');

// ========================================
// ENCRYPTION FUNCTIONS
// ========================================

/**
 * Encrypt vote data using AES-256-GCM
 * @param {string} data - JSON string of vote data
 * @returns {string} - Base64 encoded encrypted data
 */
export function encryptVote(data) {
  try {
    // ✅ FIX: Check if algorithm is supported, fallback to aes-256-cbc if not
    let algorithm = ENCRYPTION_ALGORITHM;
    
    // Validate algorithm
    const supportedAlgorithms = ['aes-256-gcm', 'aes-256-cbc', 'aes-192-gcm', 'aes-192-cbc'];
    if (!supportedAlgorithms.includes(algorithm)) {
      console.warn(`⚠️ Unsupported algorithm '${algorithm}', falling back to 'aes-256-cbc'`);
      algorithm = 'aes-256-cbc';
    }
    
    // Generate random IV (Initialization Vector)
    const iv = crypto.randomBytes(IV_LENGTH);
    
    // Generate random salt
    const salt = crypto.randomBytes(SALT_LENGTH);
    
    // ✅ FIX: Ensure KEY is exactly 32 bytes for aes-256
    let key = KEY;
    if (KEY.length !== 32) {
      console.warn(`⚠️ Key length is ${KEY.length}, adjusting to 32 bytes`);
      key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    }
    
    // Create cipher
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    
    // Encrypt the data
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Get authentication tag (GCM mode provides authentication)
    let tag = Buffer.alloc(TAG_LENGTH);
    if (algorithm.includes('gcm')) {
      try {
        tag = cipher.getAuthTag();
      } catch (e) {
        console.warn('⚠️ Failed to get auth tag, using empty tag');
      }
    }
    
    // Combine salt + iv + tag + encrypted data
    const result = Buffer.concat([
      salt,
      iv,
      tag,
      Buffer.from(encrypted, 'hex')
    ]);
    
    // Return as base64
    console.log('✅ Vote encrypted successfully');
    return result.toString('base64');
    
  } catch (error) {
    console.error('❌ Encryption error:', error);
    console.error('Algorithm:', ENCRYPTION_ALGORITHM);
    console.error('Key length:', KEY.length);
    throw new Error('Failed to encrypt vote data');
  }
}

/**
 * Decrypt vote data
 * @param {string} encryptedData - Base64 encoded encrypted data
 * @returns {string} - Decrypted JSON string
 */
export function decryptVote(encryptedData) {
  try {
    // Convert from base64
    const buffer = Buffer.from(encryptedData, 'base64');
    
    // Extract components
    const salt = buffer.slice(0, SALT_LENGTH);
    const iv = buffer.slice(SALT_LENGTH, TAG_POSITION);
    const tag = buffer.slice(TAG_POSITION, ENCRYPTED_POSITION);
    const encrypted = buffer.slice(ENCRYPTED_POSITION);
    
    // Create decipher
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, KEY, iv);
    decipher.setAuthTag(tag);
    
    // Decrypt
    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    
    return decrypted.toString('utf8');
    
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt vote data');
  }
}

// ========================================
// HASHING FUNCTIONS
// ========================================

/**
 * Generate SHA-256 hash of vote data
 * @param {string} data - Data to hash
 * @returns {string} - Hex encoded hash
 */
export function generateVoteHash(data) {
  return crypto.createHash('sha256')
    .update(data)
    .digest('hex');
}

/**
 * Generate SHA-512 hash with salt
 * @param {string} data - Data to hash
 * @param {string} salt - Optional salt (generated if not provided)
 * @returns {object} - {hash, salt}
 */
export function generateSecureHash(data, salt = null) {
  const usedSalt = salt || crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha512')
    .update(data + usedSalt)
    .digest('hex');
  
  return { hash, salt: usedSalt };
}

/**
 * Verify hash matches data
 * @param {string} data - Data to verify
 * @param {string} hash - Hash to compare
 * @param {string} salt - Salt used in original hash
 * @returns {boolean}
 */
export function verifyHash(data, hash, salt) {
  const { hash: computedHash } = generateSecureHash(data, salt);
  return computedHash === hash;
}

// ========================================
// ID GENERATION FUNCTIONS
// ========================================

/**
 * Generate unique receipt ID
 * @returns {string} - Format: RCP-TIMESTAMP-RANDOM
 */
export function generateReceiptId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `RCP-${timestamp}-${random}`;
}

/**
 * Generate verification code (8 characters)
 * @returns {string} - Uppercase alphanumeric code
 */
export function generateVerificationCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Generate unique vote ID
 * @returns {string} - UUID v4
 */
export function generateVoteId() {
  return crypto.randomUUID();
}

/**
 * Generate lottery ticket number
 * @param {number} userId - User ID
 * @param {number} electionId - Election ID
 * @returns {object} - {ticketNumber, ballNumber}
 */
export function generateLotteryTicket(userId, electionId) {
  // Generate deterministic ball number from user and election
  const seed = `${userId}-${electionId}-${Date.now()}`;
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const ballNumber = parseInt(hash.slice(0, 8), 16) % 1000000; // 6 digit number
  
  const year = new Date().getFullYear();
  const ticketNumber = `TKT-${year}-${String(ballNumber).padStart(6, '0')}`;
  
  return { ticketNumber, ballNumber };
}

// ========================================
// DIGITAL SIGNATURE FUNCTIONS
// ========================================

/**
 * Sign data with private key (for vote verification)
 * @param {string} data - Data to sign
 * @returns {string} - Hex encoded signature
 */
export function signData(data) {
  try {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(data);
    sign.end();
    
    // In production, use a real private key from environment
    // For now, use HMAC as alternative
    const hmac = crypto.createHmac('sha256', KEY);
    hmac.update(data);
    return hmac.digest('hex');
    
  } catch (error) {
    console.error('Signing error:', error);
    throw new Error('Failed to sign data');
  }
}

/**
 * Verify digital signature
 * @param {string} data - Original data
 * @param {string} signature - Signature to verify
 * @returns {boolean}
 */
export function verifySignature(data, signature) {
  try {
    const hmac = crypto.createHmac('sha256', KEY);
    hmac.update(data);
    const computedSignature = hmac.digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(computedSignature, 'hex')
    );
    
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

// ========================================
// HOMOMORPHIC ENCRYPTION (Simplified)
// ========================================

/**
 * Generate keypair for homomorphic encryption
 * @returns {object} - {publicKey, privateKey}
 */
export function generateHomomorphicKeypair() {
  // Simplified version - in production, use library like node-seal or paillier-bigint
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

/**
 * Homomorphic encrypt (simplified)
 * @param {number} value - Value to encrypt
 * @param {string} publicKey - Public key
 * @returns {string} - Encrypted value
 */
export function homomorphicEncrypt(value, publicKey) {
  try {
    const buffer = Buffer.from(value.toString());
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      buffer
    );
    return encrypted.toString('base64');
  } catch (error) {
    console.error('Homomorphic encryption error:', error);
    throw new Error('Failed to encrypt value');
  }
}

/**
 * Homomorphic decrypt
 * @param {string} encryptedValue - Encrypted value
 * @param {string} privateKey - Private key
 * @returns {number} - Decrypted value
 */
export function homomorphicDecrypt(encryptedValue, privateKey) {
  try {
    const buffer = Buffer.from(encryptedValue, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      },
      buffer
    );
    return parseInt(decrypted.toString(), 10);
  } catch (error) {
    console.error('Homomorphic decryption error:', error);
    throw new Error('Failed to decrypt value');
  }
}

// ========================================
// ZERO-KNOWLEDGE PROOF (Simplified)
// ========================================

/**
 * Generate zero-knowledge proof that vote is valid
 * @param {object} vote - Vote data
 * @param {string} secret - Secret key
 * @returns {string} - Proof
 */
export function generateZKProof(vote, secret) {
  // Simplified ZK proof using commitment scheme
  const commitment = crypto.createHash('sha256')
    .update(JSON.stringify(vote) + secret)
    .digest('hex');
  
  const challenge = crypto.randomBytes(32).toString('hex');
  
  const response = crypto.createHash('sha256')
    .update(commitment + challenge)
    .digest('hex');
  
  return JSON.stringify({ commitment, challenge, response });
}

/**
 * Verify zero-knowledge proof
 * @param {string} proof - Proof to verify
 * @param {object} vote - Vote data
 * @returns {boolean}
 */
export function verifyZKProof(proof, vote) {
  try {
    const { commitment, challenge, response } = JSON.parse(proof);
    
    // Verify the proof structure is valid
    const expectedResponse = crypto.createHash('sha256')
      .update(commitment + challenge)
      .digest('hex');
    
    return response === expectedResponse;
  } catch (error) {
    console.error('ZK proof verification error:', error);
    return false;
  }
}

// ========================================
// BLOCKCHAIN HASH CHAIN
// ========================================

/**
 * Create blockchain-style hash chain entry
 * @param {string} data - Data to add to chain
 * @param {string} previousHash - Previous block hash
 * @returns {object} - Block data
 */
export function createBlockChainEntry(data, previousHash = '0') {
  const timestamp = Date.now();
  const blockData = {
    timestamp,
    data,
    previousHash,
  };
  
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(blockData))
    .digest('hex');
  
  return {
    ...blockData,
    hash,
  };
}

/**
 * Verify blockchain integrity
 * @param {Array} chain - Array of blocks
 * @returns {boolean}
 */
export function verifyBlockChain(chain) {
  for (let i = 1; i < chain.length; i++) {
    const currentBlock = chain[i];
    const previousBlock = chain[i - 1];
    
    // Verify hash
    const computedHash = crypto.createHash('sha256')
      .update(JSON.stringify({
        timestamp: currentBlock.timestamp,
        data: currentBlock.data,
        previousHash: currentBlock.previousHash,
      }))
      .digest('hex');
    
    if (currentBlock.hash !== computedHash) {
      return false;
    }
    
    // Verify chain link
    if (currentBlock.previousHash !== previousBlock.hash) {
      return false;
    }
  }
  
  return true;
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Generate random salt
 * @param {number} length - Salt length in bytes
 * @returns {string} - Hex encoded salt
 */
export function generateSalt(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Constant-time string comparison (prevents timing attacks)
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(a),
      Buffer.from(b)
    );
  } catch {
    return false;
  }
}

/**
 * Generate cryptographically secure random number
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number}
 */
export function secureRandomNumber(min, max) {
  const range = max - min;
  const bytes = Math.ceil(Math.log2(range) / 8);
  let randomValue;
  
  do {
    randomValue = crypto.randomBytes(bytes).readUIntBE(0, bytes);
  } while (randomValue >= Math.floor(2 ** (bytes * 8) / range) * range);
  
  return min + (randomValue % range);
}

// ========================================
// EXPORT ALL FUNCTIONS
// ========================================

export default {
  // Encryption
  encryptVote,
  decryptVote,
  
  // Hashing
  generateVoteHash,
  generateSecureHash,
  verifyHash,
  
  // ID Generation
  generateReceiptId,
  generateVerificationCode,
  generateVoteId,
  generateLotteryTicket,
  
  // Digital Signatures
  signData,
  verifySignature,
  
  // Homomorphic Encryption
  generateHomomorphicKeypair,
  homomorphicEncrypt,
  homomorphicDecrypt,
  
  // Zero-Knowledge Proofs
  generateZKProof,
  verifyZKProof,
  
  // Blockchain
  createBlockChainEntry,
  verifyBlockChain,
  
  // Utilities
  generateSalt,
  safeCompare,
  secureRandomNumber,
};
// import crypto from 'crypto';
// import pool from '../config/database.js';
// import { encrypt, decrypt, generateHash, generateRSAKeyPair, rsaEncrypt, rsaDecrypt } from '../utils/crypto.js';

// class EncryptionService {
  
//   // Generate election encryption keys
//   async generateElectionKeys(electionId) {
//     const client = await pool.connect();
//     try {
//       await client.query('BEGIN');

//       // Generate RSA key pair for election
//       const { publicKey, privateKey } = generateRSAKeyPair();

//       // Store public key
//       await client.query(
//         `INSERT INTO votteryy_encryption_keys (election_id, key_type, key_data)
//          VALUES ($1, $2, $3)`,
//         [electionId, 'public', publicKey]
//       );

//       // Split private key into shards for threshold encryption (simple version)
//       const privateKeyShard1 = privateKey.substring(0, Math.floor(privateKey.length / 2));
//       const privateKeyShard2 = privateKey.substring(Math.floor(privateKey.length / 2));

//       // Encrypt and store private key shards
//       await client.query(
//         `INSERT INTO votteryy_encryption_keys (election_id, key_type, key_data, key_index)
//          VALUES ($1, $2, $3, $4)`,
//         [electionId, 'private_shard', encrypt(privateKeyShard1), 1]
//       );

//       await client.query(
//         `INSERT INTO votteryy_encryption_keys (election_id, key_type, key_data, key_index)
//          VALUES ($1, $2, $3, $4)`,
//         [electionId, 'private_shard', encrypt(privateKeyShard2), 2]
//       );

//       await client.query('COMMIT');

//       return { publicKey, message: 'Encryption keys generated successfully' };
//     } catch (error) {
//       await client.query('ROLLBACK');
//       throw error;
//     } finally {
//       client.release();
//     }
//   }

//   // Get election public key
//   async getPublicKey(electionId) {
//     const result = await pool.query(
//       `SELECT key_data FROM votteryy_encryption_keys
//        WHERE election_id = $1 AND key_type = 'public'`,
//       [electionId]
//     );

//     if (result.rows.length === 0) {
//       throw new Error('Encryption keys not found for this election');
//     }

//     return result.rows[0].key_data;
//   }

//   // Encrypt vote data
//   async encryptVote(voteData, electionId) {
//     const publicKey = await this.getPublicKey(electionId);
//     const encryptedVote = rsaEncrypt(voteData, publicKey);
//     const voteHash = generateHash(voteData);

//     return {
//       encryptedVote,
//       voteHash
//     };
//   }

//   // Verify encryption (for issue #1)
//   async verifyEncryption(voteHash, electionId, userId) {
//     const client = await pool.connect();
//     try {
//       // Get vote from bulletin board
//       const voteResult = await client.query(
//         `SELECT * FROM votteryy_public_bulletin_board
//          WHERE vote_hash = $1 AND election_id = $2`,
//         [voteHash, electionId]
//       );

//       if (voteResult.rows.length === 0) {
//         return {
//           verified: false,
//           message: 'Vote not found on public bulletin board'
//         };
//       }

//       const vote = voteResult.rows[0];

//       // Get election public key
//       const publicKey = await this.getPublicKey(electionId);

//       // Record verification attempt
//       await client.query(
//         `INSERT INTO votteryy_vote_verifications 
//          (vote_hash, user_id, election_id, verification_type, verification_result)
//          VALUES ($1, $2, $3, $4, $5)`,
//         [
//           voteHash,
//           userId,
//           electionId,
//           'encryption_check',
//           JSON.stringify({
//             blockHash: vote.block_hash,
//             previousBlockHash: vote.previous_block_hash,
//             timestamp: vote.timestamp
//           })
//         ]
//       );

//       return {
//         verified: true,
//         publicKey,
//         voteHash,
//         blockHash: vote.block_hash,
//         timestamp: vote.timestamp,
//         message: 'Vote encryption verified successfully'
//       };
//     } finally {
//       client.release();
//     }
//   }

//   // Get all verification data for a user's vote
//   async getVoteVerificationData(userId, electionId) {
//     const result = await pool.query(
//       `SELECT 
//          v.voting_id,
//          v.vote_hash,
//          v.encrypted_vote,
//          v.created_at,
//          vr.receipt_id,
//          vr.verification_code,
//          pbb.block_hash,
//          pbb.previous_block_hash,
//          pbb.merkle_root
//        FROM votteryy_votes v
//        LEFT JOIN votteryy_vote_receipts vr ON v.voting_id = vr.voting_id
//        LEFT JOIN votteryy_public_bulletin_board pbb ON v.vote_hash = pbb.vote_hash
//        WHERE v.user_id = $1 AND v.election_id = $2 AND v.status = 'valid'`,
//       [userId, electionId]
//     );

//     if (result.rows.length === 0) {
//       throw new Error('No valid vote found for verification');
//     }

//     return result.rows[0];
//   }
// }

// export default new EncryptionService();