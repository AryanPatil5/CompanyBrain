import { logger } from '../logger.js';
import { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '../config/supabase.js';
import { generateEmbedding, recordEmbeddingFailure, EmbeddingError } from '../services/embeddings.js';
import { chunkText, hashContent, TextChunk } from './chunker.js';

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

export async function persistSourceDocumentWithChunks(
  input: PersistSourceDocumentInput
): Promise<PersistedSourceDocument | null> {
  const client = input.client || supabase;
  const cleanText = input.text.trim();
  if (!cleanText) return null;

  const sourceKey = `${input.workspaceId}:${input.source}:${input.externalId}`;
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
          source_key: sourceKey,
          external_id: input.externalId,
          title: input.title,
          uri: input.uri || null,
          content_hash: hashContent(cleanText),
          raw_thread_id: input.rawThreadId || null,
          raw_metadata: input.metadata || {},
          allowed_roles: allowedRoles,
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

    const chunks = chunkText(cleanText, {
      metadata: {
        title: input.title,
        source: input.source,
        external_id: input.externalId,
        raw_thread_id: input.rawThreadId,
      },
    });

    if (chunks.length === 0) {
      return { id: document.id, source_key: document.source_key, chunksPersisted: 0, chunks };
    }

    const rows = [];
    let embeddingSuccessCount = 0;

    for (const chunk of chunks) {
      let embedding: number[] | null = null;
      try {
        embedding = await generateEmbedding(chunk.content);
        embeddingSuccessCount++;
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
        embedding,
        updated_at: new Date().toISOString(),
      });
    }

    if (rows.length > 0) {
      logger.info(`[SourceObjects] Generated embeddings for ${embeddingSuccessCount}/${rows.length} chunks of document ${document.id}`);
    }

    const { error: chunkErr } = await client
      .from('document_chunks')
      .upsert(rows, { onConflict: 'source_document_id, chunk_index' });

    if (chunkErr) {
      logger.warn('[SourceObjects Warning] Failed to persist document chunks:', chunkErr);
      return { id: document.id, source_key: document.source_key, chunksPersisted: 0, chunks };
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
    if (err instanceof EmbeddingError) {
      throw err;
    }
    logger.warn('[SourceObjects Warning] Source document persistence skipped:', err);
    return null;
  }
}

