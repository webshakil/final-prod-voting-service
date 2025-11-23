// utils/paymentConfigHelper.js
import crypto from 'crypto';
import pool from '../config/database.js';

// Encryption configuration - AES-256
const ENCRYPTION_KEY = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY || 'vottery-payment-config-secret-key-32b';
const ALGORITHM = 'aes-256-cbc';

/**
 * Encrypt sensitive data using AES-256
 */
function encrypt(text) {
  if (!text) return '';
  
  const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt sensitive data
 */
// utils/paymentConfigHelper.js

/**
 * Decrypt sensitive data
 */
function decrypt(encryptedText) {
  if (!encryptedText) return '';
  
  try {
    // ✅ Check if data is encrypted (has ':' separator)
    if (!encryptedText.includes(':')) {
      // Plain text - return as is
      console.log('⚠️ Data not encrypted, returning plain text');
      return encryptedText;
    }
    
    const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
    const parts = encryptedText.split(':');
    
    // ✅ Validate IV length
    if (parts[0].length !== 32) {
      console.log('⚠️ Invalid IV length, treating as plain text');
      return encryptedText;
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('❌ Decryption error:', error.message);
    // Return original text if decryption fails
    return encryptedText;
  }
}

/**
 * Get config value from database
 */
export async function getConfigFromDB(configKey) {
  try {
    const result = await pool.query(
      'SELECT config_value FROM votteryy_payment_gateway_configs WHERE config_key = $1 AND is_active = true',
      [configKey]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const encryptedValue = result.rows[0].config_value;
    return decrypt(encryptedValue);
  } catch (error) {
    console.error('❌ Error fetching config from DB:', error);
    return null;
  }
}

/**
 * Save config value to database
 */
async function saveConfigToDB(configKey, configValue, isSecret = false) {
  try {
    const encryptedValue = encrypt(configValue);
    
    const result = await pool.query(
      `INSERT INTO votteryy_payment_gateway_configs (config_key, config_value, is_secret, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (config_key) 
       DO UPDATE SET config_value = $2, is_secret = $3, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [configKey, encryptedValue, isSecret]
    );
    
    return result.rows[0];
  } catch (error) {
    console.error('❌ Error saving config to DB:', error);
    throw error;
  }
}

/**
 * Get Stripe secret key (DB first, fallback to ENV)
 */
export async function getStripeSecretKey() {
  try {
    const stripeEnabled = await getConfigFromDB('stripe_enabled');
    if (stripeEnabled === 'false') {
      throw new Error('Stripe is disabled');
    }
    
    const stripeMode = await getConfigFromDB('stripe_mode') || 'test';
    const configKey = stripeMode === 'live' ? 'stripe_live_secret_key' : 'stripe_test_secret_key';
    const dbKey = await getConfigFromDB(configKey);
    
    if (dbKey) {
      console.log('✅ Using Stripe key from database');
      return dbKey;
    }
  } catch (error) {
    console.warn('⚠️ Database config failed, using ENV fallback');
  }
  
  console.log('📋 Using Stripe key from ENV');
  return process.env.STRIPE_SECRET_KEY;
}

/**
 * Get all payment configs for admin panel
 */
export async function getAllPaymentConfigs() {
  try {
    const result = await pool.query(
      'SELECT config_key, config_value, is_secret, is_active FROM votteryy_payment_gateway_configs WHERE is_active = true'
    );
    
    const configs = {};
    
    for (const row of result.rows) {
      configs[row.config_key] = decrypt(row.config_value);
    }
    
    return configs;
  } catch (error) {
    console.error('❌ Error fetching all configs:', error);
    throw error;
  }
}

/**
 * Get public keys for frontend
 */
export async function getPublicPaymentKeys() {
  try {
    const stripeMode = await getConfigFromDB('stripe_mode') || 'test';
    const paddleMode = await getConfigFromDB('paddle_mode') || 'sandbox';
    
    const stripePublishableKey = stripeMode === 'live'
      ? await getConfigFromDB('stripe_live_publishable_key')
      : await getConfigFromDB('stripe_test_publishable_key');
    
    const paddleClientToken = paddleMode === 'live'
      ? await getConfigFromDB('paddle_live_client_token')
      : await getConfigFromDB('paddle_sandbox_client_token');
    
    return {
      stripe: {
        enabled: (await getConfigFromDB('stripe_enabled')) === 'true',
        mode: stripeMode,
        publishableKey: stripePublishableKey || process.env.VITE_STRIPE_PUBLIC_KEY,
      },
      paddle: {
        enabled: (await getConfigFromDB('paddle_enabled')) === 'true',
        mode: paddleMode,
        vendorId: await getConfigFromDB('paddle_vendor_id'),
        clientToken: paddleClientToken || process.env.VITE_PADDLE_CLIENT_TOKEN,
      }
    };
  } catch (error) {
    console.error('❌ Error fetching public keys:', error);
    return {
      stripe: {
        enabled: true,
        mode: 'test',
        publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY
      },
      paddle: {
        enabled: false,
        mode: 'sandbox',
        vendorId: null,
        clientToken: null
      }
    };
  }
}

/**
 * Save all payment configs (from admin UI)
 */
export async function saveAllPaymentConfigs(configData) {
  const configsToSave = [
    { key: 'stripe_enabled', value: String(configData.stripe_enabled), secret: false },
    { key: 'stripe_mode', value: configData.stripe_mode, secret: false },
    { key: 'stripe_test_secret_key', value: configData.stripe_test_secret_key, secret: true },
    { key: 'stripe_test_publishable_key', value: configData.stripe_test_publishable_key, secret: false },
    { key: 'stripe_live_secret_key', value: configData.stripe_live_secret_key, secret: true },
    { key: 'stripe_live_publishable_key', value: configData.stripe_live_publishable_key, secret: false },
    { key: 'stripe_webhook_secret', value: configData.stripe_webhook_secret, secret: true },
    { key: 'stripe_client_secret', value: configData.stripe_client_secret, secret: false },
    
    { key: 'paddle_enabled', value: String(configData.paddle_enabled), secret: false },
    { key: 'paddle_mode', value: configData.paddle_mode, secret: false },
    { key: 'paddle_vendor_id', value: configData.paddle_vendor_id, secret: false },
    { key: 'paddle_sandbox_api_key', value: configData.paddle_sandbox_api_key, secret: true },
    { key: 'paddle_live_api_key', value: configData.paddle_live_api_key, secret: true },
    { key: 'paddle_sandbox_client_token', value: configData.paddle_sandbox_client_token, secret: false },
    { key: 'paddle_live_client_token', value: configData.paddle_live_client_token, secret: false },
    { key: 'paddle_webhook_secret', value: configData.paddle_webhook_secret, secret: true },
  ];
  
  const results = [];
  
  for (const config of configsToSave) {
    if (config.value) {
      const result = await saveConfigToDB(config.key, config.value, config.secret);
      results.push(result);
    }
  }
  
  console.log(`✅ Saved ${results.length} payment configurations to database`);
  
  return results;
}

export default {
  getStripeSecretKey,
  getAllPaymentConfigs,
  getPublicPaymentKeys,
  saveAllPaymentConfigs,
  getConfigFromDB
};
// // utils/paymentConfigHelper.js
// import crypto from 'crypto';
// import { query } from '../config/database.js';

// // Encryption configuration - AES-256
// const ENCRYPTION_KEY = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY || 'vottery-payment-config-secret-key-32b';
// const ALGORITHM = 'aes-256-cbc';

// /**
//  * Encrypt sensitive data using AES-256
//  */
// function encrypt(text) {
//   if (!text) return '';
  
//   const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
//   const iv = crypto.randomBytes(16);
//   const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
//   let encrypted = cipher.update(text, 'utf8', 'hex');
//   encrypted += cipher.final('hex');
  
//   return iv.toString('hex') + ':' + encrypted;
// }

// /**
//  * Decrypt sensitive data
//  */
// function decrypt(encryptedText) {
//   if (!encryptedText) return '';
  
//   try {
//     const key = crypto.createHash('sha256').update(ENCRYPTION_KEY).digest();
//     const parts = encryptedText.split(':');
//     const iv = Buffer.from(parts[0], 'hex');
//     const encrypted = parts[1];
    
//     const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
//     let decrypted = decipher.update(encrypted, 'hex', 'utf8');
//     decrypted += decipher.final('utf8');
    
//     return decrypted;
//   } catch (error) {
//     console.error('❌ Decryption error:', error);
//     return '';
//   }
// }

// /**
//  * Get config value from database
//  */
// export async function getConfigFromDB(configKey) {
//   try {
//     const result = await query(
//       'SELECT config_value FROM votteryy_payment_gateway_configs WHERE config_key = $1 AND is_active = true',
//       [configKey]
//     );
    
//     if (result.rows.length === 0) {
//       return null;
//     }
    
//     const encryptedValue = result.rows[0].config_value;
//     return decrypt(encryptedValue);
//   } catch (error) {
//     console.error('❌ Error fetching config from DB:', error);
//     return null;
//   }
// }

// /**
//  * Save config value to database
//  */
// async function saveConfigToDB(configKey, configValue, isSecret = false) {
//   try {
//     const encryptedValue = encrypt(configValue);
    
//     const result = await query(
//       `INSERT INTO votteryy_payment_gateway_configs (config_key, config_value, is_secret, is_active)
//        VALUES ($1, $2, $3, true)
//        ON CONFLICT (config_key) 
//        DO UPDATE SET config_value = $2, is_secret = $3, updated_at = CURRENT_TIMESTAMP
//        RETURNING *`,
//       [configKey, encryptedValue, isSecret]
//     );
    
//     return result.rows[0];
//   } catch (error) {
//     console.error('❌ Error saving config to DB:', error);
//     throw error;
//   }
// }

// /**
//  * Get Stripe secret key (DB first, fallback to ENV)
//  */
// export async function getStripeSecretKey() {
//   try {
//     const stripeEnabled = await getConfigFromDB('stripe_enabled');
//     if (stripeEnabled === 'false') {
//       throw new Error('Stripe is disabled');
//     }
    
//     const stripeMode = await getConfigFromDB('stripe_mode') || 'test';
//     const configKey = stripeMode === 'live' ? 'stripe_live_secret_key' : 'stripe_test_secret_key';
//     const dbKey = await getConfigFromDB(configKey);
    
//     if (dbKey) {
//       console.log('✅ Using Stripe key from database');
//       return dbKey;
//     }
//   } catch (error) {
//     console.warn('⚠️ Database config failed, using ENV fallback');
//   }
  
//   console.log('📋 Using Stripe key from ENV');
//   return process.env.STRIPE_SECRET_KEY;
// }

// /**
//  * Get all payment configs for admin panel
//  */
// export async function getAllPaymentConfigs() {
//   try {
//     const result = await query(
//       'SELECT config_key, config_value, is_secret, is_active FROM votteryy_payment_gateway_configs WHERE is_active = true'
//     );
    
//     const configs = {};
    
//     for (const row of result.rows) {
//       configs[row.config_key] = decrypt(row.config_value);
//     }
    
//     return configs;
//   } catch (error) {
//     console.error('❌ Error fetching all configs:', error);
//     throw error;
//   }
// }

// /**
//  * Get public keys for frontend
//  */
// export async function getPublicPaymentKeys() {
//   try {
//     const stripeMode = await getConfigFromDB('stripe_mode') || 'test';
//     const paddleMode = await getConfigFromDB('paddle_mode') || 'sandbox';
    
//     const stripePublishableKey = stripeMode === 'live'
//       ? await getConfigFromDB('stripe_live_publishable_key')
//       : await getConfigFromDB('stripe_test_publishable_key');
    
//     const paddleClientToken = paddleMode === 'live'
//       ? await getConfigFromDB('paddle_live_client_token')
//       : await getConfigFromDB('paddle_sandbox_client_token');
    
//     return {
//       stripe: {
//         enabled: (await getConfigFromDB('stripe_enabled')) === 'true',
//         mode: stripeMode,
//         publishableKey: stripePublishableKey || process.env.VITE_STRIPE_PUBLIC_KEY,
//       },
//       paddle: {
//         enabled: (await getConfigFromDB('paddle_enabled')) === 'true',
//         mode: paddleMode,
//         vendorId: await getConfigFromDB('paddle_vendor_id'),
//         clientToken: paddleClientToken || process.env.VITE_PADDLE_CLIENT_TOKEN,
//       }
//     };
//   } catch (error) {
//     console.error('❌ Error fetching public keys:', error);
//     return {
//       stripe: {
//         enabled: true,
//         mode: 'test',
//         publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY
//       },
//       paddle: {
//         enabled: false,
//         mode: 'sandbox',
//         vendorId: null,
//         clientToken: null
//       }
//     };
//   }
// }

// /**
//  * Save all payment configs (from admin UI)
//  */
// export async function saveAllPaymentConfigs(configData) {
//   const configsToSave = [
//     { key: 'stripe_enabled', value: String(configData.stripe_enabled), secret: false },
//     { key: 'stripe_mode', value: configData.stripe_mode, secret: false },
//     { key: 'stripe_test_secret_key', value: configData.stripe_test_secret_key, secret: true },
//     { key: 'stripe_test_publishable_key', value: configData.stripe_test_publishable_key, secret: false },
//     { key: 'stripe_live_secret_key', value: configData.stripe_live_secret_key, secret: true },
//     { key: 'stripe_live_publishable_key', value: configData.stripe_live_publishable_key, secret: false },
//     { key: 'stripe_webhook_secret', value: configData.stripe_webhook_secret, secret: true },
//     { key: 'stripe_client_secret', value: configData.stripe_client_secret, secret: false },
    
//     { key: 'paddle_enabled', value: String(configData.paddle_enabled), secret: false },
//     { key: 'paddle_mode', value: configData.paddle_mode, secret: false },
//     { key: 'paddle_vendor_id', value: configData.paddle_vendor_id, secret: false },
//     { key: 'paddle_sandbox_api_key', value: configData.paddle_sandbox_api_key, secret: true },
//     { key: 'paddle_live_api_key', value: configData.paddle_live_api_key, secret: true },
//     { key: 'paddle_sandbox_client_token', value: configData.paddle_sandbox_client_token, secret: false },
//     { key: 'paddle_live_client_token', value: configData.paddle_live_client_token, secret: false },
//     { key: 'paddle_webhook_secret', value: configData.paddle_webhook_secret, secret: true },
//   ];
  
//   const results = [];
  
//   for (const config of configsToSave) {
//     if (config.value) {
//       const result = await saveConfigToDB(config.key, config.value, config.secret);
//       results.push(result);
//     }
//   }
  
//   console.log(`✅ Saved ${results.length} payment configurations to database`);
  
//   return results;
// }

// export default {
//   getStripeSecretKey,
//   getAllPaymentConfigs,
//   getPublicPaymentKeys,
//   saveAllPaymentConfigs,
//   getConfigFromDB
// };