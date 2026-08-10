import { logger } from '../logger.js';
import { supabase } from '../config/supabase.js';
import { webhookIngestionQueue } from '../queue/ingestionQueue.js';
import { acquireIdempotency, completeIdempotency, getIdempotencyStrict, releaseIdempotency } from '../services/idempotency.js';
import {
  deriveWebhookDedupeKey,
  persistRawSourceEvent,
  processThreadCore,
  updateEventStatus,
  webhookExtractIdempotencyKey,
  type RawSourceEventRow,
  type ThreadProcessResult,
} from '../services/ingestion/webhookService.js';
import type { ThreadPayload } from '../services/connectors.js';

export interface WebhookPipelineInput {
  workspaceId: string;
  provider: string;
  source: string;
  externalId: string;
  eventTimestamp?: string;
  rawPayload: unknown;
  normalizedPayload: ThreadPayload | null;
  sourceTrust: 'manual' | 'crawled';
}

export interface WebhookPipelineResult {
  eventId: string;
  status: 'queued' | 'received' | 'duplicate';
  replayed: boolean;
}

/**
 * Entry point for every accepted webhook delivery (Phase 2 Task 1).
 *
 * 1. Persist the raw event first — the row is the durable source of truth
 *    (raw_source_events). The unique dedupe key makes redeliveries return the
 *    ORIGINAL event id instead of a second row.
 * 2. Enqueue the event for the webhook worker. Queue push is best-effort:
 *    if Redis is unavailable the event stays `received` and the consumer-side
 *    retry path (or a later re-delivery by the provider) picks it up.
 * 3. Return `202 { event_id, status }` immediately — the LLM work happens
 *    asynchronously in the worker.
 */
export async function ingestWebhookEvent(
  input: WebhookPipelineInput,
): Promise<WebhookPipelineResult> {
  const { workspaceId, provider, source, externalId, eventTimestamp, rawPayload, normalizedPayload, sourceTrust } = input;

  const dedupeKey = deriveWebhookDedupeKey({
    workspaceId,
    provider,
    externalId,
    eventTimestamp,
    rawPayload,
  });

  // The canonical ledger key for this extraction — the SAME key the webhook
  // consumer writes on acquire/complete (webhook_extract). The replay guard
  // below is only effective while both sides derive through this one
  // function; a mismatch silently disables the guard.
  const opKey = webhookExtractIdempotencyKey({
    workspaceId,
    provider,
    externalId,
    eventTimestamp,
    rawPayload,
  });

  // Replay guard BEFORE touching the DB: if the ledger says this event was
  // already fully processed, surface it as a duplicate without re-enqueueing.
  // (The ledger is fail-open — a read failure just proceeds.)
  const existingLedger = await getIdempotencyLedger(opKey);
  if (existingLedger && existingLedger.status !== 'pending') {
    const { data: prior } = await supabase
      .from('raw_source_events')
      .select('*')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (prior) {
      return { eventId: prior.id, status: 'duplicate', replayed: true };
    }
  }

  const { row, replayed } = await persistRawSourceEvent({
    workspaceId,
    provider,
    source,
    externalId,
    eventTimestamp,
    rawPayload,
    normalizedPayload: normalizedPayload ?? {},
    sourceTrust,
  });

  if (replayed) {
    // Same dedupe key already on record. If the first delivery's enqueue
    // never landed (row still `received`), this redelivery IS the retry —
    // enqueue it. Otherwise it is a true duplicate: acknowledge, do not
    // re-enqueue (the consumer is exactly-once regardless).
    if (row.status === 'received') {
      try {
        await webhookIngestionQueue.add('webhook_event', { eventId: row.id, workspaceId });
        await updateEventStatus(row.id, { status: 'queued' }, workspaceId);
        return { eventId: row.id, status: 'queued', replayed: true };
      } catch (queueErr) {
        logger.warn(`[WebhookPipeline] Redelivery enqueue failed for ${row.id}:`, queueErr);
        return { eventId: row.id, status: 'received', replayed: true };
      }
    }
    return { eventId: row.id, status: 'duplicate', replayed: true };
  }

  let status: WebhookPipelineResult['status'] = 'received';
  try {
    await webhookIngestionQueue.add('webhook_event', { eventId: row.id, workspaceId });
    status = 'queued';
    await updateEventStatus(row.id, { status: 'queued' }, workspaceId);
  } catch (queueErr) {
    // Best-effort enqueue: the event row is already durable; a provider
    // re-delivery or the stale-event recovery sweep (recoverStaleWebhookEvents)
    // will enqueue it later. Never fail the webhook acceptance because Redis is down.
    logger.warn(`[WebhookPipeline] Failed to enqueue event ${row.id} (Redis unavailable?), event kept as 'received':`, queueErr);
  }

  return { eventId: row.id, status, replayed };
}

