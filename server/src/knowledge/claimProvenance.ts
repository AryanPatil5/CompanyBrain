// Phase 3: SOP claim provenance (ADR-T15). Links the claims that support an
// SOP to its citation rows: sop_citations(sop_id, claim_id). Idempotent via
// the (sop_id, claim_id) unique constraint; legacy thread citations (claim_id
// NULL) are untouched. Workspace-scoped on every query.

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';

export interface LinkClaimsInput {
  workspaceId: string;
  sopId: string;
  /** Document whose claims support the SOP (its chunks produced the claims). */
  sourceDocumentId: string;
  /** Cap on how many claims link per document (confidence-ordered). */
  limit?: number;
  client?: SupabaseClient;
}

/**
 * Links the top-confidence claims of a source document to an SOP. No claims
 * for the document -> no-op. Idempotent: the (sop_id, claim_id) unique
 * constraint turns reprocessing into a no-op upsert. Each citation also
 * records the claim's chunk_id (sop_citations.chunk_id, additive from
 * migration 036) so SOP steps resolve to the exact supporting chunk.
 */
export async function linkDocumentClaimsToSop(input: LinkClaimsInput): Promise<number> {
  const client = input.client || supabase;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  const { data: claimRows, error: claimErr } = await client
    .from('knowledge_claims')
    .select('id, chunk_id')
    .eq('workspace_id', input.workspaceId)
    .eq('source_document_id', input.sourceDocumentId)
    .order('confidence', { ascending: false })
    .limit(limit);

  if (claimErr) {
    throw new Error(`Failed to read claims for SOP linkage: ${claimErr.message}`);
  }

  const claimIds = (claimRows ?? []).map((r) => r.id);
  if (claimIds.length === 0) {
    return 0;
  }

  const { error: citationErr } = await client.from('sop_citations').upsert(
    (claimRows ?? []).map((row) => ({
      sop_id: input.sopId,
      claim_id: row.id,
      chunk_id: row.chunk_id ?? null,
      // raw_thread_id stays NULL for upload-derived documents; created_at is
      // intentionally absent so reprocessing never clobbers the original row.
    })),
    { onConflict: 'sop_id, claim_id' }
  );

  if (citationErr) {
    throw new Error(`Failed to link claims to SOP ${input.sopId}: ${citationErr.message}`);
  }

  logger.info(`[ClaimProvenance] Linked ${claimIds.length} claims to SOP ${input.sopId}`);
  return claimIds.length;
}

/**
 * Best-effort variant for the legacy crawler paths: the crawler marks the
 * thread crawled regardless, and there is no retry ledger, so a linkage
 * failure must not lose the already-created SOP. Warns and returns 0 instead
 * of throwing. The durable webhook path keeps the strict throwing version.
 */
export async function linkSopClaimsBestEffort(input: LinkClaimsInput): Promise<number> {
  try {
    return await linkDocumentClaimsToSop(input);
  } catch (err) {
    logger.warn(`[ClaimProvenance] Claim linkage failed for SOP ${input.sopId} (SOP kept, grounding degraded):`, err);
    return 0;
  }
}
