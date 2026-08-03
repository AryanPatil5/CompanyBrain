import dotenv from 'dotenv';
import { generateEmbeddings as getAiEmbeddings } from './aiProvider.js';
import { supabase } from '../config/supabase.js';

dotenv.config();

export interface DLACSearchResult {
  id: string;
  title: string;
  trigger_condition: string;
  category: string;
  risk_level: string;
  requires_human_gate: boolean;
  similarity: number;
}

/**
 * Generates vector embeddings (1536 float values) for a text string
 * using the central hybrid AI provider (Local Ollama nomic-embed-text / fallback).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const cleanText = text.trim();
  if (!cleanText) return null;

  try {
    const vector = await getAiEmbeddings(cleanText);
    if (Array.isArray(vector) && vector.length === 1536) {
      return vector;
    }
  } catch (err) {
    console.warn('[Embeddings] Failed to generate embedding vector:', err);
  }

  return null;
}

/**
 * Performs Document-Level Access Control (DLAC) vector search matching against pgvector,
 * filtering out any restricted SOP where user lacks role/permission grants.
 */
export async function searchVectorContextDLAC(params: {
  queryEmbedding: number[];
  workspaceId: string;
  userId: string;
  role?: string;
  matchThreshold?: number;
  matchCount?: number;
}): Promise<DLACSearchResult[]> {
  const {
    queryEmbedding,
    workspaceId,
    userId,
    role = 'member',
    matchThreshold = 0.1,
    matchCount = 5,
  } = params;

  try {
    const { data, error } = await supabase.rpc('match_embeddings_dlac', {
      query_embedding: queryEmbedding,
      p_workspace_id: workspaceId,
      p_user_id: userId,
      match_threshold: matchThreshold,
      match_count: matchCount,
    });

    if (error) {
      // If RPC is unavailable (e.g. mock DB in dev/test), apply in-memory DLAC filter fallback
      console.warn('[DLAC Vector Search Warning] Supabase RPC error, applying DLAC in-memory fallback:', error.message);
      return await fallbackInMemoryDLACSearch(queryEmbedding, workspaceId, userId, role, matchThreshold, matchCount);
    }

    return (data || []) as DLACSearchResult[];
  } catch (err) {
    return await fallbackInMemoryDLACSearch(queryEmbedding, workspaceId, userId, role, matchThreshold, matchCount);
  }
}

async function fallbackInMemoryDLACSearch(
  queryEmbedding: number[],
  workspaceId: string,
  userId: string,
  role: string,
  matchThreshold: number,
  matchCount: number
): Promise<DLACSearchResult[]> {
  try {
    const { data: sops } = await supabase
      .from('skills_sops')
      .select('id, title, trigger_condition, category, risk_level, requires_human_gate, embedding, workspace_id')
      .eq('workspace_id', workspaceId);

    if (!Array.isArray(sops)) return [];

    const results: DLACSearchResult[] = [];
    for (const s of sops) {
      // In-memory DLAC Filter
      const isAdmin = role === 'admin';
      const isLowOrMedium = !s.requires_human_gate && (s.risk_level === 'Low' || s.risk_level === 'Medium');

      if (!isAdmin && !isLowOrMedium) {
        // Restricted document — non-admin member gets 0 matches
        continue;
      }

      let sim = 0.85;
      if (Array.isArray(s.embedding) && s.embedding.length === queryEmbedding.length) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryEmbedding.length; i++) {
          dot += queryEmbedding[i] * s.embedding[i];
          normA += queryEmbedding[i] * queryEmbedding[i];
          normB += s.embedding[i] * s.embedding[i];
        }
        sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
      }

      if (sim >= matchThreshold) {
        results.push({
          id: s.id,
          title: s.title,
          trigger_condition: s.trigger_condition,
          category: s.category || 'Operations',
          risk_level: s.risk_level || 'Low',
          requires_human_gate: s.requires_human_gate || false,
          similarity: sim,
        });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity).slice(0, matchCount);
  } catch {
    return [];
  }
}
