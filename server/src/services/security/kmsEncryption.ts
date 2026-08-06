import dotenv from 'dotenv';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { getKeyProvider } from './keyProvider.js';

dotenv.config();

export interface EncryptedPayload {
  cipherText: string;
  iv: string;
  authTag: string;
}

/**
 * Encrypts a plain text secret or token using AES-256-GCM envelope encryption.
 * Uses the KeyProvider interface to obtain encryption keys.
 */
export async function encryptSecret(plainText: string): Promise<EncryptedPayload> {
  if (plainText === undefined || plainText === null) {
    throw new Error('Cannot encrypt undefined or null plain text.');
  }

  const keyProvider = getKeyProvider();
  const resolvedKey = await keyProvider.resolveCredential('KMS_MASTER_KEY');
  
  if (!resolvedKey) {
    throw new Error('No master key available from KeyProvider');
  }

  const masterKey = Buffer.from(resolvedKey, 'hex');
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
 * Uses the KeyProvider interface to obtain encryption keys.
 */
export async function decryptSecret(payload: EncryptedPayload): Promise<string> {
  if (!payload || !payload.cipherText || !payload.iv || !payload.authTag) {
    throw new Error('Invalid EncryptedPayload structure. Required: { cipherText, iv, authTag }.');
  }

  const keyProvider = getKeyProvider();
  const resolvedKey = await keyProvider.resolveCredential('KMS_MASTER_KEY');
  
  if (!resolvedKey) {
    throw new Error('No master key available from KeyProvider');
  }

  const masterKey = Buffer.from(resolvedKey, 'hex');
  const iv = Buffer.from(payload.iv, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);

  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(payload.cipherText, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}
