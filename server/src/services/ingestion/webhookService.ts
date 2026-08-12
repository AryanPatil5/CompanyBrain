import { logger } from '../../logger.js';
import crypto from 'node:crypto';
import { supabase } from '../../config/supabase.js';
import { resolveEntitiesForDocument } from '../../knowledge/entityResolver.js';
import { processThreadTail } from '../../ingestion/documentPipeline.js';
import { linkDocumentClaimsToSop } from '../../knowledge/claimProvenance.js';
import { detectConflict, createVersion } from '../freshness.js';
import { generateEmbedding, recordEmbeddingFailure } from '../embeddings.js';
import { idempotencyKeyFor } from '../idempotency.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ThreadPayload } from '../connectors.js';

export interface WebhookEventPayload {
  provider: 'github' | 'slack' | 'linear' | 'zendesk';
  deliveryId: string;
  workspaceId: string;
  eventTimestamp: string;
  payload: any;
}

/**
 * Validates HMAC SHA-256 signatures for incoming Slack & GitHub webhooks.
 */
export function verifyWebhookSignature(
  provider: 'github' | 'slack',
  rawBody: string,
  signatureHeader: string,
  secret: string,
  timestampHeader?: string
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;

  try {
    if (provider === 'github') {
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig));
    }

    if (provider === 'slack') {
      if (!timestampHeader) return false;
      const sigBasestring = `v0:${timestampHeader}:${rawBody}`;
      const expectedSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig));
    }
  } catch (err) {
    logger.warn('[WebhookService Warning] HMAC Signature verification exception:', err);
    return false;
  }

  return false;
}

/**
 * Processes incoming webhook events incrementally, dropping stale out-of-order deliveries.
 */
export async function processWebhookEvent(
  event: WebhookEventPayload
): Promise<{ processed: boolean; reason?: string }> {
  const { provider, workspaceId, eventTimestamp, deliveryId } = event;
  const currentTs = new Date(eventTimestamp).getTime();

  try {
    const { data: sub } = await supabase
      .from('webhook_subscriptions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider', provider)
      .single();

    if (sub && sub.last_event_timestamp) {
      const lastTs = new Date(sub.last_event_timestamp).getTime();
      if (currentTs <= lastTs) {
        return { processed: false, reason: 'Ignored stale or duplicate out-of-order webhook delivery.' };
      }
    }

    // Update last_event_timestamp & delivery_token in webhook_subscriptions
    await supabase.from('webhook_subscriptions').upsert(
      {
        workspace_id: workspaceId,
        provider,
        last_delivery_token: deliveryId,
        last_event_timestamp: new Date(currentTs).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id, provider' }
    );

    return { processed: true };
  } catch (err: any) {
    logger.warn('[WebhookService Warning] Failed to process incremental webhook update:', err);
    return { processed: true };
  }
}

// ─── Phase 2 Task 1: durable event persistence + dedupe ─────────────

export interface RawSourceEventRow {
  id: string;
  dedupe_key: string;
  workspace_id: string;
  provider: string;
  source: string;
  external_id: string;
  event_timestamp: string | null;
  raw_payload: any;
  normalized_payload: any;
  source_trust: string;
  status: 'received' | 'queued' | 'processing' | 'completed' | 'failed';
  resulting_thread_id: string | null;
  sop_id: string | null;
  error_message: string | null;
  created_at: string;
  processed_at: string | null;
}

/**
 * Best-effort extraction of the provider's own event timestamp from a raw
 * webhook body. The dedupe key (Phase 2 roadmap: source + external_id +
 * event_ts) prefers this semantic timestamp; when the provider does not
 * expose one, the pipeline falls back to a content hash of the raw payload,
 * which still dedupes byte-identical redeliveries.
 */
export function extractWebhookEventTimestamp(provider: string, raw: any): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  switch (provider) {
    case 'slack':
      return raw.event?.ts ?? raw.event_time ?? raw.timestamp;
    case 'github':
      return (
        raw.comment?.created_at ??
        raw.issue?.updated_at ??
        raw.issue?.created_at ??
        raw.pull_request?.created_at
      );
    case 'linear':
      return raw.data?.createdAt ?? raw.createdAt ?? raw.updatedAt;
    default:
      return undefined;
  }
}

