import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

// Default 32-byte (256-bit) master key fallback for local development & testing
const DEFAULT_DEV_MASTER_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function getMasterKey(): Buffer {
  const envKey = process.env.KMS_MASTER_KEY || DEFAULT_DEV_MASTER_KEY_HEX;
  // If key is 64 hex characters (32 bytes)
  if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }
  // Otherwise pad/hash or slice to 32 bytes
  return Buffer.alloc(32, envKey, 'utf-8');
}

export interface EncryptedPayload {
  cipherText: string;
  iv: string;
  authTag: string;
}

/**
 * Encrypts a plain text secret or token using AES-256-GCM envelope encryption.
 */
export function encryptSecret(plainText: string): EncryptedPayload {
  if (plainText === undefined || plainText === null) {
    throw new Error('Cannot encrypt undefined or null plain text.');
  }

  const masterKey = getMasterKey();
  const iv = randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);

  let encrypted = cipher.update(plainText, 'utf-8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    cipherText: encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

/**
 * Decrypts an AES-256-GCM encrypted payload back to plain text.
 */
export function decryptSecret(payload: EncryptedPayload): string {
  if (!payload || !payload.cipherText || !payload.iv || !payload.authTag) {
    throw new Error('Invalid EncryptedPayload structure. Required: { cipherText, iv, authTag }.');
  }

  const masterKey = getMasterKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.cipherText, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}
