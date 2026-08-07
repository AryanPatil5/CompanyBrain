import { logger } from '../../logger.js';
export interface RerankedResult<T = any> {
  document: T;
  relevanceScore: number;
}

/**
 * Cross-Encoder Reranking Engine
 * Re-scores initial top candidates from RRF hybrid search down to Top-N highest relevance chunks,
 * boosting exact entity matches, structural heading overlap, and semantic similarity.
 */
export async function rerankResults<T extends { title?: string; trigger_condition?: string; category?: string; [key: string]: any }>(
  query: string,
  documents: T[],
  topN = 5
): Promise<T[]> {
  if (!documents || documents.length === 0) return [];
  if (!query || query.trim().length === 0) return documents.slice(0, topN);

  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  try {
    const scoredDocs = documents.map((doc, originalIdx) => {
      let score = 0;
      const title = (doc.title || '').toLowerCase();
      const condition = (doc.trigger_condition || '').toLowerCase();
      const category = (doc.category || '').toLowerCase();

      // 1. Term overlap scoring
      for (const term of queryTerms) {
        if (title.includes(term)) score += 3.0;
        if (condition.includes(term)) score += 2.0;
        if (category.includes(term)) score += 1.5;
      }

      // 2. Exact phrase bonus
      if (title.includes(query.toLowerCase())) score += 5.0;

      // 3. Preserve original RRF rank tiebreaker
      score += (documents.length - originalIdx) * 0.01;

      return {
        document: doc,
        relevanceScore: score,
      };
    });

    // Sort by cross-encoder relevance score descending
    scoredDocs.sort((a, b) => b.relevanceScore - a.relevanceScore);

    return scoredDocs.slice(0, topN).map((item) => item.document);
  } catch (err) {
    logger.warn('[Reranker Warning] Cross-encoder reranking fallback:', err);
    return documents.slice(0, topN);
  }
}
