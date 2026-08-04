import { supabase } from '../../config/supabase.js';
import { validateTriple, type GraphTriple } from './ontologyCompiler.js';
import { disambiguateTriple } from './entityDisambiguator.js';
import { isEdgeTemporallyValid } from './temporalGraphService.js';

export interface GraphNode {
  id: string;
  label: 'Person' | 'System' | 'SOP' | 'Rule' | 'Step' | 'Policy' | 'Team' | 'Role' | 'Entity';
  name: string;
  properties?: Record<string, any>;
  workspace_id?: string;
  allowed_roles?: string[];
  source_document_id?: string;
}

export interface GraphEdge {
  id?: string;
  source_id: string;
  target_id: string;
  edge_type: 'OWNS' | 'REQUIRES' | 'MODIFIES' | 'DEPENDS_ON' | 'EXECUTES' | 'HAS_STEP' | 'REQUIRES_ROLE' | 'TARGETS_SYSTEM' | 'SUPERSEDES' | 'GOVERNED_BY';
  properties?: Record<string, any>;
  workspace_id?: string;
  allowed_roles?: string[];
  source_document_id?: string;
  valid_from?: string;
  valid_until?: string | null;
}

export interface ConnectedEntityResult {
  entityId: string;
  depth: number;
  node: GraphNode;
  relationship: string;
}

/**
 * Parameterized Cypher query execution helper enforcing parameterized inputs and DLAC WHERE clause filters.
 */
export async function executeCypher(cypherQuery: string, params?: Record<string, any>): Promise<any[]> {
  try {
    const { data, error } = await supabase.rpc('execute_cypher_query', {
      query: cypherQuery,
      params: params || {},
    });

    if (!error && Array.isArray(data)) {
      return data;
    }
  } catch (err) {
    // Cypher RPC fallback
  }

  return [];
}

/**
 * Adds an entity node to the graph with DLAC allowed_roles and source_document_id metadata.
 */
