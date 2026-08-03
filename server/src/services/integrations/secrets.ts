import dotenv from 'dotenv';
import crypto from 'crypto';
import { supabase } from '../../config/supabase.js';

dotenv.config();

const ENCRYPTION_SECRET = process.env.VAULT_SECRET_KEY;

if (!ENCRYPTION_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: VAULT_SECRET_KEY environment variable is missing in production mode.');
}

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const secret = ENCRYPTION_SECRET || 'dev-only-insecure-default-vault-key-32b';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts sensitive OAuth token string using AES-256-GCM
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `enc:v2:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM encrypted token string
 */
export function decryptSecret(cipherText: string): string | null {
  if (!cipherText) return null;
  if (!cipherText.startsWith('enc:v2:')) {
    // Fallback for v1 legacy mock strings
    return cipherText.replace(/^enc:/, '');
  }

  try {
    const parts = cipherText.split(':');
    if (parts.length !== 5) return null;

    const iv = Buffer.from(parts[2], 'hex');
    const authTag = Buffer.from(parts[3], 'hex');
    const encryptedText = parts[4];
    const key = getEncryptionKey();

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Resolves credential references (e.g., 'vault:stripe_secret_key', 'vault:github_pat')
 * to actual secret keys via process environment variables.
 */
export async function resolveCredential(credentialRef: string): Promise<string | null> {
  if (!credentialRef) return null;

  const key = credentialRef.replace(/^vault:/i, '').toUpperCase();

  // Check environment variables
  const envVal =
    process.env[key] ||
    process.env[`${key}_KEY`] ||
    process.env[`${key}_TOKEN`] ||
    process.env[credentialRef];

  if (envVal) {
    return envVal;
  }

  return null;
}

/**
 * Stores or updates integration credentials in integration_credentials table with AES-256-GCM encryption
 */
export async function storeIntegrationCredential(params: {
  workspace_id: string;
  provider: 'slack' | 'github' | 'gmail' | 'zendesk' | 'linear' | 'database';
  external_org_id: string;
  access_token?: string;
  refresh_token?: string;
  scopes?: string[];
  connected_by_user_id?: string;
}) {
  const { workspace_id, provider, external_org_id, access_token, refresh_token, scopes, connected_by_user_id } = params;

  const { data, error } = await supabase
    .from('integration_credentials')
    .upsert(
      {
        workspace_id,
        provider,
        external_org_id,
        access_token_encrypted: access_token ? encryptSecret(access_token) : null,
        refresh_token_encrypted: refresh_token ? encryptSecret(refresh_token) : null,
        scopes: scopes || [],
        connected_by_user_id,
        connected_at: new Date().toISOString(),
        status: 'connected',
      },
      { onConflict: 'workspace_id, provider' }
    )
    .select()
    .single();

  if (error) {
    console.error(`[Secrets Error] Failed to store ${provider} credential for workspace ${workspace_id}:`, error);
    throw error;
  }

  return data;
}

/**
 * Fetches and decrypts stored integration credential for a workspace and provider
 */
export async function getIntegrationCredential(workspaceId: string, provider: string) {
  try {
    const { data } = await supabase
      .from('integration_credentials')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider', provider)
      .eq('status', 'connected')
      .single();

    if (!data) return null;

    const accessToken = data.access_token_encrypted ? decryptSecret(data.access_token_encrypted) : null;
    const refreshToken = data.refresh_token_encrypted ? decryptSecret(data.refresh_token_encrypted) : null;

    return {
      ...data,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  } catch {
    return null;
  }
}
