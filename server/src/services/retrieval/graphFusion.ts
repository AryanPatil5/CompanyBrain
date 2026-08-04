import { supabase } from '../../config/supabase.js';
import { getConnectedEntities, executeCypher } from '../graph/graphService.js';
import { ENTERPRISE_ALIAS_DICTIONARY, canonicalizeEntity } from '../graph/entityDisambiguator.js';

export interface GraphFusionResult {
  graphContextText: string;
  graphNodes: any[];
  entityCount: number;
}

/**
 * GraphRAG Traversal Fusion Service
 * Extracts named entities from user query, traverses 2-hop graph paths in Apache AGE / pg graph,
 * and formats relational entity tuples into structured context text for hybrid search RAG.
 */
export async function extractEntitiesAndTraverse(
  queryText: string,
  workspaceId: string
): Promise<GraphFusionResult> {
  const cleanQuery = queryText.toLowerCase().trim();
  if (!cleanQuery) {
    return { graphContextText: '', graphNodes: [], entityCount: 0 };
  }

  const startTime = Date.now();
  const matchedNodeIds = new Set<string>();

  // 1. Check dictionary aliases
  const canonical = canonicalizeEntity(queryText);
  if (canonical && canonical !== 'unnamed_entity') {
    matchedNodeIds.add(canonical);
  }

  // 2. Extract entity candidate nodes from database graph_nodes table
  try {
    const { data: dbNodes } = await supabase
      .from('graph_nodes')
      .select('id, name, label')
      .eq('workspace_id', workspaceId)
      .limit(50);

    if (Array.isArray(dbNodes)) {
      for (const node of dbNodes) {
        const nodeNameLower = (node.name || '').toLowerCase();
        const nodeIdLower = (node.id || '').toLowerCase();
        if (
          cleanQuery.includes(nodeNameLower) ||
          cleanQuery.includes(nodeIdLower) ||
          nodeNameLower.includes(cleanQuery)
        ) {
          matchedNodeIds.add(node.id);
        }
      }
    }
  } catch (err) {
    console.warn('[GraphFusion Warning] Database graph_nodes query fallback:', err);
  }

  if (matchedNodeIds.size === 0) {
    return { graphContextText: '', graphNodes: [], entityCount: 0 };
  }

  // 3. Execute 2-hop Cypher / Graph traversal for matched entities
  const graphTuples: string[] = [];
  const fetchedNodes: any[] = [];

  for (const entityId of Array.from(matchedNodeIds).slice(0, 3)) {
    try {
      // Execute 2-hop Cypher traversal with LIMIT 25
      const cypherQuery = `
        MATCH (e {id: '${entityId}'})-[r1]-(n1)-[r2*0..1]-(n2)
        RETURN e.id AS source, type(r1) AS rel1, n1.id AS hop1, type(r2) AS rel2, n2.id AS hop2
        LIMIT 25
      `;
      const cypherResults = await executeCypher(cypherQuery);

      if (Array.isArray(cypherResults) && cypherResults.length > 0) {
        for (const row of cypherResults.slice(0, 25)) {
          const pathStr = `(${row.source}) -> [${row.rel1 || 'CONNECTED'}] -> (${row.hop1})${row.rel2 ? ` -> [${row.rel2}] -> (${row.hop2})` : ''}`;
          graphTuples.push(pathStr);
        }
      } else {
        // Fallback to graphService.getConnectedEntities()
        const connected = await getConnectedEntities(entityId, 2);
        for (const c of connected.slice(0, 25)) {
          graphTuples.push(`(${entityId}) -> [${c.relationship}] -> (${c.node.name || c.entityId}) [Depth: ${c.depth}]`);
          fetchedNodes.push(c.node);
        }
      }
    } catch (err) {
      console.warn(`[GraphFusion Warning] Traversal failed for entity "${entityId}":`, err);
    }
  }

  if (graphTuples.length === 0) {
    return { graphContextText: '', graphNodes: [], entityCount: 0 };
  }

  const uniqueTuples = Array.from(new Set(graphTuples)).slice(0, 25);
  const graphContextText = `[Knowledge Graph Context]:\n` + uniqueTuples.map((t) => `  - ${t}`).join('\n');

  return {
    graphContextText,
    graphNodes: fetchedNodes,
    entityCount: matchedNodeIds.size,
  };
}
