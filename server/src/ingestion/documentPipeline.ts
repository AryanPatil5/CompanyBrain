// Phase 3: provider-agnostic document pipeline (ADR-T15 substrate step).
//
//   raw source object -> parse -> chunk -> embed -> persist -> claims -> resolve
//
// The pipeline is storage-provider agnostic: it never touches S3/MinIO
// directly. Uploads hand it a pre-stored object key + parsed text; webhooks
// and crawlers hand it transcript text. Persistence funnels into the single
// canonical write path in sourceObjects.ts (persistDocumentCore) — this
// module never creates a second persistence system.
//
// Stages are individually exported so the worker can checkpoint resumability
// (extraction_stage) and so hermetic tests can exercise each stage directly.

import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { chunkText, TextChunk } from './chunker.js';
import { persistParsedDocument, persistSourceDocumentWithChunks, formatMessagesAsTranscript, PersistedSourceDocument } from './sourceObjects.js';
import { extractClaimsFromChunk, ExtractedClaim } from '../knowledge/claimExtractor.js';
import { persistClaims } from '../knowledge/claimStore.js';
import { resolveEntitiesForDocument, ResolveEntitiesInput } from '../knowledge/entityResolver.js';
import { extractSOPFromThread, ExtractedSOP } from '../services/extractor.js';

export interface DocumentPipelineInput {
  workspaceId: string;
  /** Provider/source discriminator: 'upload' | 'github' | 'slack' | ... */
  source: string;
  externalId: string;
  title: string;
  text: string;
  uri?: string;
  rawThreadId?: string;
  metadata?: Record<string, any>;
  allowedRoles?: string[];
  /** Content-addressed object key of the raw object (ADR-T6). */
  sourceObjectKey?: string;
  /** Object-storage URI recorded on the source_documents row. */
  storageUri?: string;
  client?: SupabaseClient;
}

export interface PipelineChunkStageResult {
  document: PersistedSourceDocument | null;
  chunks: TextChunk[];
}

/**
 * Stage 1 — chunk + embed + persist (parse is the caller's concern: the
 * pipeline accepts already-parsed text so webhooks/uploads share one path).
 * Content-hash short-circuit is ON: re-processing an unchanged, completed
 * document does no embedding writes.
 */
export async function chunkAndPersistDocument(
  input: DocumentPipelineInput
): Promise<PipelineChunkStageResult> {
  const cleanText = input.text.trim();
  if (!cleanText) {
    return { document: null, chunks: [] };
  }

  const chunks = chunkText(cleanText, {
    metadata: {
      title: input.title,
      source: input.source,
      external_id: input.externalId,
      raw_thread_id: input.rawThreadId,
    },
  });

  const document = await persistParsedDocument({
    workspaceId: input.workspaceId,
    source: input.source,
    externalId: input.externalId,
    title: input.title,
    text: cleanText,
    uri: input.uri,
    rawThreadId: input.rawThreadId,
    metadata: input.metadata,
    allowedRoles: input.allowedRoles,
    chunks,
    sourceObjectKey: input.sourceObjectKey,
    storageUri: input.storageUri,
    skipUnchangedContent: true,
    client: input.client || supabase,
  });

  return { document, chunks };
}

/**
 * Stage 2 — claims: extract schema-validated atomic claims per chunk and
 * persist them with char-offset evidence. Idempotent by
 * (workspace_id, source_document_id, chunk_id, claim_text_hash).
 * Returns the persisted claims grouped by chunk.
 */
export async function extractAndPersistClaims(
  input: DocumentPipelineInput,
  result: PipelineChunkStageResult
): Promise<ExtractedClaim[]> {
  if (!result.document || result.chunks.length === 0) {
    return [];
  }

  const client = input.client || supabase;

  // Map chunk_index -> persisted chunk id: claims must reference the actual
  // document_chunks row (grounded claims only).
  const { data: chunkRows, error: chunkErr } = await client
    .from('document_chunks')
    .select('id, chunk_index')
    .eq('workspace_id', input.workspaceId)
    .eq('source_document_id', result.document.id);

  if (chunkErr || !Array.isArray(chunkRows)) {
    throw new Error(`Failed to read persisted chunk ids: ${chunkErr?.message ?? 'no rows returned'}`);
  }
  const idByIndex = new Map(chunkRows.map((r) => [r.chunk_index, r.id]));

  const groupedClaims: Array<{ chunkId: string; claims: ExtractedClaim[] }> = [];
  const allClaims: ExtractedClaim[] = [];

  for (const chunk of result.chunks) {
    const chunkId = idByIndex.get(chunk.chunk_index);
    if (!chunkId) {
      // Chunk has no persisted row — its claims would be ungrounded; skip.
      continue;
    }
    const claims = await extractClaimsFromChunk(chunk, {
      workspaceId: input.workspaceId,
      source: input.source,
    });
    if (claims.length > 0) {
      groupedClaims.push({ chunkId, claims });
      allClaims.push(...claims);
    }
  }

  if (groupedClaims.length > 0) {
    await persistClaims({
      workspaceId: input.workspaceId,
      sourceDocumentId: result.document.id,
      groupedClaims,
      client,
    });
  }

  return allClaims;
}

