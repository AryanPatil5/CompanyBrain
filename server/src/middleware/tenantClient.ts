import { Request } from 'express';
import { supabase, createTenantClient } from '../config/supabase.js';

/**
 * Shared middleware/helper returning a PostgREST RLS-enforced Supabase client
 * using the requesting user's Bearer JWT, or service-role fallback for dev/mock tokens.
 */
export function getTenantClient(req: Request) {
  const authHeader = req.headers['authorization'] as string;
  if (authHeader && authHeader.startsWith('Bearer ') && authHeader.length > 20 && !authHeader.includes('mock')) {
    return createTenantClient(authHeader.substring(7));
  }
  return supabase;
}
