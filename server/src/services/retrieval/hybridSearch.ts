import { logger } from '../../logger.js';
import { supabase } from '../../config/supabase.js';
import { generateEmbedding, searchVectorContextDLAC, type DLACSearchResult } from '../embeddings.js';
import { extractEntitiesAndTraverse } from './graphFusion.js';
import { rerankResults } from './reranker.js';
import { openfgaClientManager } from '../security/openfgaClient.js';

export interface HybridSearchResult extends DLACSearchResult {
  rrfScore: number;
  denseRank: number | null;
  sparseRank: number | null;
  graphContext?: string;
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
 * Reciprocal Rank Fusion (RRF) Hybrid Search Engine with OpenFGA HNSW Index Pre-Filtering
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

  // Fetch OpenFGA user accessible document IDs for pre-filtered vector index execution
  const allowedDocIds = await openfgaClientManager.getUserAccessibleDocumentIds(userId, workspaceId, role);

  // 1. Parallel Leg 1: Dense Vector Retrieval (pgvector HNSW + OpenFGA Pre-filter)
  const densePromise = (async (): Promise<DLACSearchResult[]> => {
    try {
      const queryVector = await generateEmbedding(cleanQuery);
      if (!queryVector) return [];
      return await searchVectorContextDLAC({
        queryEmbedding: queryVector,
        workspaceId,
        userId,
        role,
        allowedDocIds,
        matchThreshold: 0.05,
        matchCount: limit * 3,
      });
    } catch (err) {
      logger.warn('[HybridSearch Warning] Dense vector leg failed:', err);
      return [];
    }
  })();

  // 2. Parallel Leg 2: Sparse Keyword Retrieval (PostgreSQL FTS / ILIKE)
  const sparsePromise = (async (): Promise<DLACSearchResult[]> => {
    try {
      const { data: sops, error } = await supabase
        .from('skills_sops')
        .select('id, title, trigger_condition, category, risk_level, requires_human_gate, workspace_id')
        .eq('workspace_id', workspaceId)
        .or(`title.ilike.%${cleanQuery}%,trigger_condition.ilike.%${cleanQuery}%,category.ilike.%${cleanQuery}%`)
        .limit(limit * 3);

      if (error || !Array.isArray(sops)) {
        return [];
      }

      const isAdmin = role === 'admin';
      const permitted = sops.filter((s) => {
        if (isAdmin) return true;
        if (allowedDocIds !== null && allowedDocIds !== undefined) {
          return allowedDocIds.includes(s.id);
        }
        return !s.requires_human_gate && (s.risk_level === 'Low' || s.risk_level === 'Medium');
      });

      return permitted.map((s) => ({
        id: s.id,
        title: s.title,
        trigger_condition: s.trigger_condition,
        category: s.category || 'Operations',
        risk_level: s.risk_level || 'Low',
        requires_human_gate: s.requires_human_gate || false,
        // No fabricated similarity: the sparse leg matched by keyword, not by
        // embedding distance (Phase 3 "no fabricated fallback" rule). Honest
        // null beats a fake score; RRF ordering uses ranks, not similarity.
        similarity: null,
      }));
    } catch (err) {
      logger.warn('[HybridSearch Warning] Sparse keyword leg failed:', err);
      return [];
    }
  })();

  // 3. Parallel Leg 3: GraphRAG 2-Hop Knowledge Graph Traversal
  const graphPromise = extractEntitiesAndTraverse(cleanQuery, workspaceId, role);

  const [denseResults, sparseResults, graphFusion] = await Promise.all([
    densePromise,
    sparsePromise,
    graphPromise,
  ]);

  // 4. Map RRF Ranks & RRF Score Calculation
  const rrfMap = new Map<
    string,
    {
      doc: DLACSearchResult;
      denseRank: number | null;
      sparseRank: number | null;
      rrfScore: number;
    }
  >();

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

  const mergedCandidates: HybridSearchResult[] = Array.from(rrfMap.values())
    .map(({ doc, denseRank, sparseRank, rrfScore }) => ({
      ...doc,
      denseRank,
      sparseRank,
      rrfScore,
      graphContext: graphFusion.graphContextText || undefined,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore);

  // 5. Cross-Encoder Reranking
  const finalReranked = await rerankResults(cleanQuery, mergedCandidates, limit);

  return finalReranked;
}