/**
 * Stage 3 — entity resolution: canonical entities/relationships + the
 * legacy graph_nodes/graph_edges projection. Idempotent by canonical keys.
 */
export async function resolveAndProjectEntities(
  input: DocumentPipelineInput,
  result: PipelineChunkStageResult,
  entities: ResolveEntitiesInput['entities'],
  relationships: ResolveEntitiesInput['relationships']
): Promise<void> {
  if (!result.document) return;
  await resolveEntitiesForDocument({
    workspaceId: input.workspaceId,
    sourceDocumentId: result.document.id,
    entities,
    relationships,
    client: input.client || supabase,
  });
}

/**
 * Full chain: chunk+persist -> claims -> entity resolution/projection.
 * Used by the ingestion worker's parse_document stage and by webhook thread
 * processing. Individual stages stay exported for resumability checkpoints.
 */
export async function processDocumentPipeline(
  input: DocumentPipelineInput,
  opts: {
    extractClaims?: boolean;
    entities?: ResolveEntitiesInput['entities'];
    relationships?: ResolveEntitiesInput['relationships'];
  } = {}
): Promise<{ document: PersistedSourceDocument | null; claims: ExtractedClaim[] }> {
  const stageResult = await chunkAndPersistDocument(input);
  if (!stageResult.document) {
    return { document: null, claims: [] };
  }

  const claims =
    opts.extractClaims === false
      ? []
      : await extractAndPersistClaims(input, stageResult);

  if (opts.entities && opts.entities.length > 0) {
    await resolveAndProjectEntities(input, stageResult, opts.entities, opts.relationships ?? []);
  }

  return { document: stageResult.document, claims };
}

// ─── Thread tail (webhooks + legacy crawlers, Phase 3 B1) ──────────────

export interface ThreadTailInput {
  workspaceId: string;
  /** Provider/source discriminator: 'slack' | 'github' | 'zendesk' | ... */
  source: string;
  /** Stable per-thread identity (dedupe key scope). */
  externalId: string;
  title: string;
  messages: Array<{ user: string; text: string; timestamp?: string }>;
  sourceTrust?: 'manual' | 'crawled';
  rawThreadId?: string;
  metadata?: Record<string, any>;
  client?: SupabaseClient;
}

export interface ThreadTailResult {
  sourceDocument: PersistedSourceDocument | null;
  extractedSOP: ExtractedSOP | null;
  transcript: string;
}

/**
 * Phase 3 (B1): the ONE provider-agnostic thread ingestion tail. Every thread
 * entry point (durable webhooks + the six legacy crawlers) funnels through
 * this so source documents, chunks, claims and evidence are created exactly
 * once per shared implementation:
 *
 *   1. transcript -> source document + chunks (legacy persist path, so the
 *      persistence behavior webhooks have always had is preserved)
 *   2. grounded claims with char-offset evidence (documentPipeline stage 2)
 *   3. LLM SOP extraction (schema-validated; null = no high-confidence SOP)
 *
 * The caller keeps its own skills_sops insert shell (per-provider defaults)
 * and then links claims via linkDocumentClaimsToSop. A schema-validation
 * failure of the SOP extraction throws — identical to the legacy extractor
 * contract the webhook route/worker have always propagated.
 */
export async function processThreadTail(input: ThreadTailInput): Promise<ThreadTailResult> {
  const client = input.client || supabase;
  const transcript = formatMessagesAsTranscript(input.messages);
  const metadata: Record<string, any> = {
    ...(input.metadata ?? {}),
    message_count: input.messages.length,
    source_trust: input.sourceTrust ?? 'crawled',
  };

  const sourceDocument = await persistSourceDocumentWithChunks({
    workspaceId: input.workspaceId,
    source: input.source,
    externalId: input.externalId,
    title: input.title,
    text: transcript,
    rawThreadId: input.rawThreadId,
    metadata,
    client,
  });

  if (sourceDocument) {
    await extractAndPersistClaims(
      {
        workspaceId: input.workspaceId,
        source: input.source,
        externalId: input.externalId,
        title: input.title,
        text: transcript,
        rawThreadId: input.rawThreadId,
        metadata,
        client,
      },
      { document: sourceDocument, chunks: sourceDocument.chunks ?? [] }
    );
  }

  let extractedSOP: ExtractedSOP | null = null;
  try {
    extractedSOP = await extractSOPFromThread(input.messages, input.workspaceId, input.source, input.sourceTrust ?? 'crawled');
  } catch (err) {
    throw new Error(`SOP extraction failed schema validation: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { sourceDocument, extractedSOP, transcript };
}