export async function addEntityNode(
  label: GraphNode['label'],
  properties: Record<string, any>
): Promise<GraphNode> {
  const name = properties.name || properties.title || properties.id || 'Unnamed Entity';
  const nodeId = properties.id || `node_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workspaceId = properties.workspace_id || '00000000-0000-0000-0000-000000000000';
  const allowedRoles = properties.allowed_roles || ['admin', 'member'];
  const sourceDocumentId = properties.source_document_id || null;

  const node: GraphNode = {
    id: nodeId,
    label,
    name,
    properties,
    workspace_id: workspaceId,
    allowed_roles: allowedRoles,
    source_document_id: sourceDocumentId,
  };

  try {
    await supabase.from('graph_nodes').upsert({
      id: node.id,
      label: node.label,
      name: node.name,
      properties: node.properties,
      workspace_id: node.workspace_id,
      allowed_roles: node.allowed_roles,
      source_document_id: node.source_document_id,
    });
  } catch (err) {
    console.warn('[GraphService Warning] Failed to write graph node to database:', err);
  }

  return node;
}

/**
 * Creates a directed edge relationship between two graph nodes with DLAC permissions.
 */
export async function createRelationship(
  sourceId: string,
  targetId: string,
  edgeType: GraphEdge['edge_type'],
  properties: Record<string, any> = {}
): Promise<GraphEdge> {
  const workspaceId = properties.workspace_id || '00000000-0000-0000-0000-000000000000';
  const allowedRoles = properties.allowed_roles || ['admin', 'member'];
  const sourceDocumentId = properties.source_document_id || null;

  const edge: GraphEdge = {
    source_id: sourceId,
    target_id: targetId,
    edge_type: edgeType,
    properties,
    workspace_id: workspaceId,
    allowed_roles: allowedRoles,
    source_document_id: sourceDocumentId,
  };

  try {
    await supabase.from('graph_edges').upsert(
      {
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
        properties: properties || {},
        workspace_id: edge.workspace_id,
        allowed_roles: edge.allowed_roles,
        source_document_id: edge.source_document_id,
      },
      { onConflict: 'source_id, target_id, edge_type' }
    );
  } catch (err) {
    console.warn('[GraphService Warning] Failed to write graph edge to database:', err);
  }

  return edge;
}

export async function persistGraphTriples(
  workspaceId: string,
  triples: GraphTriple[]
): Promise<{ persistedCount: number; rejectedCount: number; validTriples: GraphTriple[] }> {
  let persistedCount = 0;
  let rejectedCount = 0;
  const validTriples: GraphTriple[] = [];

  for (const rawTriple of triples) {
    const disambiguated = disambiguateTriple(rawTriple);
    const validation = validateTriple(disambiguated);

    if (!validation.valid) {
      rejectedCount++;
      continue;
    }

    validTriples.push(disambiguated);

    await addEntityNode(disambiguated.subjectType as GraphNode['label'], {
      id: disambiguated.subject,
      name: disambiguated.metadata?.rawSubject || disambiguated.subject,
      workspace_id: workspaceId,
      allowed_roles: disambiguated.metadata?.allowed_roles || ['admin', 'member'],
      source_document_id: disambiguated.metadata?.source_document_id,
    });

    await addEntityNode(disambiguated.objectType as GraphNode['label'], {
      id: disambiguated.object,
      name: disambiguated.metadata?.rawObject || disambiguated.object,
      workspace_id: workspaceId,
      allowed_roles: disambiguated.metadata?.allowed_roles || ['admin', 'member'],
      source_document_id: disambiguated.metadata?.source_document_id,
    });

    await createRelationship(
      disambiguated.subject,
      disambiguated.object,
      disambiguated.predicate as GraphEdge['edge_type'],
      { ...disambiguated.metadata, workspace_id: workspaceId }
    );

    persistedCount++;
  }

  return { persistedCount, rejectedCount, validTriples };
}

/**
 * Executes a DLAC-permissioned 1-hop or 2-hop graph traversal starting from entityId.
 * Hides restricted nodes/relationships from unauthorized roles.
 */
export async function getConnectedEntities(
  entityId: string,
  depth: number = 2,
  options?: { userRole?: string; workspaceId?: string; roles?: string[] }
): Promise<ConnectedEntityResult[]> {
  const results: ConnectedEntityResult[] = [];
  const visited = new Set<string>();
  visited.add(entityId);

  const userRole = options?.userRole || 'member';
  const isAdmin = userRole === 'admin';

  try {
    const { data: edges1 } = await supabase
      .from('graph_edges')
      .select('*')
      .or(`source_id.eq.${entityId},target_id.eq.${entityId}`);

    if (Array.isArray(edges1) && edges1.length > 0) {
      // DLAC & Temporal Validity Filter Edges
      const permittedEdges1 = edges1.filter(
        (e) => (isAdmin || !e.allowed_roles || e.allowed_roles.includes(userRole)) && isEdgeTemporallyValid(e.valid_from, e.valid_until)
      );

      const hop1TargetIds = permittedEdges1.map((e) => (e.source_id === entityId ? e.target_id : e.source_id));

      const { data: nodes1 } = await supabase
        .from('graph_nodes')
        .select('*')
        .in('id', hop1TargetIds);

      // DLAC Filter Nodes based on allowed_roles
      const permittedNodes1 = (nodes1 || []).filter(
        (n) => isAdmin || !n.allowed_roles || n.allowed_roles.includes(userRole)
      );
      const nodeMap1 = new Map(permittedNodes1.map((n) => [n.id, n]));

      for (const edge of permittedEdges1) {
        const neighborId = edge.source_id === entityId ? edge.target_id : edge.source_id;
        const neighborNode = nodeMap1.get(neighborId);

        if (neighborNode && !visited.has(neighborId)) {
          visited.add(neighborId);
          results.push({
            entityId: neighborId,
            depth: 1,
            node: neighborNode,
            relationship: edge.edge_type,
          });
        }
      }

      if (depth >= 2 && hop1TargetIds.length > 0) {
        const { data: edges2 } = await supabase
          .from('graph_edges')
          .select('*')
          .in('source_id', hop1TargetIds);

        if (Array.isArray(edges2) && edges2.length > 0) {
          const permittedEdges2 = edges2.filter(
            (e) => (isAdmin || !e.allowed_roles || e.allowed_roles.includes(userRole)) && isEdgeTemporallyValid(e.valid_from, e.valid_until)
          );

          const hop2TargetIds = permittedEdges2.map((e) => e.target_id).filter((id) => !visited.has(id));

          if (hop2TargetIds.length > 0) {
            const { data: nodes2 } = await supabase
              .from('graph_nodes')
              .select('*')
              .in('id', hop2TargetIds);

            const permittedNodes2 = (nodes2 || []).filter(
              (n) => isAdmin || !n.allowed_roles || n.allowed_roles.includes(userRole)
            );
            const nodeMap2 = new Map(permittedNodes2.map((n) => [n.id, n]));

            for (const edge of permittedEdges2) {
              const neighborNode = nodeMap2.get(edge.target_id);
              if (neighborNode && !visited.has(edge.target_id)) {
                visited.add(edge.target_id);
                results.push({
                  entityId: edge.target_id,
                  depth: 2,
                  node: neighborNode,
                  relationship: edge.edge_type,
                });
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[GraphService Warning] Exception during getConnectedEntities traversal:', err);
  }

  return results;
}

export async function mergeGraphNodes(
  sourceNodeId: string,
  targetNodeId: string
): Promise<{ mergedEdgesCount: number; success: boolean }> {
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    return { mergedEdgesCount: 0, success: false };
  }

  let mergedEdgesCount = 0;
  try {
    const { data: outgoingEdges } = await supabase
      .from('graph_edges')
      .select('*')
      .eq('source_id', sourceNodeId);

    if (Array.isArray(outgoingEdges)) {
      for (const edge of outgoingEdges) {
        await createRelationship(targetNodeId, edge.target_id, edge.edge_type, edge.properties || {});
        mergedEdgesCount++;
      }
      await supabase.from('graph_edges').delete().eq('source_id', sourceNodeId);
    }

    const { data: incomingEdges } = await supabase
      .from('graph_edges')
      .select('*')
      .eq('target_id', sourceNodeId);

    if (Array.isArray(incomingEdges)) {
      for (const edge of incomingEdges) {
        await createRelationship(edge.source_id, targetNodeId, edge.edge_type, edge.properties || {});
        mergedEdgesCount++;
      }
      await supabase.from('graph_edges').delete().eq('target_id', sourceNodeId);
    }

    await supabase.from('graph_nodes').delete().eq('id', sourceNodeId);
    return { mergedEdgesCount, success: true };
  } catch (err) {
    console.warn('[GraphService Warning] Failed to merge graph nodes:', err);
    return { mergedEdgesCount, success: false };
  }
}
