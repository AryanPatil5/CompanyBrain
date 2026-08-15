// Phase 4 T2: embedding backfill core. Re-embeds the EXISTING document_chunks
// corpus against the CURRENT selected embedding provider (singleton from
// embeddingProvider.ts) so every row carries provider-returned
// embedding_model/embedding_version metadata (migration 036), exact
// content_hash (canonical chunker hash), and a real vector — the honest
// Phase 4 replacement for the padded/pseudo vectors of earlier phases.
//
// Design invariants:
// - Safe from the top down: a chunk is NEVER blinded before a replacement
//   exists. The only write for a chunk is a single atomic conditional UPDATE
//   (WHERE id AND workspace AND content AND content_hash match the observed
//   row) that sets {embedding, embedding_model, embedding_version,
//   updated_at}. A concurrent ingestion write (content swapped under us, row
//   deleted) makes the update a no-op (0 rows) and is reported as
//   concurrent_modification — never overwritten, never doubled.
// - Skip-when-current: chunks already current for the provider make ZERO
//   provider calls: embedding present AND embedding_model == provider.model
//   AND embedding_version == provider.version AND content_hash ==
//   hashContent(content). force=true bypasses everything.
// - Retry semantics: per-chunk failure isolation. Non-retryable provider
//   failures (EmbeddingError.retryable=false, e.g. config errors, dimension
//   mismatch) quarantine the chunk in a process-bounded in-memory set
//   (cleared at worker start) — re-attempting every sweep is wasted work.
//   Retryable failures are recounted next sweep. Batch-level DB/scan errors
//   throw (BullMQ job retry). Never fake completion on partial failure:
//   result counts are honest (spec §19).
// - No whole-corpus loads: keyset pagination (id DESC, cursor < last id),
//   bounded concurrency pool, sliding-window rate limiter.
// - Cost meter: best-effort recordUsage per workspace (units = reembedded),
//   honest zeros (tokens 0, costPerUnitCents 0) — never fabricated amounts.
//
// Job shape (scheduler template): { job_name:'batch', workspaceId?, batchSize?,
// cursor?, force? }. The worker persists nextCursor back into the scheduler
// template so restarts resume (keyset < cursor); a stale/missing cursor just
// re-scans and skips — skip-when-current makes correctness cursor-independent.

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { hashContent } from './chunker.js';
import { EmbeddingError } from '../services/aiProvider.js';
import {
  getEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '../services/embeddingProvider.js';
import { recordUsage, usageFromContext } from '../services/costMeter.js';

export interface EmbeddingBackfillJobData {
  job_name: 'batch';
  workspaceId?: string;
  batchSize?: number;
  cursor?: string | null;
  force?: boolean;
}

export interface ChunkRow {
  id: string;
  workspace_id: string;
  source_document_id: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  embedding: unknown;
  embedding_model: string | null;
  embedding_version: string | null;
  updated_at?: unknown;
}

export type ChunkStaleReason =
  | 'missing_embedding'
  | 'model_mismatch'
  | 'version_mismatch'
  | 'content_hash_mismatch'
  | 'force';

export interface EmbeddingBackfillBatchResult {
  scanned: number;
  skippedCurrent: number;
  skippedQuarantined: number;
  reembedded: number;
  failed: number;
  retryableFailures: number;
  permanentFailures: number;
  concurrentModifications: number;
  durationMs: number;
  nextCursor: string | null;
}

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const POISON_SET_CAP = 10_000;

export function embeddingBackfillConfig() {
  return {
    batchSize: parseIntEnv('EMBEDDING_BACKFILL_BATCH_SIZE', DEFAULT_BATCH_SIZE),
    concurrency: parseIntEnv('EMBEDDING_BACKFILL_CONCURRENCY', DEFAULT_CONCURRENCY),
    rateLimitPerMinute: parseIntEnv('EMBEDDING_BACKFILL_RATE_LIMIT', DEFAULT_RATE_LIMIT_PER_MINUTE),
    intervalMs: parseIntEnv('EMBEDDING_BACKFILL_INTERVAL_MS', 60_000),
  };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Process-bounded quarantine for non-retryable chunk failures. Bounded;
// cleared at worker start so a restarted sweep can re-attempt (and re-fail,
// this time with the worker's full visibility).
const poisonedChunkIds = new Set<string>();
const poisonedOrder: string[] = [];
let lastBatchResult: EmbeddingBackfillBatchResult | null = null;
let batchRunning = false;

export function getLastEmbeddingBackfillBatch(): EmbeddingBackfillBatchResult | null {
  return lastBatchResult;
}

export function isEmbeddingBackfillRunning(): boolean {
  return batchRunning;
}

export function resetEmbeddingBackfillState(): void {
  poisonedChunkIds.clear();
  poisonedOrder.length = 0;
  lastBatchResult = null;
  batchRunning = false;
}

export function poisonedChunkCount(): number {
  return poisonedChunkIds.size;
}

function quarantineChunkId(chunkId: string): void {
  if (!poisonedChunkIds.has(chunkId)) {
    poisonedChunkIds.add(chunkId);
    poisonedOrder.push(chunkId);
    if (poisonedOrder.length > POISON_SET_CAP) {
      const evicted = poisonedOrder.splice(0, Math.floor(POISON_SET_CAP / 2));
      for (const id of evicted) poisonedChunkIds.delete(id);
    }
  }
}

export function isChunkQuarantined(chunkId: string): boolean {
  return poisonedChunkIds.has(chunkId);
}

/**
 * Staleness classification (provider is the single source of truth — never
 * re-read env). content_hash mismatch covers: edited content, hash-algorithm
 * change, or rows written by older code without a canonical hash.
 */
export function chunkStaleReason(
  chunk: Pick<ChunkRow, 'embedding' | 'embedding_model' | 'embedding_version' | 'content' | 'content_hash'>,
  provider: EmbeddingProvider,
  force: boolean
): ChunkStaleReason | null {
  if (force) return 'force';
  if (!Array.isArray(chunk.embedding) || chunk.embedding.length !== provider.expectedDimensions) {
    return 'missing_embedding';
  }
  if (chunk.embedding_model !== provider.model) return 'model_mismatch';
  if (chunk.embedding_version !== provider.version) return 'version_mismatch';
  if (chunk.content_hash !== hashContent(chunk.content)) return 'content_hash_mismatch';
  return null;
}

/**
 * One deterministic keyset page over the corpus: id DESC (uuid PK, stable
 * order; older chunk ids sort after newer ones), resumed via cursor = last
 * processed id (WHERE id < cursor). Never the whole table. When cursor points
 * past the corpus tail, the page is simply empty — nothing runs, nothing is
 * corrupted (spec §12 stale-cursor safety).
 */
export async function scanChunkPage(opts: {
  workspaceId?: string;
  cursor?: string | null;
  batchSize?: number;
  client?: SupabaseClient;
}): Promise<ChunkRow[]> {
  const client = opts.client || supabase;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? DEFAULT_BATCH_SIZE, 500));
  let query = client
    .from('document_chunks')
    .select('id, workspace_id, source_document_id, chunk_index, content, content_hash, embedding, embedding_model, embedding_version, updated_at');
  if (opts.workspaceId) {
    query = query.eq('workspace_id', opts.workspaceId);
  }
  if (opts.cursor) {
    query = query.lt('id', opts.cursor);
  }
  const { data, error } = await query.order('id', { ascending: false }).limit(batchSize);
  if (error) {
    throw new Error(`embedding backfill page scan failed: ${error.code} ${error.message}`);
  }
  return (data ?? []) as unknown as ChunkRow[];
}

