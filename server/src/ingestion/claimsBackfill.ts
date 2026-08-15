// Phase 3: knowledge-claims backfill (ADR-T15 backfill-worker step).
//
// Re-derives knowledge_claims from STORED chunks for source documents whose
// chunks exist but whose claims were never extracted — documents completed
// before the claim pipeline landed (036_knowledge_corpus) or rows that
// slipped past the claims stage.
//
// Design invariants:
//   - Resumable by checkpoint, not by queue: a row's claims_derived_at IS
//     the cursor. Re-running a batch re-picks the same documents and the
//     knowledge_claims unique key makes re-derivation a no-op.
//   - Poisoned-document quarantine: a document whose extraction keeps
//     failing increments claims_backfill_failures and is dropped from the
//     candidate scan after CLAIMS_BACKFILL_MAX_FAILURES, so one bad chunk
//     never retries forever on every sweep. A later backfill version can
//     reset the counter and retry deliberately.
//   - Claims-only: this stage never touches parsing/embedding/SOPs — it
//     consumes persisted document_chunks rows and writes knowledge_claims +
//     claim_evidence through the same idempotent store the pipeline uses.

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { hashContent, estimateTokens, type TextChunk } from './chunker.js';
import { extractClaimsFromChunk, type ExtractedClaim } from '../knowledge/claimExtractor.js';
import { persistClaims } from '../knowledge/claimStore.js';

/** Version tag stamped on every row the backfill derives. A future extractor
 *  revision bumps this and the worker can re-derive the whole corpus. */
export const CLAIMS_BACKFILL_VERSION = 'v1';

/** Quarantine threshold: documents that fail this many backfill attempts are
 *  excluded from future candidate scans. */
export const CLAIMS_BACKFILL_MAX_FAILURES = 3;

export const DEFAULT_BACKFILL_BATCH_LIMIT = 20;

export interface ClaimsBackfillCandidate {
  id: string;
  workspace_id: string;
  title: string | null;
}

export interface DeriveClaimsResult {
  documentId: string;
  chunkCount: number;
  claimsPersisted: number;
}

export interface BackfillBatchResult {
  scanned: number;
  succeeded: number;
  failed: number;
  claimsPersisted: number;
}

/**
 * Candidate scan: source documents that (a) completed the ingestion pipeline
 * (chunks are persisted and stable), (b) have no claims checkpoint yet, and
 * (c) have not been quarantined by repeated backfill failures. Oldest first,
 * bounded by `limit` so each sweep is a small, rate-limit-friendly unit of
 * work. 'failed' extraction_stage rows are NOT candidates: their denormal
 * pipeline must be re-run (re-upload / DLQ replay) — re-deriving claims from
 * partial chunks would fabricate an unparsed document's coverage.
 */
