import { logger } from '../logger.js';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { generateEmbeddingResult, generateEmbeddingResultsBatch, recordEmbeddingFailure, EmbeddingError, EmbeddingResult } from '../services/embeddings.js';
import { chunkText, hashContent, TextChunk } from './chunker.js';

/**
 * Chunked out: the model/version persisted on document_chunks rows is the
 * EXACT metadata returned by the embedding provider that generated that
 * vector (EmbeddingResult.model/version) — never re-inferred from
 * environment variables at persistence time. See persistDocumentCore.
 */

/**
 * Thrown when the document_chunks write fails after embeddings succeeded.
 * Mirrors EmbeddingError semantics: the caller (ingestion worker, webhook
 * pipeline) must mark the row failed and retry. Swallowing the failure
 * (returning `{ chunksPersisted: 0 }`) let the worker mark the document
 * 'completed' with zero chunks, and the completed + content-hash
 * short-circuit then prevented every later recovery attempt.
 */
export class ChunkPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkPersistenceError';
  }
}

export interface PersistSourceDocumentInput {
  workspaceId: string;
  source: string;
  externalId: string;
  title: string;
  text: string;
  rawThreadId?: string;
  uri?: string;
  metadata?: Record<string, any>;
  allowedRoles?: string[];
  client?: SupabaseClient;
}

export interface PersistParsedDocumentInput extends PersistSourceDocumentInput {
  /** Pre-computed chunks (e.g. from documentPipeline after parsing). */
  chunks: TextChunk[];
  /** Content-addressed object key of the raw source object (ADR-T6). */
  sourceObjectKey?: string;
  /** Object-storage URI of the raw source object. */
  storageUri?: string;
  /**
   * Content-hash short-circuit: when the document row already exists with the
   * same content hash and is 'completed', skip re-embedding and re-writing
   * chunks entirely. Opt-in ONLY (legacy flows keep their exact behavior).
   */
  skipUnchangedContent?: boolean;
}

export interface PersistedSourceDocument {
  id: string;
  source_key: string;
  chunksPersisted: number;
  chunks: TextChunk[];
}

export function formatMessagesAsTranscript(messages: Array<{ user: string; text: string; timestamp?: string }>): string {
  return messages
    .map((msg) => {
      const timestamp = msg.timestamp ? ` ${msg.timestamp}` : '';
      return `[${msg.user || 'Unknown'}${timestamp}]\n${msg.text || ''}`;
    })
    .join('\n\n');
}

/**
 * Content-hash short-circuit (Phase 3 optimization, opt-in): returns the
 * existing row when the document is already persisted, unchanged in content
 * and fully extracted — without touching storage or the embedding provider.
 * Not used by the legacy path (persistSourceDocumentWithChunks) so its
 * observable behavior is byte-identical.
 */
async function findUnchangedCompletedDocument(
  input: Pick<PersistSourceDocumentInput, 'workspaceId' | 'source' | 'externalId' | 'text'>,
  client: SupabaseClient
): Promise<{ id: string; source_key: string } | null> {
  const sourceKey = `${input.workspaceId}:${input.source}:${input.externalId}`;
  const { data, error } = await client
    .from('source_documents')
    .select('id, source_key, content_hash, extraction_stage')
    .eq('workspace_id', input.workspaceId)
    .eq('source', input.source)
    .eq('external_id', input.externalId)
    .maybeSingle();

  if (error || !data) return null;
  if (data.content_hash === hashContent(input.text.trim()) && data.extraction_stage === 'completed') {
    return { id: data.id, source_key: data.source_key || sourceKey };
  }
  return null;
}

/**
 * The CANONICAL document write path (Phase 3): document upsert -> embeddings
 * -> chunk upsert -> ACL upsert. Both the legacy entry point
 * (persistSourceDocumentWithChunks) and the parsed-document entry point
 * (persistParsedDocument) funnel through here with a pluggable embedder, so
 * there is exactly one persistence system for source documents + chunks.
 */