async function getIdempotencyLedger(key: string) {
  try {
    const { data } = await supabase.from('idempotency_keys').select('*').eq('key', key).maybeSingle();
    return data;
  } catch (err) {
    logger.warn('[WebhookPipeline] Ledger read failed (fail-open):', err);
    return null;
  }
}

/**
 * Consumer-side processing of one durable webhook event (runs inside the
 * BullMQ webhook worker). Exactly-once is enforced by an atomic conditional
 * claim on the event row: UPDATE raw_source_events SET status='processing'
 * WHERE id=? AND workspace_id=? AND status IN ('received','queued') RETURNING *.
 * Only the worker that receives the returned row may process the event; a
 * worker that gets no row back (concurrent consumer, or an already
 * completed/failed event) returns 'skipped' (or 'not_found').
 *
 * Transient failures throw so BullMQ retries (attempts: 3, exponential
 * backoff) actually re-run the work — the event is NOT moved to a terminal
 * state here while retries remain. The worker's `failed` handler resets the
 * event to 'queued' between attempts and only marks it 'failed' (routing to
 * webhook-ingestion-dlq) once attempts are genuinely exhausted.
 */
export async function processWebhookEventJob(input: {
  eventId: string;
  workspaceId: string;
  attempts?: { made: number; max: number };
}): Promise<ThreadProcessResult | 'skipped' | 'not_found'> {
  const { eventId, workspaceId } = input;

  // Atomic claim: the conditional UPDATE is the single enforcement point.
  // Concurrent workers and retries of an already-owned/terminal event get no
  // row back and must back off.
  const { data: claimed, error: claimErr } = await supabase
    .from('raw_source_events')
    .update({ status: 'processing' })
    .eq('id', eventId)
    .eq('workspace_id', workspaceId)
    .in('status', ['received', 'queued'])
    .select('*')
    .maybeSingle();

  if (claimErr) throw claimErr;

  if (!claimed) {
    // No row claimed: either the event is already owned/terminal elsewhere or
    // it does not exist. Distinguish so unknown ids still report not_found.
    const { data: existing } = await supabase
      .from('raw_source_events')
      .select('id')
      .eq('id', eventId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (!existing) return 'not_found';
    logger.info(`[WebhookPipeline] Event ${eventId} not claimable (owned or terminal); skipping.`);
    return 'skipped';
  }

  const row = claimed as RawSourceEventRow;

  // Idempotency ledger (ADR-T13). Because we hold the atomic event claim, a
  // leftover 'pending' (crashed attempt) or 'failed' (prior retry) key
  // belongs to an earlier attempt of THIS job — re-arm it and re-run. Only a
  // 'completed' key short-circuits: the extraction genuinely finished before
  // the event row could be marked completed. The key is the shared canonical
  // derivation (webhook_extract), so the route-side replay guard and the
  // stale-event recovery sweep agree on exactly what the worker wrote.
  const opKey = webhookExtractIdempotencyKey({
    workspaceId: row.workspace_id,
    provider: row.provider,
    externalId: row.external_id,
    eventTimestamp: row.event_timestamp ?? undefined,
    rawPayload: row.raw_payload,
  });

  const acquire = await acquireIdempotency(workspaceId, opKey, 'webhook_extract', { ttlMs: 5 * 60 * 1000 });
  if (acquire.acquired === false && acquire.replayed) {
    if (acquire.record.status === 'completed') {
      await updateEventStatus(eventId, { status: 'completed' }, workspaceId);
      return 'skipped';
    }
    await releaseIdempotency(opKey, 5 * 60 * 1000);
  }

  try {
    const normalized = (row.normalized_payload ?? {}) as ThreadPayload;
    const result = await processThreadCore(normalized, {
      sourceTrust: (row.source_trust as 'manual' | 'crawled') || 'crawled',
    });

    await completeIdempotency(opKey, 'completed', result.rawThreadId);
    await updateEventStatus(
      eventId,
      {
        status: 'completed',
        resulting_thread_id: result.rawThreadId,
        sop_id: result.sopId ?? null,
        processed_at: new Date().toISOString(),
      },
      workspaceId,
    );

    logger.info(
      `[WebhookPipeline] Event ${eventId} completed (${result.outcome}, thread ${result.rawThreadId}${result.sopId ? `, SOP ${result.sopId}` : ''})`,
    );
    return result;
  } catch (err) {
    // Record the failed attempt on the ledger (a redelivery of an exhausted
    // event must be recognized as processed). Do NOT transition the event row
    // to a terminal state while BullMQ still has retries left — that would
    // make every later attempt skip. The worker's `failed` handler resets the
    // event to 'queued' when attempts remain and only marks it 'failed' (and
    // routes to webhook-ingestion-dlq) once attempts are genuinely exhausted.
    await completeIdempotency(opKey, 'failed', undefined);
    const exhausted = !input.attempts || input.attempts.made >= input.attempts.max;
    if (exhausted) {
      await updateEventStatus(
        eventId,
        {
          status: 'failed',
          error_message: err instanceof Error ? err.message : String(err),
        },
        workspaceId,
      );
    }
    logger.error(`[WebhookPipeline] Event ${eventId} processing failed:`, err);
    throw err;
  }
}

// ─── Stale event recovery ──────────────────────────────────────────

export const DEFAULT_STALE_EVENT_TIMEOUT_MS = 15 * 60 * 1000;

export interface StaleRecoveryOptions {
  /** Restrict the sweep to a single workspace (worker sweep passes none). */
  workspaceId?: string;
  /** Events older than this are candidates. Default: 15 minutes. */
  staleAfterMs?: number;
}

export interface StaleRecoveryResult {
  recovered: number;
  /** Candidates skipped because the idempotency ledger suggests the worker is still alive. */
  skipped: number;
  /** Candidates that could not be claimed/re-enqueued (db or queue failure). */
  failed: number;
}

/**
 * Recovers webhook events stranded in `received`/`processing` longer than the
 * stale timeout (worker crash, lost status update, Redis outage during the
 * original enqueue). Every candidate is re-claimed with an ATOMIC conditional
 * update (status must still be received/processing AND created_at must still
 * be older than the cutoff), so concurrent sweeps, a racing provider
 * redelivery, or the worker itself can never double-claim. Only the winning
 * update enqueues the canonical { eventId, workspaceId } job.
 *
 * Liveness guard: a `processing` event whose idempotency ledger row is still
 * `pending` and unexpired is NOT touched — its worker may genuinely still be
 * running. Ledger reads are strict: if the check itself fails the event is
 * skipped rather than blindly re-queued.
 *
 * The enqueue itself stays best-effort: if Redis is down the claimed row is
 * reverted to `received` so the next sweep re-attempts.
 */
export async function recoverStaleWebhookEvents(opts: StaleRecoveryOptions = {}): Promise<StaleRecoveryResult> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_EVENT_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();

  let query = supabase
    .from('raw_source_events')
    .select('*')
    .in('status', ['received', 'processing'])
    .lt('created_at', cutoff);
  if (opts.workspaceId) {
    query = query.eq('workspace_id', opts.workspaceId);
  }

  const { data: candidates, error: listErr } = await query;
  if (listErr) {
    logger.warn('[WebhookPipeline Warning] Stale event scan failed:', listErr);
    return { recovered: 0, skipped: 0, failed: 0 };
  }

  const result: StaleRecoveryResult = { recovered: 0, skipped: 0, failed: 0 };

  for (const row of (candidates ?? []) as RawSourceEventRow[]) {
    if (row.status === 'processing') {
      // Liveness guard: a worker that acquired the ledger < TTL ago may still
      // be mid-extraction. Re-claiming its event would duplicate the work.
      let ledger;
      try {
        ledger = await getIdempotencyStrict(
          webhookExtractIdempotencyKey({
            workspaceId: row.workspace_id,
            provider: row.provider,
            externalId: row.external_id,
            eventTimestamp: row.event_timestamp ?? undefined,
            rawPayload: row.raw_payload,
          }),
        );
      } catch (err) {
        logger.warn(`[WebhookPipeline] Liveness check failed for event ${row.id}; skipping recovery:`, err);
        result.failed += 1;
        continue;
      }
      if (
        ledger &&
        ledger.status === 'pending' &&
        !!ledger.expiresAt &&
        new Date(ledger.expiresAt).getTime() > Date.now()
      ) {
        result.skipped += 1;
        continue;
      }
    }

    // Atomic claim: exactly one recovery attempt (or worker/redelivery) wins
    // per event. Losers match zero rows and move on.
    const { data: claimed, error: claimErr } = await supabase
      .from('raw_source_events')
      .update({ status: 'queued' })
      .eq('id', row.id)
      .eq('workspace_id', row.workspace_id)
      .in('status', ['received', 'processing'])
      .lt('created_at', cutoff)
      .select('*')
      .maybeSingle();

    if (claimErr) {
      result.failed += 1;
      logger.warn(`[WebhookPipeline] Stale event ${row.id} claim failed:`, claimErr);
      continue;
    }
    if (!claimed) continue; // another recovery attempt already claimed it

    try {
      await webhookIngestionQueue.add('webhook_event', { eventId: row.id, workspaceId: row.workspace_id });
      result.recovered += 1;
    } catch (enqueueErr) {
      // Queue down: revert to 'received' so a later sweep re-attempts.
      await updateEventStatus(row.id, { status: 'received' }, row.workspace_id);
      result.failed += 1;
      logger.warn(`[WebhookPipeline] Stale event ${row.id} enqueue failed (reverted to received):`, enqueueErr);
    }
  }

  return result;
}
