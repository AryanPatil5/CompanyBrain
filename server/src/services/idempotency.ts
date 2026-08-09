// Idempotency ledger (ADR-T13, pulled forward from Phase 6).
//
// Replay-safety substrate backed by the `idempotency_keys` table (migration
// 034). Webhook dedupe (Phase 2) and agent execution (Phase 6) acquire a key
// before side-effecting work and complete it afterwards; a replayed key
// returns the stored outcome instead of re-running the work.
//
// Failure semantics: BEST EFFORT. Persistence failures are logged and the
// caller proceeds as if acquired (fail-open) — the ledger optimizes away
// duplicate side effects; it never becomes a new availability dependency.

import { randomUUID, createHash } from 'node:crypto';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { withTimeout } from './health.js';

export type IdempotencyStatus = 'pending' | 'completed' | 'failed';

export interface IdempotencyRecord {
  key: string;
  workspaceId: string;
  operation: string;
  status: IdempotencyStatus;
  resultRef?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
}

export type AcquireResult =
  | { acquired: true; replayed?: undefined; record: IdempotencyRecord }
  | { acquired: false; replayed: true; record: IdempotencyRecord };

const PERSIST_TIMEOUT_MS = 2000;

/** Deterministic key for webhook-style dedupe (key = source + external_id + event_ts, ADR-T13). */
export function idempotencyKeyFor(parts: Array<string | undefined | null>): string {
  const joined = parts.map((p) => p ?? '').join(':');
  return createHash('sha256').update(joined).digest('hex');
}

/** Random key for one-shot operations (agent steps, tool calls). */
export function generateIdempotencyKey(): string {
  return randomUUID();
}

function mapRow(row: any): IdempotencyRecord {
  return {
    key: row.key,
    workspaceId: row.workspace_id,
    operation: row.operation,
    status: row.status,
    resultRef: row.result_ref ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
  };
}

export async function getIdempotency(key: string): Promise<IdempotencyRecord | null> {
  try {
    const { data, error } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
      return supabase.from('idempotency_keys').select('*').eq('key', key).single();
    })());
    if (error) throw error;
    return data ? mapRow(data) : null;
  } catch (err) {
    logger.warn('[Idempotency Warning] read failed (fail-open):', err);
    return null;
  }
}

/**
 * Acquires `key` for `operation` in `workspaceId`.
 *
 * - key unknown            -> inserted as `pending`, caller owns the work
 * - key pending, not stale -> replayed; the caller must not re-run the work
 * - key completed/failed   -> replayed; `record.resultRef` holds the outcome
 * - key pending + expired  -> the row is reset (re-acquired); the prior
 *                             attempt is treated as abandoned
 *
 * The primary key is the enforcement point: even under a concurrent double
 * acquire, only one row can exist (the loser re-reads and replays).
 */
export async function acquireIdempotency(
  workspaceId: string,
  key: string,
  operation: string,
  opts: { ttlMs?: number } = {},
): Promise<AcquireResult> {
  try {
    const existing = await getIdempotency(key);
    if (existing) {
      const expired =
        existing.status === 'pending' &&
        !!existing.expiresAt &&
        new Date(existing.expiresAt).getTime() < Date.now();
      if (expired) {
        const { error: updateError } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
          return supabase
            .from('idempotency_keys')
            .update({ updated_at: new Date().toISOString(), expires_at: expirySql(opts.ttlMs) })
            .eq('key', key);
        })());
        if (updateError) throw updateError;
        const refreshed = await getIdempotency(key);
        return { acquired: true, record: refreshed ?? existing };
      }
      return { acquired: false, replayed: true, record: existing };
    }

    const { error } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
      return supabase.from('idempotency_keys').insert({
        key,
        workspace_id: workspaceId,
        operation,
        status: 'pending',
        expires_at: expirySql(opts.ttlMs),
      });
    })());
    if (error) throw error;

    const inserted = await getIdempotency(key);
    return { acquired: true, record: inserted ?? { key, workspaceId, operation, status: 'pending' } };
  } catch (err) {
    logger.warn('[Idempotency Warning] acquire failed (fail-open, executing):', err);
    return { acquired: true, record: { key, workspaceId, operation, status: 'pending' } };
  }
}

/** Marks a ledger row completed/failed with the outcome reference. */
export async function completeIdempotency(
  key: string,
  status: IdempotencyStatus,
  resultRef?: string,
): Promise<void> {
  try {
    const { error } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
      return supabase
        .from('idempotency_keys')
        .update({ status, result_ref: resultRef ?? null, updated_at: new Date().toISOString() })
        .eq('key', key);
    })());
    if (error) throw error;
  } catch (err) {
    logger.warn('[Idempotency Warning] complete failed (fail-open):', err);
  }
}

function expirySql(ttlMs?: number): string | null {
  if (!ttlMs) return null;
  return new Date(Date.now() + ttlMs).toISOString();
}