/**
 * Replacement-vector validation: non-empty finite numbers at exactly the
 * provider's expected dimension. Throws a NON-retryable EmbeddingError on
 * violation (a malformed/buggy provider response can never reach the row).
 */
export function validateReplacementVector(result: EmbeddingResult, provider: EmbeddingProvider): void {
  const v = result.vector;
  if (!Array.isArray(v) || v.length !== provider.expectedDimensions) {
    throw new EmbeddingError('embedding_invalid_response', 'embedding backfill: provider returned a malformed vector', {
      provider: provider.name,
      retryable: false,
    });
  }
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new EmbeddingError('embedding_invalid_response', 'embedding backfill: provider returned a non-finite vector component', {
        provider: provider.name,
        retryable: false,
      });
    }
  }
}

/**
 * Re-embeds ONE chunk and atomically conditionally-persists ONLY when the
 * row is still exactly what we observed (content + content_hash). Returns
 * outcomes; the only throwers are provider errors (isolated by caller) and
 * DB errors (batch-level retry). Never sets embedding to NULL first.
 */
export async function reembedChunk(opts: {
  chunk: ChunkRow;
  provider: EmbeddingProvider;
  client?: SupabaseClient;
}): Promise<{ status: 'reembedded'; model: string; version: string } | { status: 'concurrent_modification' }> {
  const { chunk, provider } = opts;
  const client = opts.client || supabase;
  const observedContent = chunk.content;
  const observedContentHash = chunk.content_hash;

  const result = await provider.embed(observedContent);
  validateReplacementVector(result, provider);

  const { data, error } = await client
    .from('document_chunks')
    .update({
      embedding: result.vector,
      embedding_model: result.model,
      embedding_version: result.version,
      content_hash: hashContent(observedContent),
      updated_at: new Date().toISOString(),
    })
    .eq('id', chunk.id)
    .eq('workspace_id', chunk.workspace_id)
    .eq('content', observedContent)
    .eq('content_hash', observedContentHash)
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`embedding backfill persist failed: ${error.code} ${error.message}`);
  }
  if (!data) {
    // Zero rows updated: concurrent write (content/hash changed or row
    // deleted) — the row now holds the newer state; leave it untouched.
    return { status: 'concurrent_modification' };
  }
  return { status: 'reembedded', model: result.model, version: result.version };
}