/**
 * Deterministic dedupe key for a webhook delivery. Scope includes the
 * workspace: the Phase 1 ledger's key is a global primary key, so keys must
 * be workspace-scoped to avoid cross-workspace replay (Phase 1 test
 * documented this contract).
 */
export function deriveWebhookDedupeKey(parts: {
  workspaceId: string;
  provider: string;
  externalId: string;
  eventTimestamp?: string;
  rawPayload: unknown;
}): string {
  const { workspaceId, provider, externalId, eventTimestamp, rawPayload } = parts;
  const ts =
    eventTimestamp ??
    crypto.createHash('sha256').update(JSON.stringify(rawPayload ?? {})).digest('hex');
  return idempotencyKeyFor([workspaceId, provider, externalId, ts]);
}

/**
 * THE canonical Phase 1 ledger key for a webhook extraction — the ONLY key the
 * webhook consumer ever reads or writes (operation `webhook_extract`). The
 * route-side replay guard and the worker's acquire/complete must derive the
 * key through this single function; deriving a different string in one place
 * silently disables the ledger guard (dedupe_key vs webhook_extract mismatch).
 */
export function webhookExtractIdempotencyKey(parts: {
  workspaceId: string;
  provider: string;
  externalId: string;
  eventTimestamp?: string;
  rawPayload: unknown;
}): string {
  const dedupeKey = deriveWebhookDedupeKey(parts);
  return idempotencyKeyFor(['webhook_extract', parts.provider, parts.externalId, dedupeKey]);
}

/**
 * Persists a webhook delivery into `raw_source_events`, deduplicating on the
 * dedupe key: a redelivery returns the ORIGINAL row (same event id) instead
 * of inserting (or, worse, clobbering) a second ledger entry. The insert is
 * the enforcement point — a lost race (concurrent redelivery) surfaces a
 * unique violation, and the refetch returns the winner's row.
 */
export async function persistRawSourceEvent(input: {
  workspaceId: string;
  provider: string;
  source: string;
  externalId: string;
  eventTimestamp?: string;
  rawPayload: unknown;
  normalizedPayload: unknown;
  sourceTrust: string;
  client?: Pick<typeof supabase, 'from'>;
}): Promise<{ row: RawSourceEventRow; replayed: boolean }> {
  const {
    workspaceId,
    provider,
    source,
    externalId,
    eventTimestamp,
    rawPayload,
    normalizedPayload,
    sourceTrust,
    client = supabase,
  } = input;

  const dedupeKey = deriveWebhookDedupeKey({
    workspaceId,
    provider,
    externalId,
    eventTimestamp,
    rawPayload,
  });

  const { data: existing } = await client
    .from('raw_source_events')
    .select('*')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (existing) {
    return { row: existing as RawSourceEventRow, replayed: true };
  }

  const { error } = await client
    .from('raw_source_events')
    .insert({
      dedupe_key: dedupeKey,
      workspace_id: workspaceId,
      provider,
      source,
      external_id: externalId,
      event_timestamp: eventTimestamp ?? null,
      raw_payload: rawPayload ?? {},
      normalized_payload: normalizedPayload ?? {},
      source_trust: sourceTrust,
      status: 'received',
    })
    .select('*')
    .single();

  if (error) {
    // Unique-violation race: a concurrent delivery of the same event won the
    // insert. Return its row — the caller must NOT enqueue a second job.
    const { data: raced } = await client
      .from('raw_source_events')
      .select('*')
      .eq('dedupe_key', dedupeKey)
      .maybeSingle();
    if (raced) return { row: raced as RawSourceEventRow, replayed: true };
    throw error;
  }

  // Re-fetch by the unique dedupe key: unambiguous in every environment
  // (some Supabase clients/proxies do not return the row from INSERT ... RETURNING).
  const { data: inserted } = await client
    .from('raw_source_events')
    .select('*')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (!inserted) {
    throw new Error('Failed to read back the persisted webhook event row.');
  }

  return { row: inserted as RawSourceEventRow, replayed: false };
}

