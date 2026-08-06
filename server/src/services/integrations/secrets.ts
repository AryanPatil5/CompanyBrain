import dotenv from 'dotenv';
import crypto from 'crypto';
import { supabase } from '../../config/supabase.js';
import {
  encryptSecret as encryptKms,
  decryptSecret as decryptKms,
  EncryptedPayload,
} from '../security/kmsEncryption.js';

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
 * Encrypts sensitive OAuth token string using AES-256-GCM envelope encryption
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  if (!plaintext) return '';
  try {
    const payload = await encryptKms(plaintext);
    return `enc:v2:${payload.iv}:${payload.authTag}:${payload.cipherText}`;
  } catch {
    const iv = crypto.randomBytes(12);
    const key = getEncryptionKey();
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `enc:v2:${iv.toString('hex')}:${authTag}:${encrypted}`;
  }
}

/**
 * Decrypts AES-256-GCM encrypted token string
 */
export async function decryptSecret(cipherText: string): Promise<string | null> {
  if (!cipherText) return null;
  if (!cipherText.startsWith('enc:v2:')) {
    return cipherText.replace(/^enc:/, '');
  }

  try {
    const parts = cipherText.split(':');
    if (parts.length !== 5) return null;

    const payload: EncryptedPayload = {
      iv: parts[2],
      authTag: parts[3],
      cipherText: parts[4],
    };

    return await decryptKms(payload);
  } catch {
    try {
      const parts = cipherText.split(':');
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
}

/**
 * Saves integration tokens after stringifying JSON and encrypting with KMS.
 */
export async function saveCredential(
  workspaceId: string,
  provider: 'slack' | 'github' | 'gmail' | 'zendesk' | 'linear' | 'database',
  tokens: Record<string, any>
) {
  const jsonString = typeof tokens === 'string' ? tokens : JSON.stringify(tokens);
  const encrypted = await encryptSecret(jsonString);

  return storeIntegrationCredential({
    workspace_id: workspaceId,
    provider,
    external_org_id: tokens.org_id || tokens.team_id || workspaceId,
    access_token: encrypted,
    refresh_token: tokens.refresh_token,
    scopes: tokens.scopes || [],
  });
}

/**
 * Fetches, decrypts, and parses stored integration credentials for a workspace and provider.
 */
export async function getCredential(workspaceId: string, provider: string): Promise<Record<string, any> | null> {
  const raw = await getIntegrationCredential(workspaceId, provider);
  if (!raw || !raw.access_token) return null;

  try {
    const decrypted = raw.access_token;
    if (decrypted.startsWith('{') || decrypted.startsWith('[')) {
      return JSON.parse(decrypted);
    }
    return { access_token: decrypted, ...raw };
  } catch {
    return { access_token: raw.access_token, ...raw };
  }
}

/**
 * Resolves credential references (e.g., 'vault:stripe_secret_key', 'vault:github_pat')
 * to actual secret keys via process environment variables.
 */
export async function resolveCredential(credentialRef: string): Promise<string | null> {
  if (!credentialRef) return null;

  const key = credentialRef.replace(/^vault:/i, '').toUpperCase();

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
        access_token_encrypted: access_token ? await encryptSecret(access_token) : null,
        refresh_token_encrypted: refresh_token ? await encryptSecret(refresh_token) : null,
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

    const accessToken = data.access_token_encrypted ? await decryptSecret(data.access_token_encrypted) : null;
    const refreshToken = data.refresh_token_encrypted ? await decryptSecret(data.refresh_token_encrypted) : null;

    return {
      ...data,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  } catch {
    return null;
  }
}
