// Idempotency ledger (ADR-T13, pulled forward from Phase 6).
//
// Replay-safety substrate backed by the `idempotency_keys` table (migration
// 034). Webhook dedupe (Phase 2) and agent execution (Phase 6) acquire a key
// before side-effecting work and complete it afterwards; a replayed key
// returns the stored outcome instead of re-running the work.
//
// Failure semantics: BEST EFFORT. Persistence failures on reads and
// completion writes are logged and the caller proceeds (fail-open) — the
// ledger optimizes away duplicate side effects; it never becomes a new
// availability dependency. The one exception is ACQUIRE: a genuine database
// error propagates so the caller's own retry mechanism handles it, because
// failing open on acquire would let two callers run the same side effect. A
// concurrent double-acquire is NOT an error: the loser sees the PostgreSQL
// 23505 unique violation and replays the winner's record instead.

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
    return await getIdempotencyStrict(key);
  } catch (err) {
    logger.warn('[Idempotency Warning] read failed (fail-open):', err);
    return null;
  }
}

/**
 * Strict read: identical to getIdempotency but NEVER fails open. A database
 * error propagates to the caller. Used where swallowing an error would let
 * two callers run the same side effect (post-23505 replay, race re-reads).
 */
export async function getIdempotencyStrict(key: string): Promise<IdempotencyRecord | null> {
  const { data, error } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
    return supabase.from('idempotency_keys').select('*').eq('key', key).single();
  })());
  if (error) throw error;
  return data ? mapRow(data) : null;
}

/** True for PostgreSQL 23505 unique-violation errors (supabase-js PostgrestError.code or a wrapped Error). */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === '23505' || /duplicate key value violates unique constraint/i.test(String(e.message ?? ''));
}

/**
 * Acquires `key` for `operation` in `workspaceId`.
 *
 * - key unknown            -> inserted as `pending`, caller owns the work
 * - key pending, not stale -> replayed; the caller must not re-run the work
 * - key completed/failed   -> replayed; `record.resultRef` holds the outcome
 * - key pending + expired  -> the row is reset (re-acquired) CONDITIONALLY;
 *                             a concurrent caller that already refreshed it
 *                             matches zero rows and is treated as a replay
 *                             (acquired: false) — never a second owner
 *
 * The primary key is the enforcement point: even under a concurrent double
 * acquire, only one row can exist. A PostgreSQL 23505 unique violation on the
 * insert is the normal signature of that race — the loser re-reads the
 * winner's record via a STRICT (non-fail-open) read and returns
 * `acquired: false` (it does NOT fail open and run). If the re-read itself
 * fails, or the winner row cannot be found, the error propagates. Any other
 * database error propagates to the caller.
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
        // Conditional re-acquire: the UPDATE only wins if the row is STILL
        // pending and STILL expired. A concurrent caller that refreshed the
        // row between our read and this update matches zero rows — that is a
        // legitimate replay of their acquire, not an error, and must never
        // return acquired:true (that would let two callers run the work).
        const { data: refreshed, error: updateError } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
          return supabase
            .from('idempotency_keys')
            .update({
              status: 'pending',
              updated_at: new Date().toISOString(),
              expires_at: expirySql(opts.ttlMs),
            })
            .eq('key', key)
            .eq('status', 'pending')
            .lt('expires_at', new Date().toISOString())
            .select('*')
            .maybeSingle();
        })());
        if (updateError) throw updateError;
        if (refreshed) {
          return { acquired: true, record: mapRow(refreshed) };
        }
        // Zero rows updated: a concurrent caller re-acquired first. Re-read
        // strictly — never fabricate a record after losing the race.
        const winner = await getIdempotencyStrict(key);
        if (!winner) {
          throw new Error('Idempotency expired-key race: winner row not found after zero-row refresh.');
        }
        return { acquired: false, replayed: true, record: winner };
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
    if (error) {
      // 23505 = a concurrent acquire inserted the same key first. Normal
      // replay, not a failure: re-read the winner's row strictly and back
      // off. A genuine re-read error propagates; a missing winner row is an
      // inconsistency and throws — state is never fabricated.
      if (isUniqueViolation(error)) {
        const raced = await getIdempotencyStrict(key);
        if (!raced) {
          throw new Error('Idempotency 23505 race: winner row not found after unique violation.');
        }
        return {
          acquired: false,
          replayed: true,
          record: raced,
        };
      }
      throw error;
    }

    const inserted = await getIdempotency(key);
    return { acquired: true, record: inserted ?? { key, workspaceId, operation, status: 'pending' } };
  } catch (err) {
    // A 23505 can also be thrown directly instead of returned in `error`.
    // Treat it the same way. Anything else propagates (no fail-open).
    if (isUniqueViolation(err)) {
      const raced = await getIdempotencyStrict(key);
      if (!raced) {
        throw new Error('Idempotency 23505 race: winner row not found after unique violation.');
      }
      return {
        acquired: false,
        replayed: true,
        record: raced,
      };
    }
    throw err;
  }
}

/**
 * Re-arms an existing idempotency key as `pending` with a fresh TTL.
 *
 * Used when a worker holds the underlying work claim (e.g. the atomic
 * raw_source_events row claim) but the ledger still carries a leftover
 * `pending`/`failed` entry from an earlier crashed or failed attempt of the
 * SAME job. Best-effort: a failure is logged and the caller proceeds — the
 * work claim remains the authoritative exactly-once guard.
 */
export async function releaseIdempotency(key: string, ttlMs?: number): Promise<void> {
  try {
    const { error } = await withTimeout(PERSIST_TIMEOUT_MS, (async () => {
      return supabase
        .from('idempotency_keys')
        .update({
          status: 'pending',
          result_ref: null,
          updated_at: new Date().toISOString(),
          expires_at: expirySql(ttlMs),
        })
        .eq('key', key);
    })());
    if (error) throw error;
  } catch (err) {
    logger.warn('[Idempotency Warning] release failed (best-effort):', err);
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