/**
 * Marks a persisted event's status. Best-effort: a failure to write the
 * status transition is logged, never thrown — the pipeline must not fail
 * because the audit trail update failed. The update is scoped to BOTH the
 * event id and its workspace so a malformed or cross-workspace job message
 * can never mutate another workspace's event.
 */
export async function updateEventStatus(
  eventId: string,
  patch: Partial<Pick<RawSourceEventRow, 'status' | 'resulting_thread_id' | 'sop_id' | 'error_message' | 'processed_at'>>,
  workspaceId: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('raw_source_events').update(patch).eq('id', eventId).eq('workspace_id', workspaceId);
    if (error) throw error;
  } catch (err) {
    logger.warn('[WebhookService Warning] Failed to update raw_source_events status:', err);
  }
}

export interface ThreadProcessResult {
  outcome: 'sop_created' | 'sop_linked' | 'no_sop';
  rawThreadId: string;
  sopId?: string;
}

/**
 * Core thread-ingestion work (raw thread upsert -> source document + chunks
 * -> LLM SOP extraction -> conflict detection -> embedding -> SOP insert).
 * Extracted from the old synchronous webhook routes so the durable pipeline
 * can run it inside the webhook consumer without any HTTP response coupling.
 *
 * Throws on failures that previously produced 500/422 responses; the caller
 * (worker) records the error on the event ledger and the idempotency key.
 */
