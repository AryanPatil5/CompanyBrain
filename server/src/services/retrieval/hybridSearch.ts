import { supabase } from '../../config/supabase.js';
import { generateEmbedding, searchVectorContextDLAC, type DLACSearchResult } from '../embeddings.js';

export interface HybridSearchResult extends DLACSearchResult {
  rrfScore: number;
  denseRank: number | null;
  sparseRank: number | null;
}

export interface HybridSearchParams {
  query: string;
  workspaceId: string;
  userId: string;
  role?: string;
  limit?: number;
  kConstant?: number;
}

/**
 * Reciprocal Rank Fusion (RRF) Hybrid Search Engine
 * Combines pgvector dense similarity search with PostgreSQL full-text sparse keyword search.
 * Formula: RRF_score(d) = sum(1 / (k + rank_m(d))) for m in {dense, sparse}, where k = 60.
 */
export async function hybridSearch(params: HybridSearchParams): Promise<HybridSearchResult[]> {
  const {
    query,
    workspaceId,
    userId,
    role = 'member',
    limit = 10,
    kConstant = 60,
  } = params;

  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  // 1. Parallel Leg 1: Dense Vector Retrieval (pgvector + DLAC)
  const densePromise = (async (): Promise<DLACSearchResult[]> => {
    try {
      const queryVector = await generateEmbedding(cleanQuery);
      if (!queryVector) return [];
      return await searchVectorContextDLAC({
        queryEmbedding: queryVector,
        workspaceId,
        userId,
        role,
        matchThreshold: 0.05,
        matchCount: limit * 2,
      });
    } catch (err) {
      console.warn('[HybridSearch Warning] Dense vector leg failed:', err);
      return [];
    }
  })();

  // 2. Parallel Leg 2: Sparse Keyword Retrieval (PostgreSQL FTS / ILIKE)
  const sparsePromise = (async (): Promise<DLACSearchResult[]> => {
    try {
      // Query database for keyword matches
      const { data: sops, error } = await supabase
        .from('skills_sops')
        .select('id, title, trigger_condition, category, risk_level, requires_human_gate, workspace_id')
        .eq('workspace_id', workspaceId)
        .or(`title.ilike.%${cleanQuery}%,trigger_condition.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%`)
        .limit(limit * 2);

      if (error || !Array.isArray(sops)) {
        return [];
      }

      // Filter DLAC access for non-admin members
      const isAdmin = role === 'admin';
      const permitted = sops.filter(
        (s) => isAdmin || (!s.requires_human_gate && (s.risk_level === 'Low' || s.risk_level === 'Medium'))
      );

      return permitted.map((s, idx) => ({
        id: s.id,
        title: s.title,
        trigger_condition: s.trigger_condition,
        category: s.category || 'Operations',
        risk_level: s.risk_level || 'Low',
        requires_human_gate: s.requires_human_gate || false,
        similarity: 1 - idx * 0.05,
      }));
    } catch (err) {
      console.warn('[HybridSearch Warning] Sparse keyword leg failed:', err);
      return [];
    }
  })();

  const [denseResults, sparseResults] = await Promise.all([densePromise, sparsePromise]);

  // 3. Map RRF Ranks & RRF Score Calculation
  const rrfMap = new Map<
    string,
    {
      doc: DLACSearchResult;
      denseRank: number | null;
      sparseRank: number | null;
      rrfScore: number;
    }
  >();

  // Process Dense Ranks
  denseResults.forEach((doc, idx) => {
    const rank = idx + 1;
    const existing = rrfMap.get(doc.id);
    const denseScore = 1 / (kConstant + rank);

    if (existing) {
      existing.denseRank = rank;
      existing.rrfScore += denseScore;
    } else {
      rrfMap.set(doc.id, {
        doc,
        denseRank: rank,
        sparseRank: null,
        rrfScore: denseScore,
      });
    }
  });

  // Process Sparse Ranks
  sparseResults.forEach((doc, idx) => {
    const rank = idx + 1;
    const existing = rrfMap.get(doc.id);
    const sparseScore = 1 / (kConstant + rank);

    if (existing) {
      existing.sparseRank = rank;
      existing.rrfScore += sparseScore;
    } else {
      rrfMap.set(doc.id, {
        doc,
        denseRank: null,
        sparseRank: rank,
        rrfScore: sparseScore,
      });
    }
  });

  // 4. Sort merged candidates by RRF Score descending
  const merged: HybridSearchResult[] = Array.from(rrfMap.values())
    .map(({ doc, denseRank, sparseRank, rrfScore }) => ({
      ...doc,
      denseRank,
      sparseRank,
      rrfScore,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, limit);

  return merged;
}
