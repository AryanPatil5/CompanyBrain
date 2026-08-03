import dotenv from 'dotenv';
import { supabase } from '../../config/supabase.js';

dotenv.config();

/**
 * Resolves credential references (e.g., 'vault:stripe_secret_key', 'vault:github_pat')
 * to actual secret keys via process environment variables or Supabase Vault table.
 */
export async function resolveCredential(credentialRef: string): Promise<string | null> {
  if (!credentialRef) return null;

  const key = credentialRef.replace(/^vault:/i, '').toUpperCase();

  // 1. Check environment variables first (e.g., STRIPE_SECRET_KEY, GITHUB_TOKEN, SLACK_BOT_TOKEN)
  const envVal =
    process.env[key] ||
    process.env[`${key}_KEY`] ||
    process.env[`${key}_TOKEN`] ||
    process.env[credentialRef];

  if (envVal) {
    return envVal;
  }

  // 2. Query Supabase Vault or credential secrets table fallback
  try {
    const { data } = await supabase
      .from('vault_secrets')
      .select('secret_value')
      .eq('secret_name', credentialRef)
      .single();

    if (data?.secret_value) {
      return data.secret_value;
    }
  } catch {
    // Non-fatal vault lookup fallback
  }

  return null;
}

/**
 * Stores or updates integration credentials in integration_credentials table
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
        access_token_encrypted: access_token ? `enc:${access_token}` : null,
        refresh_token_encrypted: refresh_token ? `enc:${refresh_token}` : null,
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

    const accessToken = data.access_token_encrypted?.replace(/^enc:/, '') || null;
    const refreshToken = data.refresh_token_encrypted?.replace(/^enc:/, '') || null;

    return {
      ...data,
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  } catch {
    return null;
  }
}