export async function processThreadCore(
  payload: ThreadPayload,
  opts: { client?: SupabaseClient; sourceTrust?: 'manual' | 'crawled' } = {},
): Promise<ThreadProcessResult> {
  const { workspace_id, source, external_thread_id, channel_or_project, messages } = payload;
  const client = opts.client ?? supabase;
  const sourceTrust = opts.sourceTrust ?? 'crawled';

  // Store raw thread
  const { data: rawThread, error: rawErr } = await client
    .from('raw_threads')
    .upsert(
      {
        workspace_id,
        source,
        external_thread_id,
        channel_or_project,
        raw_content: messages,
        is_processed: false,
      },
      { onConflict: 'workspace_id, source, external_thread_id' },
    )
    .select('*')
    .single();

  if (rawErr) {
    throw new Error(`Database storage error for raw thread: ${rawErr.message}`);
  }

  const { sourceDocument, extractedSOP } = await processThreadTail({
    workspaceId: workspace_id,
    source,
    externalId: external_thread_id,
    title: `${source}:${channel_or_project}:${external_thread_id}`,
    messages,
    sourceTrust,
    rawThreadId: rawThread.id,
    metadata: { channel_or_project },
    client,
  });

  if (!extractedSOP) {
    return { outcome: 'no_sop', rawThreadId: rawThread.id };
  }

  // Phase 3 (ADR-T15): resolve the SOP's entity/relationship mentions into the
  // canonical corpus tables and project enum-compatible relationships into the
  // legacy graph. Canonical write failures fail the job (retryable); graph
  // projection failures are logged only, never fatal.
  if ((extractedSOP.entities?.length ?? 0) > 0 || (extractedSOP.relationships?.length ?? 0) > 0) {
    await resolveEntitiesForDocument({
      workspaceId: workspace_id,
      sourceDocumentId: sourceDocument?.id ?? rawThread.id,
      entities: extractedSOP.entities ?? [],
      relationships: extractedSOP.relationships ?? [],
      client,
    });
  }

  // Conflict detection — check if this SOP duplicates an existing one using pgvector
  const conflict = await detectConflict(extractedSOP.title, extractedSOP.trigger_condition, workspace_id);

  if (conflict.has_conflict && conflict.matching_sop_id) {
    await supabase.from('sop_citations').insert({
      sop_id: conflict.matching_sop_id,
      raw_thread_id: rawThread.id,
    });

    // Phase 3 (B3): ground the matched SOP in the document's claims. Throws on
    // failure so the event retries (idempotent (sop_id, claim_id) upsert); the
    // retry re-enters the conflict path and converges.
    if (sourceDocument) {
      await linkDocumentClaimsToSop({
        workspaceId: workspace_id,
        sopId: conflict.matching_sop_id,
        sourceDocumentId: sourceDocument.id,
        client,
      });
    }

    await supabase.from('raw_threads').update({ is_processed: true }).eq('id', rawThread.id);

    return { outcome: 'sop_linked', rawThreadId: rawThread.id, sopId: conflict.matching_sop_id };
  }

  // Generate vector embedding for the SOP — never insert an SOP without one.
  let sopEmbedding: number[] | null = null;
  try {
    sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);
  } catch (embErr) {
    await recordEmbeddingFailure({
      workspaceId: workspace_id,
      source,
      rawContent: `${extractedSOP.title}: ${extractedSOP.trigger_condition}`,
      error: embErr,
    });
    throw embErr;
  }

  // Save as Draft SOP with Risk Level, Human Gate Policy, and vector embedding
  const insertPayload: Record<string, any> = {
    workspace_id,
    title: extractedSOP.title,
    category: extractedSOP.category,
    trigger_condition: extractedSOP.trigger_condition,
    preconditions: extractedSOP.preconditions,
    execution_steps: extractedSOP.execution_steps,
    risk_level: extractedSOP.risk_level || 'Low',
    requires_human_gate: extractedSOP.requires_human_gate || false,
    // Phase 3 (B2): persist the extraction confidence the extractor computed
    // but never stored (migration 037).
    confidence_score: extractedSOP.confidence_score,
    source_doc_id: sourceDocument?.id || rawThread.id,
    status: 'Draft',
    version: 1,
    last_confirmed_at: new Date().toISOString(),
    is_stale: false,
  };

  if (sopEmbedding) {
    insertPayload.embedding = sopEmbedding;
  }

  let { data: sopData, error: sopErr } = await supabase
    .from('skills_sops')
    .insert(insertPayload)
    .select()
    .single();

  if (
    sopErr &&
    (sopErr.message.includes('embedding') || sopErr.message.includes('risk_level') || sopErr.message.includes('column'))
  ) {
    logger.warn('[Ingestion Warning] Column missing in schema, inserting without extended vector/risk columns.');
    delete insertPayload.embedding;
    delete insertPayload.risk_level;
    delete insertPayload.requires_human_gate;
    delete insertPayload.confidence_score;

    const retry = await supabase.from('skills_sops').insert(insertPayload).select().single();
    sopData = retry.data;
    sopErr = retry.error;
  }

  if (sopErr || !sopData) {
    throw new Error(`Failed to create SOP record: ${sopErr?.message ?? 'no row returned'}`);
  }

  // Create initial version snapshot
  await createVersion(sopData.id, 'system', 'initial_extraction');

  // Citation link
  await supabase.from('sop_citations').insert({
    sop_id: sopData.id,
    raw_thread_id: rawThread.id,
  });

  // Phase 3 (B3): ground the new SOP in the document's claims — the SOP is
  // ungrounded until the top-confidence claims of its source document are
  // linked via sop_citations.claim_id (plus the claim's chunk_id). Throws on
  // failure so the event retries; a retry converges idempotently via
  // detectConflict -> sop_linked -> linkage.
  if (sourceDocument) {
    await linkDocumentClaimsToSop({
      workspaceId: workspace_id,
      sopId: sopData.id,
      sourceDocumentId: sourceDocument.id,
      client,
    });
  }

  await supabase.from('raw_threads').update({ is_processed: true }).eq('id', rawThread.id);

  logger.info(`[Ingestion Success] Created Draft SOP "${sopData.title}" (ID: ${sopData.id}) [Risk: ${sopData.risk_level}]`);

  return { outcome: 'sop_created', rawThreadId: rawThread.id, sopId: sopData.id };
}
