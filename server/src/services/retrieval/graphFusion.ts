import { supabase } from '../../config/supabase.js';
import { getConnectedEntities, executeCypher } from '../graph/graphService.js';
import { canonicalizeEntity } from '../graph/entityDisambiguator.js';

export interface GraphFusionResult {
  graphContextText: string;
  graphNodes: any[];
  entityCount: number;
}

export interface GraphFusionUserContext {
  userId?: string;
  workspaceId: string;
  userRole?: string;
  roles?: string[];
}

/**
 * GraphRAG Traversal Fusion Service with Document-Level Access Control (DLAC)
 * Extracts named entities from user query, traverses 2-hop graph paths in Apache AGE / pg graph,
 * and filters out restricted nodes/relationships before constructing context text.
 */
export async function extractEntitiesAndTraverse(
  queryText: string,
  workspaceIdOrContext: string | GraphFusionUserContext,
  roleOption?: string
): Promise<GraphFusionResult> {
  const workspaceId =
    typeof workspaceIdOrContext === 'string'
      ? workspaceIdOrContext
      : workspaceIdOrContext.workspaceId;

  const userRole =
    typeof workspaceIdOrContext === 'object'
      ? workspaceIdOrContext.userRole || 'member'
      : roleOption || 'member';

  const cleanQuery = queryText.toLowerCase().trim();
  if (!cleanQuery) {
    return { graphContextText: '', graphNodes: [], entityCount: 0 };
  }

  const matchedNodeIds = new Set<string>();

  // 1. Check dictionary aliases
  const canonical = canonicalizeEntity(queryText);
  if (canonical && canonical !== 'unnamed_entity') {
    matchedNodeIds.add(canonical);
  }

  // 2. Extract entity candidate nodes from database graph_nodes table with DLAC permissions
  try {
    const { data: dbNodes } = await supabase
      .from('graph_nodes')
      .select('id, name, label, allowed_roles')
      .eq('workspace_id', workspaceId)
      .limit(50);

    if (Array.isArray(dbNodes)) {
      const isAdmin = userRole === 'admin';
      for (const node of dbNodes) {
        if (!isAdmin && node.allowed_roles && !node.allowed_roles.includes(userRole)) {
          continue; // Skip restricted node
        }

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

  // 3. Execute DLAC-permissioned 2-hop Cypher / Graph traversal for matched entities
  const graphTuples: string[] = [];
  const fetchedNodes: any[] = [];

  for (const entityId of Array.from(matchedNodeIds).slice(0, 3)) {
    try {
      const connected = await getConnectedEntities(entityId, 2, { userRole, workspaceId });
      for (const c of connected.slice(0, 25)) {
        graphTuples.push(`(${entityId}) -> [${c.relationship}] -> (${c.node.name || c.entityId})`);
        fetchedNodes.push(c.node);
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