// ─── Bounded concurrency + rate limiting ─────────────────────────────────

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private inFlight = 0;
  constructor(
    private readonly maxPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  get useCount(): number {
    return this.timestamps.length;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      const cutoff = t - this.windowMs;
      this.timestamps = this.timestamps.filter((s) => s > cutoff);
      if (this.timestamps.length < this.maxPerWindow) {
        this.timestamps.push(t);
        this.inFlight += 1;
        return;
      }
      await sleep(10);
    }
  }

  release(): void {
    this.inFlight -= 1;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs fn over items with at most `concurrency` calls in flight at once. */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const n = Math.max(1, concurrency);
  let index = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = index;
      index += 1;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

// ─── Batch processing ────────────────────────────────────────────────────

export interface ProcessEmbeddingBackfillBatchOpts {
  workspaceId?: string;
  batchSize?: number;
  cursor?: string | null;
  force?: boolean;
  provider?: EmbeddingProvider;
  client?: SupabaseClient;
  now?: () => number;
}

/**
 * ONE bounded sweep. Throws only on scan-level DB failure (job retries).
 * Per-chunk outcomes are counted, never thrown; the result never fakes
 * completion. Cost metering is best-effort and never throws.
 */
export async function processEmbeddingBackfillBatch(
  opts: ProcessEmbeddingBackfillBatchOpts = {}
): Promise<EmbeddingBackfillBatchResult> {
  const startedAt = Date.now();
  const cfg = embeddingBackfillConfig();
  const provider = opts.provider || getEmbeddingProvider();
  const client = opts.client || supabase;
  const batchSize = opts.batchSize ?? cfg.batchSize;
  const force = opts.force ?? false;
  const now = opts.now ?? Date.now;

  batchRunning = true;
  logger.info('embedding_backfill_batch_started', {
    jobName: 'batch',
    workspaceId: opts.workspaceId ?? '(all workspaces)',
    batchSize,
    cursor: opts.cursor ?? null,
    force,
    provider: provider.name,
    model: provider.model,
    version: provider.version,
    expectedDimensions: provider.expectedDimensions,
  });

  const page = await scanChunkPage({
    workspaceId: opts.workspaceId,
    cursor: opts.cursor,
    batchSize,
    client,
  });
  logger.debug('embedding_backfill_page_discovered', { scanned: page.length });

  const result: EmbeddingBackfillBatchResult = {
    scanned: page.length,
    skippedCurrent: 0,
    skippedQuarantined: 0,
    reembedded: 0,
    failed: 0,
    retryableFailures: 0,
    permanentFailures: 0,
    concurrentModifications: 0,
    durationMs: 0,
    // A partial page means the corpus is drained: the next sweep restarts
    // from the head (skip-when-current absorbs the re-scan). A full page
    // advances the keyset cursor to the last processed id.
    nextCursor: page.length < batchSize ? null : page.length > 0 ? page[page.length - 1].id : null,
  };

  const toReembed: Array<{ chunk: ChunkRow; reason: ChunkStaleReason }> = [];
  for (const chunk of page) {
    if (isChunkQuarantined(chunk.id)) {
      result.skippedQuarantined += 1;
      logger.debug('embedding_backfill_chunk_skipped', { chunkId: chunk.id, workspaceId: chunk.workspace_id, reason: 'quarantined' });
      continue;
    }
    const reason = chunkStaleReason(chunk, provider, force);
    if (reason === null) {
      result.skippedCurrent += 1;
      logger.debug('embedding_backfill_chunk_skipped', { chunkId: chunk.id, workspaceId: chunk.workspace_id, reason: 'current' });
      continue;
    }
    toReembed.push({ chunk, reason });
  }

  const rateLimiter = new SlidingWindowRateLimiter(cfg.rateLimitPerMinute, 60_000, now);
  const workspaceCounts = new Map<string, number>();
  const embeddedModels = new Map<string, string>();
  const embeddedVersions = new Map<string, string>();

  await runWithConcurrency(toReembed, cfg.concurrency, async ({ chunk, reason }) => {
    await rateLimiter.acquire();
    try {
      logger.debug('embedding_backfill_chunk_stale', {
        chunkId: chunk.id,
        workspaceId: chunk.workspace_id,
        reason,
        provider: provider.name,
        model: provider.model,
        version: provider.version,
      });
      const outcome = await reembedChunk({ chunk, provider, client });
      if (outcome.status === 'reembedded') {
        result.reembedded += 1;
        workspaceCounts.set(chunk.workspace_id, (workspaceCounts.get(chunk.workspace_id) ?? 0) + 1);
        embeddedModels.set(chunk.workspace_id, outcome.model);
        embeddedVersions.set(chunk.workspace_id, outcome.version);
        logger.info('embedding_backfill_chunk_reembedded', {
          chunkId: chunk.id,
          workspaceId: chunk.workspace_id,
          sourceDocumentId: chunk.source_document_id,
          provider: provider.name,
          model: outcome.model,
          version: outcome.version,
        });
      } else {
        result.concurrentModifications += 1;
        logger.warn('embedding_backfill_concurrent_modification', {
          chunkId: chunk.id,
          workspaceId: chunk.workspace_id,
        });
      }
    } catch (err) {
      const retryable = !(err instanceof EmbeddingError) || err.retryable !== false;
      result.failed += 1;
      if (retryable) {
        result.retryableFailures += 1;
      } else {
        result.permanentFailures += 1;
        quarantineChunkId(chunk.id);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('embedding_backfill_chunk_failed', {
        chunkId: chunk.id,
        workspaceId: chunk.workspace_id,
        retryable,
        message,
      });
    } finally {
      rateLimiter.release();
    }
  });

  result.durationMs = Date.now() - startedAt;
  lastBatchResult = result;
  batchRunning = false;

  for (const [workspaceId, count] of workspaceCounts) {
    const model = embeddedModels.get(workspaceId) ?? provider.model;
    const version = embeddedVersions.get(workspaceId) ?? provider.version;
    void recordUsage(
      usageFromContext(
        provider.name,
        model,
        { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        Math.round(result.durationMs),
        workspaceId
      )
    );
    logger.debug('embedding_backfill_usage_recorded', {
      workspaceId,
      provider: provider.name,
      model,
      version,
      chunksReembedded: count,
    });
  }

  logger.info('embedding_backfill_batch_completed', {
    workspaceId: opts.workspaceId ?? '(all workspaces)',
    scanned: result.scanned,
    skippedCurrent: result.skippedCurrent,
    skippedQuarantined: result.skippedQuarantined,
    reembedded: result.reembedded,
    failed: result.failed,
    retryableFailures: result.retryableFailures,
    permanentFailures: result.permanentFailures,
    concurrentModifications: result.concurrentModifications,
    nextCursor: result.nextCursor,
    durationMs: result.durationMs,
  });

  return result;
}

/**
 * BullMQ `batch` processor (queue-free seam — same pattern as
 * processClaimsBackfillJob). Accepts the structural job shape so the core
 * module never imports bullmq; the worker module wraps this and persists the
 * returned cursor into the scheduler template.
 */
export async function processEmbeddingBackfillJob(job: {
  id?: string;
  data: EmbeddingBackfillJobData;
}): Promise<EmbeddingBackfillBatchResult> {
  const data = job.data ?? ({} as EmbeddingBackfillJobData);
  logger.debug('embedding_backfill_job_received', {
    jobId: job.id ?? null,
    workspaceId: data.workspaceId ?? null,
    cursor: data.cursor ?? null,
    force: data.force ?? false,
    batchSize: data.batchSize ?? null,
  });
  return processEmbeddingBackfillBatch({
    workspaceId: data.workspaceId,
    batchSize: data.batchSize,
    cursor: data.cursor ?? null,
    force: data.force ?? false,
  });
}