export async function findClaimsBackfillCandidates(opts: {
  limit?: number;
  client?: SupabaseClient;
}): Promise<ClaimsBackfillCandidate[]> {
  const client = opts.client || supabase;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_BACKFILL_BATCH_LIMIT, 200));

  const { data, error } = await client
    .from('source_documents')
    .select('id, workspace_id, title')
    .eq('extraction_stage', 'completed')
    .is('claims_derived_at', null)
    .lt('claims_backfill_failures', CLAIMS_BACKFILL_MAX_FAILURES)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to scan claims backfill candidates: ${error.message}`);
  }
  return (data ?? []) as ClaimsBackfillCandidate[];
}

/**
 * Stamps the claims checkpoint on a document row. Called by the backfill
 * worker after it re-derives claims AND by the live ingestion paths
 * (processThreadTail for threads/crawlers, the parse_document upload worker)
 * after a successful claim extraction, so only genuinely-missing documents
 * ever become backfill candidates. Idempotent.
 */
export async function stampClaimsDerived(opts: {
  documentId: string;
  workspaceId: string;
  client?: SupabaseClient;
}): Promise<void> {
  const client = opts.client || supabase;
  const { error } = await client
    .from('source_documents')
    .update({
      claims_derived_at: new Date().toISOString(),
      claims_derived_version: CLAIMS_BACKFILL_VERSION,
      claims_backfill_failures: 0,
    })
    .eq('id', opts.documentId)
    .eq('workspace_id', opts.workspaceId);

  if (error) {
    throw new Error(`Claims backfill: failed to stamp claims_derived_at for document ${opts.documentId}: ${error.message}`);
  }
}

/**
 * Re-derives and persists claims for ONE document from its stored chunks.
 * Throws on extraction/persistence failure — the batch caller decides
 * quarantine vs retry. Idempotent: a re-run of an already-derived document
 * upserts the same rows (unique key) and re-stamps the checkpoint.
 */
export async function deriveClaimsForDocument(opts: {
  documentId: string;
  workspaceId: string;
  client?: SupabaseClient;
}): Promise<DeriveClaimsResult> {
  const client = opts.client || supabase;

  const { data: docRow, error: docErr } = await client
    .from('source_documents')
    .select('id, workspace_id, title, source, extraction_stage')
    .eq('id', opts.documentId)
    .eq('workspace_id', opts.workspaceId)
    .maybeSingle();

  if (docErr || !docRow) {
    throw new Error(
      `Claims backfill: document ${opts.documentId} not found in workspace ${opts.workspaceId}: ${docErr?.message ?? 'no row'}`
    );
  }
  if (docRow.extraction_stage !== 'completed') {
    throw new Error(
      `Claims backfill: document ${opts.documentId} is in extraction_stage='${docRow.extraction_stage}'; only completed documents are backfilleable.`
    );
  }

  const { data: chunkRows, error: chunkErr } = await client
    .from('document_chunks')
    .select('id, chunk_index, content, metadata')
    .eq('workspace_id', opts.workspaceId)
    .eq('source_document_id', opts.documentId)
    .order('chunk_index', { ascending: true });

  if (chunkErr) {
    throw new Error(`Claims backfill: failed to read chunks for document ${opts.documentId}: ${chunkErr.message}`);
  }

  // Reconstitute TextChunk[] the way the pipeline would have produced them:
  // the extractor's grounding math only consumes `content`, and the store
  // needs real chunk ids — recomputing hashes keeps the rows self-consistent
  // without re-reading the raw object.
  const chunks: TextChunk[] = (chunkRows ?? []).map((r: any) => ({
    chunk_index: r.chunk_index,
    content: r.content,
    content_hash: hashContent(r.content),
    token_count_estimate: estimateTokens(r.content),
    metadata: r.metadata ?? {},
  }));

  const groupedClaims: Array<{ chunkId: string; claims: ExtractedClaim[] }> = [];
  for (let i = 0; i < chunks.length; i++) {
    const claims = await extractClaimsFromChunk(chunks[i], {
      workspaceId: opts.workspaceId,
      source: docRow.source ?? 'backfill',
    });
    if (claims.length > 0) {
      groupedClaims.push({ chunkId: (chunkRows as any[])[i].id, claims });
    }
  }

  let claimsPersisted = 0;
  if (groupedClaims.length > 0) {
    const persisted = await persistClaims({
      workspaceId: opts.workspaceId,
      sourceDocumentId: opts.documentId,
      groupedClaims,
      client,
    });
    claimsPersisted = persisted.length;
  }

  // Stamp the checkpoint. A document with zero chunks still gets stamped:
  // there is nothing further to re-derive, and it must not re-enter the scan
  // on every sweep.
  await stampClaimsDerived({ documentId: opts.documentId, workspaceId: opts.workspaceId, client });

  return {
    documentId: opts.documentId,
    chunkCount: (chunkRows ?? []).length,
    claimsPersisted,
  };
}

async function incrementClaimsBackfillFailures(
  documentId: string,
  workspaceId: string,
  client: SupabaseClient
): Promise<void> {
  try {
    const { data: row } = await client
      .from('source_documents')
      .select('claims_backfill_failures')
      .eq('id', documentId)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const current = Number((row as any)?.claims_backfill_failures || 0);
    const { error } = await client
      .from('source_documents')
      .update({ claims_backfill_failures: current + 1 })
      .eq('id', documentId)
      .eq('workspace_id', workspaceId);
    if (error) {
      logger.warn('claims_backfill_failure_counter_update_failed', {
        documentId,
        workspaceId,
        message: error.message,
      });
    }
  } catch (err) {
    logger.warn('claims_backfill_failure_counter_read_failed', {
      documentId,
      workspaceId,
      message: (err as Error).message,
    });
  }
}

/**
 * One batch of work: scan up to `limit` candidates and derive claims for each,
 * sequentially (LLM-extraction is the shared, rate-limited resource — the
 * worker intentionally runs concurrency 1). A failing document increments its
 * quarantine counter and does not block the rest of the batch; the checkpoint
 * only advances for documents that actually derived.
 */
export async function processClaimsBackfillBatch(opts: {
  limit?: number;
  client?: SupabaseClient;
}): Promise<BackfillBatchResult> {
  const client = opts.client || supabase;
  const candidates = await findClaimsBackfillCandidates({ limit: opts.limit, client });

  const result: BackfillBatchResult = { scanned: candidates.length, succeeded: 0, failed: 0, claimsPersisted: 0 };

  for (const candidate of candidates) {
    try {
      const derived = await deriveClaimsForDocument({
        documentId: candidate.id,
        workspaceId: candidate.workspace_id,
        client,
      });
      result.succeeded += 1;
      result.claimsPersisted += derived.claimsPersisted;
      logger.info('claims_backfill_document_derived', {
        documentId: candidate.id,
        workspaceId: candidate.workspace_id,
        chunkCount: derived.chunkCount,
        claimsPersisted: derived.claimsPersisted,
      });
    } catch (err) {
      result.failed += 1;
      await incrementClaimsBackfillFailures(candidate.id, candidate.workspace_id, client);
      logger.warn('claims_backfill_document_failed', {
        documentId: candidate.id,
        workspaceId: candidate.workspace_id,
        title: candidate.title,
        failures: CLAIMS_BACKFILL_MAX_FAILURES,
        message: (err as Error).message,
      });
    }
  }

  return result;
}

/**
 * Sequencing-friendly estimate used by /health: how many documents are still
 * waiting in the backfill queue right now.
 */
export async function countClaimsBackfillPending(client?: SupabaseClient): Promise<number> {
  const c = client || supabase;
  const { data, error } = await c
    .from('source_documents')
    .select('id')
    .eq('extraction_stage', 'completed')
    .is('claims_derived_at', null)
    .lt('claims_backfill_failures', CLAIMS_BACKFILL_MAX_FAILURES);
  if (error || !Array.isArray(data)) {
    logger.warn('claims_backfill_pending_count_failed', { message: error?.message ?? 'no rows returned' });
    return 0;
  }
  return data.length;
}