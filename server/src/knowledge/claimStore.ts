// Phase 3: claim store — idempotent persistence of atomic claims with
// char-offset evidence. Workspace-scoped on every row; dedupe by
// (workspace_id, source_document_id, chunk_id, claim_text_hash) so
// reprocessing a chunk never duplicates claims or evidence.

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { hashContent } from '../ingestion/chunker.js';
import type { ExtractedClaim } from './claimExtractor.js';

export interface PersistClaimsInput {
  workspaceId: string;
  sourceDocumentId: string;
  /** Claims grouped by the chunk they were extracted from. */
  groupedClaims: Array<{ chunkId: string; claims: ExtractedClaim[] }>;
  client?: SupabaseClient;
}

export interface PersistedClaim {
  id: string;
  workspace_id: string;
  source_document_id: string;
  chunk_id: string;
  claim_text: string;
  claim_text_hash: string;
  claim_type: string;
  confidence: number;
  status: string;
  ai_generated: boolean;
}

/**
 * Upserts a claim row and its evidence row. Idempotent:
 *   - knowledge_claims UNIQUE (workspace_id, source_document_id, chunk_id, claim_text_hash)
 *   - claim_evidence UNIQUE (claim_id, chunk_id)
 * A re-extracted identical claim reuses the original row id, so evidence
 * never duplicates either.
 */
async function persistOne(
  client: SupabaseClient,
  workspaceId: string,
  sourceDocumentId: string,
  chunkId: string,
  claim: ExtractedClaim
): Promise<PersistedClaim | null> {
  // Grounded claims only: evidence must reference a real chunk row in this
  // workspace. Reject unknown/foreign chunk ids instead of persisting
  // ungrounded evidence (FK failure deferred into a clear error).
  const { data: chunkRow, error: chunkErr } = await client
    .from('document_chunks')
    .select('id')
    .eq('id', chunkId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (chunkErr || !chunkRow) {
    throw new Error(
      `Refusing to persist claim for unknown chunk ${chunkId} in workspace ${workspaceId}: ${chunkErr?.message ?? 'no such chunk'}`
    );
  }

  const claimTextHash = hashContent(claim.claim_text);

  const { error: upsertErr } = await client
    .from('knowledge_claims')
    .upsert(
      {
        workspace_id: workspaceId,
        source_document_id: sourceDocumentId,
        chunk_id: chunkId,
        claim_text: claim.claim_text,
        claim_text_hash: claimTextHash,
        claim_type: claim.claim_type,
        confidence: claim.confidence,
        status: 'draft',
        ai_generated: true,
        properties: {
          source: 'claim_extractor',
          char_start: claim.char_start,
          char_end: claim.char_end,
        },
      },
      { onConflict: 'workspace_id, source_document_id, chunk_id, claim_text_hash' }
    );

  if (upsertErr) {
    throw new Error(`Failed to persist knowledge claim: ${upsertErr.message}`);
  }

  // Read back by the deterministic dedupe key — unambiguous in every
  // environment (supabase INSERT...RETURNING is not guaranteed on upsert).
  const { data: row, error: readErr } = await client
    .from('knowledge_claims')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_document_id', sourceDocumentId)
    .eq('chunk_id', chunkId)
    .eq('claim_text_hash', claimTextHash)
    .maybeSingle();

  if (readErr || !row) {
    throw new Error(`Failed to read back persisted knowledge claim: ${readErr?.message ?? 'no row returned'}`);
  }

  const { error: evidenceErr } = await client
    .from('claim_evidence')
    .upsert(
      {
        workspace_id: workspaceId,
        claim_id: row.id,
        chunk_id: chunkId,
        char_start: claim.char_start,
        char_end: claim.char_end,
        source_document_id: sourceDocumentId,
        provenance_json: {
          claim_text_hash: claimTextHash,
          evidence_span: `${claim.char_start}:${claim.char_end}`,
        },
      },
      { onConflict: 'claim_id, chunk_id' }
    );

  if (evidenceErr) {
    throw new Error(`Failed to persist claim evidence: ${evidenceErr.message}`);
  }

  return row as PersistedClaim;
}

/**
 * Persists all claims for a document, grouped per chunk. Every claim is
 * grounded in a specific chunk (evidence offsets + chunk id). Claims for
 * chunks without persisted rows are rejected (grounded claims only).
 *
 * Throws on persistence failure (the pipeline records and retries); the
 * unique keys make retries idempotent.
 */
export async function persistClaims(input: PersistClaimsInput): Promise<PersistedClaim[]> {
  const client = input.client || supabase;
  const persisted: PersistedClaim[] = [];

  for (const group of input.groupedClaims) {
    if (!group.chunkId) {
      // No chunk id — the claim is ungrounded; the pipeline never passes
      // these, but refuse silently rather than fabricate provenance.
      logger.warn('[ClaimStore] Skipping claims without a chunk id (ungrounded).');
      continue;
    }
    for (const claim of group.claims) {
      const row = await persistOne(client, input.workspaceId, input.sourceDocumentId, group.chunkId, claim);
      if (row) persisted.push(row);
    }
  }

  return persisted;
}
