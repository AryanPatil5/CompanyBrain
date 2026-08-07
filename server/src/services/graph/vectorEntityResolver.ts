import { logger } from '../../logger.js';
import { generateEmbeddings, generateText } from '../aiProvider.js';
import { supabase } from '../../config/supabase.js';

export interface EntityMatchResult {
  isDuplicate: boolean;
  canonicalName?: string;
  existingNodeId?: string;
  similarityScore?: number;
}

interface StoredEntityVector {
  id: string;
  name: string;
  type: string;
  embedding: number[];
  workspaceId: string;
}

// In-memory cache for fast sub-150ms pgvector / cosine pre-filtering
const entityVectorRegistry: StoredEntityVector[] = [];

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Registers an entity node embedding into the vector resolution registry.
 */
export async function registerEntityVector(
  id: string,
  name: string,
  type: string,
  workspaceId: string
): Promise<void> {
  const embedding = await generateEmbeddings(name);
  entityVectorRegistry.push({
    id,
    name,
    type,
    embedding,
    workspaceId,
  });
}

/**
 * Vector-assisted entity resolution service.
 * Pre-filters candidate nodes via 0.85 cosine similarity thresholds and verifies identical business entities using LLM logic.
 */
export async function findSimilarEntities(
  entityName: string,
  entityType: string,
  workspaceId: string
): Promise<EntityMatchResult> {
  if (!entityName || entityName.length < 2) {
    return { isDuplicate: false };
  }

  const cleanName = entityName.trim();
  const queryEmbedding = await generateEmbeddings(cleanName);

  // 1. Vector Search Pre-Filtering (Cosine Similarity >= 0.85)
  const candidates: { node: StoredEntityVector; similarity: number }[] = [];

  for (const stored of entityVectorRegistry) {
    if (stored.workspaceId !== workspaceId) continue;

    // Direct name string match pre-filter
    if (stored.name.toLowerCase() === cleanName.toLowerCase()) {
      return {
        isDuplicate: true,
        canonicalName: stored.name,
        existingNodeId: stored.id,
        similarityScore: 1.0,
      };
    }

    const similarity = cosineSimilarity(queryEmbedding, stored.embedding);
    if (similarity >= 0.85) {
      candidates.push({ node: stored, similarity });
    }
  }

  // Also query Database graph_nodes for registered entities if in-memory registry is empty
  if (candidates.length === 0) {
    try {
      const { data: dbNodes } = await supabase
        .from('graph_nodes')
        .select('*')
        .eq('workspace_id', workspaceId)
        .limit(20);

      if (Array.isArray(dbNodes)) {
        for (const dbNode of dbNodes) {
          if (dbNode.name.toLowerCase() === cleanName.toLowerCase()) {
            return {
              isDuplicate: true,
              canonicalName: dbNode.name,
              existingNodeId: dbNode.id,
              similarityScore: 1.0,
            };
          }
        }
      }
    } catch {
      // Query catch fallback
    }
  }

  if (candidates.length === 0) {
    return { isDuplicate: false };
  }

  // Sort candidates by highest cosine similarity score
  candidates.sort((a, b) => b.similarity - a.similarity);
  const bestCandidate = candidates[0].node;

  // 2. LLM Verification Prompt: Fast decision on identical business entity match
  try {
    const prompt = `Are Entity A ('${cleanName}') and Entity B ('${bestCandidate.name}') identical business entities in the context of type '${entityType}'?
Answer strictly with JSON format: {"match": boolean, "canonicalName": "string"}`;

    const llmResponse = await generateText(prompt, 'You are an Enterprise Graph Entity Resolution AI.');
    let parsed: any = {};
    try {
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // Parsing fallback
    }

    if (parsed.match === true) {
      return {
        isDuplicate: true,
        canonicalName: parsed.canonicalName || bestCandidate.name,
        existingNodeId: bestCandidate.id,
        similarityScore: candidates[0].similarity,
      };
    }
  } catch (llmErr) {
    logger.warn('[VectorEntityResolver Warning] LLM verification error, defaulting to similarity threshold match:', llmErr);
    // If similarity >= 0.92, treat as duplicate fallback
    if (candidates[0].similarity >= 0.92) {
      return {
        isDuplicate: true,
        canonicalName: bestCandidate.name,
        existingNodeId: bestCandidate.id,
        similarityScore: candidates[0].similarity,
      };
    }
  }

  return { isDuplicate: false };
}
