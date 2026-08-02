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
