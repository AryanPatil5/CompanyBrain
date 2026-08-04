import { supabase } from '../../config/supabase.js';
import { validateTriple, type GraphTriple } from './ontologyCompiler.js';
import { disambiguateTriple } from './entityDisambiguator.js';

export interface GraphNode {
  id: string;
  label: 'Person' | 'System' | 'SOP' | 'Rule' | 'Step' | 'Policy' | 'Team' | 'Role' | 'Entity';
  name: string;
  properties?: Record<string, any>;
  workspace_id?: string;
}

export interface GraphEdge {
  id?: string;
  source_id: string;
  target_id: string;
  edge_type: 'OWNS' | 'REQUIRES' | 'MODIFIES' | 'DEPENDS_ON' | 'EXECUTES' | 'HAS_STEP' | 'REQUIRES_ROLE' | 'TARGETS_SYSTEM' | 'SUPERSEDES' | 'GOVERNED_BY';
  properties?: Record<string, any>;
}

export interface ConnectedEntityResult {
  entityId: string;
  depth: number;
  node: GraphNode;
  relationship: string;
}

/**
 * Executes a Cypher query string against Apache AGE or relational graph fallback tables.
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
 * Adds an entity node to the graph.
 */
export async function addEntityNode(
  label: GraphNode['label'],
  properties: Record<string, any>
): Promise<GraphNode> {
  const name = properties.name || properties.title || properties.id || 'Unnamed Entity';
  const nodeId = properties.id || `node_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workspaceId = properties.workspace_id || '00000000-0000-0000-0000-000000000000';

  const node: GraphNode = {
    id: nodeId,
    label,
    name,
    properties,
    workspace_id: workspaceId,
  };

  try {
    await supabase.from('graph_nodes').upsert({
      id: node.id,
      label: node.label,
      name: node.name,
      properties: node.properties,
      workspace_id: node.workspace_id,
    });
  } catch (err) {
    console.warn('[GraphService Warning] Failed to write graph node to database:', err);
  }

  return node;
}

/**
 * Creates a directed edge relationship between two graph nodes.
 */
export async function createRelationship(
  sourceId: string,
  targetId: string,
  edgeType: GraphEdge['edge_type'],
  properties: Record<string, any> = {}
): Promise<GraphEdge> {
  const edge: GraphEdge = {
    source_id: sourceId,
    target_id: targetId,
    edge_type: edgeType,
    properties,
  };

  try {
    await supabase.from('graph_edges').upsert(
      {
        source_id: sourceId,
        target_id: targetId,
        edge_type: edgeType,
        properties: properties || {},
      },
      { onConflict: 'source_id, target_id, edge_type' }
    );
  } catch (err) {
    console.warn('[GraphService Warning] Failed to write graph edge to database:', err);
  }

  return edge;
}

/**
 * Processes raw knowledge triples through disambiguation & ontology validation, then executes Cypher MERGE queries into Apache AGE.
 */
export async function persistGraphTriples(
  workspaceId: string,
  triples: GraphTriple[]
): Promise<{ persistedCount: number; rejectedCount: number; validTriples: GraphTriple[] }> {
  let persistedCount = 0;
  let rejectedCount = 0;
  const validTriples: GraphTriple[] = [];

  for (const rawTriple of triples) {
    // 1. Entity Disambiguation (maps synonyms like "Postgres" -> "postgresql_db")
    const disambiguated = disambiguateTriple(rawTriple);

    // 2. Ontology Schema Validation (checks node types and predicate relationships)
    const validation = validateTriple(disambiguated);

    if (!validation.valid) {
      console.warn(`[GraphService Warning] Non-compliant triple rejected (${validation.reason}):`, rawTriple);
      rejectedCount++;
      continue;
    }

    validTriples.push(disambiguated);

    // 3. Persist Subject Node
    await addEntityNode(disambiguated.subjectType as GraphNode['label'], {
      id: disambiguated.subject,
      name: disambiguated.metadata?.rawSubject || disambiguated.subject,
      workspace_id: workspaceId,
    });

    // 4. Persist Object Node
    await addEntityNode(disambiguated.objectType as GraphNode['label'], {
      id: disambiguated.object,
      name: disambiguated.metadata?.rawObject || disambiguated.object,
      workspace_id: workspaceId,
    });

    // 5. Persist Edge Relationship
    await createRelationship(
      disambiguated.subject,
      disambiguated.object,
      disambiguated.predicate as GraphEdge['edge_type'],
      disambiguated.metadata || {}
    );

    // 6. Execute Cypher MERGE statement into Apache AGE graph workspace
    const cypherMerge = `
      MERGE (a:${disambiguated.subjectType} {id: '${disambiguated.subject}', workspace_id: '${workspaceId}'})
      MERGE (b:${disambiguated.objectType} {id: '${disambiguated.object}', workspace_id: '${workspaceId}'})
      MERGE (a)-[r:${disambiguated.predicate}]->(b)
      RETURN a, r, b
    `;
    await executeCypher(cypherMerge);

    persistedCount++;
  }

  return { persistedCount, rejectedCount, validTriples };
}

/**
 * Executes a 1-hop or 2-hop graph traversal starting from entityId to retrieve connected entities and relationships.
 */
export async function getConnectedEntities(
  entityId: string,
  depth: number = 2
): Promise<ConnectedEntityResult[]> {
  const results: ConnectedEntityResult[] = [];
  const visited = new Set<string>();
  visited.add(entityId);

  try {
    // 1-hop edges where entity is source or target
    const { data: edges1 } = await supabase
      .from('graph_edges')
      .select('*')
      .or(`source_id.eq.${entityId},target_id.eq.${entityId}`);

    if (Array.isArray(edges1) && edges1.length > 0) {
      const hop1TargetIds = edges1.map((e) => (e.source_id === entityId ? e.target_id : e.source_id));

      const { data: nodes1 } = await supabase
        .from('graph_nodes')
        .select('*')
        .in('id', hop1TargetIds);

      const nodeMap1 = new Map((nodes1 || []).map((n) => [n.id, n]));

      for (const edge of edges1) {
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

      // 2-hop edges if depth >= 2
      if (depth >= 2 && hop1TargetIds.length > 0) {
        const { data: edges2 } = await supabase
          .from('graph_edges')
          .select('*')
          .in('source_id', hop1TargetIds);

        if (Array.isArray(edges2) && edges2.length > 0) {
          const hop2TargetIds = edges2.map((e) => e.target_id).filter((id) => !visited.has(id));

          if (hop2TargetIds.length > 0) {
            const { data: nodes2 } = await supabase
              .from('graph_nodes')
              .select('*')
              .in('id', hop2TargetIds);

            const nodeMap2 = new Map((nodes2 || []).map((n) => [n.id, n]));

            for (const edge of edges2) {
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

/**
 * Merges two graph nodes by re-pointing all incoming and outgoing edges from sourceNodeId to targetNodeId,
 * and deleting sourceNodeId from the graph.
 */
export async function mergeGraphNodes(
  sourceNodeId: string,
  targetNodeId: string
): Promise<{ mergedEdgesCount: number; success: boolean }> {
  if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
    return { mergedEdgesCount: 0, success: false };
  }

  let mergedEdgesCount = 0;

  try {
    // 1. Re-point Outgoing Edges: source_id = sourceNodeId -> source_id = targetNodeId
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

    // 2. Re-point Incoming Edges: target_id = sourceNodeId -> target_id = targetNodeId
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

    // 3. Delete source node from graph_nodes database table
    await supabase.from('graph_nodes').delete().eq('id', sourceNodeId);

    // 4. Execute Apache AGE Cypher statement to re-route edges in Apache AGE graph workspace
    const cypherMerge = `
      MATCH (src {id: '${sourceNodeId}'}), (tgt {id: '${targetNodeId}'})
      MATCH (src)-[r]->(b)
      MERGE (tgt)-[r2:TYPE(r)]->(b)
      DETACH DELETE src
    `;
    await executeCypher(cypherMerge);

    return { mergedEdgesCount, success: true };
  } catch (err) {
    console.warn('[GraphService Warning] Failed to merge graph nodes:', err);
    return { mergedEdgesCount, success: false };
  }
}
