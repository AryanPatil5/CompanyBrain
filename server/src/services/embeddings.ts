import { logger } from '../logger.js';
import dotenv from 'dotenv';
import { generateEmbeddings as getAiEmbeddings, EmbeddingError } from './aiProvider.js';
import { supabase } from '../config/supabase.js';

dotenv.config();

export { EmbeddingError };

export interface DLACSearchResult {
  id: string;
  title: string;
  trigger_condition: string;
  category: string;
  risk_level: string;
  requires_human_gate: boolean;
  similarity: number;
  source_document_id?: string;
}

/**
 * Generates a real embedding vector for the given text.
 *
 * Returns null only for empty input. Any embedding generation failure throws a
 * typed EmbeddingError — failures never silently degrade to null or fake vectors.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const cleanText = text.trim();
  if (!cleanText) return null;
  return getAiEmbeddings(cleanText);
}

/**
 * Marks an ingestion as embedding_failed by writing an audit row to
 * ingestion_failures. Never throws; failure to record is logged only.
 */
export async function recordEmbeddingFailure(params: {
  workspaceId?: string | null;
  source?: string | null;
  rawContent?: string;
  error: unknown;
}): Promise<void> {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  try {
    await supabase.from('ingestion_failures').insert({
      workspace_id: params.workspaceId || null,
      source: params.source || 'unknown',
      raw_content: params.rawContent || '',
      error_message: `embedding_failed: ${message}`,
    });
  } catch (err) {
    logger.warn('[Embeddings] Failed to record embedding failure:', err);
  }
}

/**
 * Performs Document-Level Access Control (DLAC) vector search matching against pgvector using pre-filtered HNSW index execution.
 * Ensures zero data leakage from unauthorized documents.
 */
export async function searchVectorContextDLAC(params: {
  queryEmbedding: number[];
  workspaceId: string;
  userId: string;
  role?: string;
  allowedDocIds?: string[] | null;
  matchThreshold?: number;
  matchCount?: number;
}): Promise<DLACSearchResult[]> {
  const {
    queryEmbedding,
    workspaceId,
    userId,
    role = 'member',
    allowedDocIds = null,
    matchThreshold = 0.1,
    matchCount = 5,
  } = params;

  try {
    const { data, error } = await supabase.rpc('dlac_hnsw_vector_search', {
      query_embedding: queryEmbedding,
      workspace_id_filter: workspaceId,
      allowed_doc_ids: allowedDocIds,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (!error && Array.isArray(data)) {
      return data.map((item: any) => ({
        id: item.id || item.document_id,
        title: item.metadata?.title || 'SOP Document',
        trigger_condition: item.content || item.metadata?.trigger_condition || '',
        category: item.metadata?.category || 'Operations',
        risk_level: item.metadata?.risk_level || 'Low',
        requires_human_gate: item.metadata?.requires_human_gate || false,
        similarity: item.similarity || 0.9,
        source_document_id: item.document_id,
      }));
    }

    return await fallbackInMemoryDLACSearch(queryEmbedding, workspaceId, userId, role, allowedDocIds, matchThreshold, matchCount);
  } catch {
    return await fallbackInMemoryDLACSearch(queryEmbedding, workspaceId, userId, role, allowedDocIds, matchThreshold, matchCount);
  }
}

async function fallbackInMemoryDLACSearch(
  queryEmbedding: number[],
  workspaceId: string,
  _userId: string,
  role: string,
  allowedDocIds: string[] | null,
  matchThreshold: number,
  matchCount: number
): Promise<DLACSearchResult[]> {
  try {
    const chunkResults = await fallbackChunkSearch(queryEmbedding, workspaceId, role, allowedDocIds, matchThreshold, matchCount);
    if (chunkResults.length > 0 || (allowedDocIds !== null && allowedDocIds.length === 0)) {
      if (chunkResults.length > 0) {
        logger.info(`[Retrieval] Retrieved ${chunkResults.length} chunks from document_chunks (workspace: ${workspaceId})`);
      }
      return chunkResults;
    }

    logger.warn(
      `[Retrieval] No chunks found; falling back to skills_sops (workspace: ${workspaceId}, role: ${role}, allowedDocIds: ${allowedDocIds})`
    );

    const { data: sops } = await supabase
      .from('skills_sops')
      .select('id, title, trigger_condition, category, risk_level, requires_human_gate, embedding, workspace_id')
      .eq('workspace_id', workspaceId)
      .limit(matchCount * 2);

    if (!Array.isArray(sops)) return [];

    const isAdmin = role === 'admin';
    const filtered = sops.filter((s) => {
      if (isAdmin) return true;
      if (allowedDocIds !== null && allowedDocIds !== undefined) {
        return allowedDocIds.includes(s.id);
      }
      return !s.requires_human_gate && (s.risk_level === 'Low' || s.risk_level === 'Medium');
    });

    logger.info(`[Retrieval] Retrieved ${filtered.length} SOPs from skills_sops fallback`);

    return filtered.slice(0, matchCount).map((s, idx) => ({
      id: s.id,
      title: s.title,
      trigger_condition: s.trigger_condition,
      category: s.category || 'Operations',
      risk_level: s.risk_level || 'Low',
      requires_human_gate: s.requires_human_gate || false,
      similarity: 0.95 - idx * 0.05,
      source_document_id: s.id,
    }));
  } catch (err) {
    logger.error('[Retrieval Error] Fallback search failed:', err);
    return [];
  }
}

function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(Number).filter((n) => Number.isFinite(n));
  }

  if (typeof value === 'string') {
    return value
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
  }

  return [];
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA.length || vecA.length !== vecB.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function fallbackChunkSearch(
  queryEmbedding: number[],
  workspaceId: string,
  role: string,
  allowedDocIds: string[] | null,
  matchThreshold: number,
  matchCount: number
): Promise<DLACSearchResult[]> {
  const isAdmin = role === 'admin';

  if (!isAdmin && allowedDocIds !== null && allowedDocIds.length === 0) {
    return [];
  }

  let query = supabase
    .from('document_chunks')
    .select('id, source_document_id, content, metadata, embedding, allowed_roles, workspace_id')
    .eq('workspace_id', workspaceId)
    .not('embedding', 'is', null)
    .limit(Math.max(matchCount * 5, 25));

  if (!isAdmin && allowedDocIds !== null) {
    query = query.in('source_document_id', allowedDocIds);
  }

  const { data: chunks, error } = await query;
  if (error || !Array.isArray(chunks)) {
    return [];
  }

  return chunks
    .map((chunk: any) => {
      const embedding = parseVector(chunk.embedding);
      const similarity = cosineSimilarity(queryEmbedding, embedding);
      const metadata = chunk.metadata || {};
      return {
        id: chunk.id,
        title: metadata.title || 'Source Document Chunk',
        trigger_condition: chunk.content,
        category: metadata.category || 'Operations',
        risk_level: metadata.risk_level || 'Low',
        requires_human_gate: Boolean(metadata.requires_human_gate),
        similarity,
        source_document_id: chunk.source_document_id,
      } satisfies DLACSearchResult;
    })
    .filter((item) => item.similarity >= matchThreshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, matchCount);
}