async function persistDocumentCore(
  input: PersistSourceDocumentInput,
  chunks: TextChunk[],
  embed: (chunk: TextChunk) => Promise<EmbeddingResult | null>,
  extra: { sourceObjectKey?: string; storageUri?: string } = {}
): Promise<PersistedSourceDocument | null> {
  const client = input.client || supabase;
  const allowedRoles = input.allowedRoles && input.allowedRoles.length > 0
    ? input.allowedRoles
    : ['admin', 'member'];

  try {
    const { data: document, error: docErr } = await client
      .from('source_documents')
      .upsert(
        {
          workspace_id: input.workspaceId,
          source: input.source,
          source_key: `${input.workspaceId}:${input.source}:${input.externalId}`,
          external_id: input.externalId,
          title: input.title,
          uri: input.uri || null,
          content_hash: hashContent(input.text.trim()),
          raw_thread_id: input.rawThreadId || null,
          raw_metadata: input.metadata || {},
          allowed_roles: allowedRoles,
          storage_uri: extra.storageUri || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id, source, external_id' }
      )
      .select('id, source_key')
      .single();

    if (docErr || !document) {
      logger.warn('[SourceObjects Warning] Failed to persist source document:', docErr);
      return null;
    }

    if (chunks.length === 0) {
      return { id: document.id, source_key: document.source_key, chunksPersisted: 0, chunks };
    }

    // Embed everything BEFORE writing any chunk row: a mid-batch embedding
    // failure leaves the document row upserted but zero chunk rows written,
    // so a retry re-embeds from scratch (same semantics as the legacy loop).
    const rows = [];
    let embeddingSuccessCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      let embedding: EmbeddingResult | null = null;
      try {
        embedding = await embed(chunk);
        if (embedding) embeddingSuccessCount++;
      } catch (embErr) {
        // Never persist chunks without real embeddings: record the failed state
        // and rethrow so the caller can retry the ingestion.
        await recordEmbeddingFailure({
          workspaceId: input.workspaceId,
          source: input.source,
          rawContent: chunk.content,
          error: embErr,
        });
        throw embErr;
      }

      rows.push({
        workspace_id: input.workspaceId,
        source_document_id: document.id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        content_hash: chunk.content_hash,
        token_count_estimate: chunk.token_count_estimate,
        metadata: chunk.metadata,
        allowed_roles: allowedRoles,
        embedding: embedding?.vector ?? null,
        source_object_key: extra.sourceObjectKey || null,
        // Source of truth: the exact model/version reported by the provider
        // that produced this vector (never re-read from env at write time).
        embedding_model: embedding?.model ?? null,
        embedding_version: embedding?.version ?? null,
        updated_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      logger.info(`[SourceObjects] Generated embeddings for ${embeddingSuccessCount}/${rows.length} chunks of document ${document.id}`);
    }

    let chunkErr: unknown = null;
    try {
      const { error } = await client
        .from('document_chunks')
        .upsert(rows, { onConflict: 'source_document_id, chunk_index' });
      chunkErr = error;
    } catch (err) {
      chunkErr = err;
    }

    if (chunkErr) {
      // Same contract as the embedding path above: a chunk-write failure must
      // propagate so the caller marks the row failed and retries. Swallowing
      // it (returning { chunksPersisted: 0 }) marked the document 'completed'
      // with zero chunks, and the completed + content-hash short-circuit then
      // made re-uploads return deduplicated with no chunks ever persisted.
      const message = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
      logger.error('[SourceObjects Error] Failed to persist document chunks:', chunkErr);
      throw new ChunkPersistenceError(`Failed to persist document chunks: ${message}`);
    }

    const aclRows = allowedRoles.map((role) => ({
      workspace_id: input.workspaceId,
      source_document_id: document.id,
      principal_type: 'role',
      principal_id: role,
      permission: 'read',
      inherited: false,
      raw_acl: { source: 'default_role_policy' },
    }));

    if (aclRows.length > 0) {
      const { error: aclErr } = await client
        .from('source_document_acls')
        .upsert(aclRows, { onConflict: 'source_document_id, principal_type, principal_id, permission' });
      if (aclErr) {
        logger.warn('[SourceObjects Warning] Failed to persist source ACL rows:', aclErr);
      }
    }

    return {
      id: document.id,
      source_key: document.source_key,
      chunksPersisted: rows.length,
      chunks,
    };
  } catch (err) {
    if (err instanceof EmbeddingError || err instanceof ChunkPersistenceError) {
      throw err;
    }
    logger.warn('[SourceObjects Warning] Source document persistence skipped:', err);
    return null;
  }
}

export async function persistSourceDocumentWithChunks(
  input: PersistSourceDocumentInput
): Promise<PersistedSourceDocument | null> {
  const cleanText = input.text.trim();
  if (!cleanText) return null;

  const chunks = chunkText(cleanText, {
    metadata: {
      title: input.title,
      source: input.source,
      external_id: input.externalId,
      raw_thread_id: input.rawThreadId,
    },
  });

  // Legacy embedder: serial per-chunk generateEmbeddingResult with the exact
  // failure semantics the webhook/github flows have always had.
  return persistDocumentCore(input, chunks, async (chunk) => generateEmbeddingResult(chunk.content));
}

/**
 * Phase 3 canonical entry point for pre-parsed documents (documentPipeline):
 * batched embeddings, optional content-hash short-circuit, optional storage
 * provenance (sourceObjectKey / storageUri) recorded on the rows.
 */
export async function persistParsedDocument(
  input: PersistParsedDocumentInput
): Promise<PersistedSourceDocument | null> {
  const cleanText = input.text.trim();
  if (!cleanText) return null;

  if (input.skipUnchangedContent) {
    const existing = await findUnchangedCompletedDocument(input, input.client || supabase);
    if (existing) {
      logger.info(`[SourceObjects] Content unchanged for document ${existing.id}; skipping re-embed.`);
      return { id: existing.id, source_key: existing.source_key, chunksPersisted: 0, chunks: input.chunks };
    }
  }

  const embedder = async (chunk: TextChunk): Promise<EmbeddingResult | null> => {
    // One-shot batch per call keeps failure semantics identical to the
    // serial path while bounding concurrency across chunk embeddings.
    const results = await generateEmbeddingResultsBatch([chunk.content]);
    return results[0];
  };

  return persistDocumentCore(input, input.chunks, embedder, {
    sourceObjectKey: input.sourceObjectKey,
    storageUri: input.storageUri,
  });
}
