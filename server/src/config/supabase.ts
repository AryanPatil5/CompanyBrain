import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-key';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'placeholder-anon-key';

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('[WARN] Missing Supabase environment variables in server/.env');
}

// 1. Service role client (reserved for webhooks, migrations & system background workers)
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// 2. Public anon client (enforces Postgres Row Level Security)
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

// 3. Helper to create a PostgREST RLS-enforced client scoped by a user's JWT
export function createTenantClient(jwtToken: string) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    },
  });
}