// Graph algorithm library for relational graph system-of-record (ADR-T4 executed in Phase 0)

/**
 * Topological sort for dependency resolution
 * Returns nodes in order where dependencies come before dependents
 */
export function topologicalSort(
  nodes: { id: string; outgoingEdges: Array<{ targetId: string }> }[]
): string[] {
  const graph = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  // Initialize graph
  for (const node of nodes) {
    graph.set(node.id, new Set());
    inDegree.set(node.id, 0);
  }

  // Build adjacency list and in-degree counts
  for (const node of nodes) {
    for (const edge of node.outgoingEdges) {
      if (graph.has(edge.targetId)) {
        graph.get(node.id)?.add(edge.targetId);
        inDegree.set(edge.targetId, (inDegree.get(edge.targetId) || 0) + 1);
      }
    }
  }

  // Queue of nodes with no incoming edges
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) queue.push(nodeId);
  }

  const result: string[] = [];

  // Process nodes
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const neighbor of graph.get(current) || []) {
      inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Check for cycles
  if (result.length !== nodes.length) {
    throw new Error('Graph contains a cycle, cannot perform topological sort');
  }

  return result;
}

/**
 * Find shortest path between two nodes using BFS
 * Returns array of node IDs representing the path
 */
export function findShortestPath(
  nodes: { id: string; outgoingEdges: Array<{ targetId: string }> }[],
  startId: string,
  endId: string
): string[] {
  const graph = new Map<string, Set<string>>();

  // Build adjacency list
  for (const node of nodes) {
    graph.set(node.id, new Set());
    for (const edge of node.outgoingEdges) {
      graph.get(node.id)?.add(edge.targetId);
    }
  }

  // BFS
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [startId] }];

  while (queue.length > 0) {
    const { nodeId, path } = queue.shift()!;

    if (nodeId === endId) {
      return path;
    }

    visited.add(nodeId);

    for (const neighbor of graph.get(nodeId) || []) {
      if (!visited.has(neighbor)) {
        queue.push({ nodeId: neighbor, path: [...path, neighbor] });
      }
    }
  }

  return []; // No path found
}

/**
 * Find connected components in an undirected graph
 * Returns array of arrays, each containing node IDs in a component
 */
export function findConnectedComponents(
  nodes: { id: string; outgoingEdges: Array<{ targetId: string }> }[]
): string[][] {
  const graph = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const components: string[][] = [];

  // Build undirected adjacency list
  for (const node of nodes) {
    graph.set(node.id, new Set());
    for (const edge of node.outgoingEdges) {
      graph.get(node.id)?.add(edge.targetId);
      graph.get(edge.targetId)?.add(node.id);
    }
  }

  // Helper function for DFS
  function dfs(nodeId: string, component: string[]): void {
    visited.add(nodeId);
    component.push(nodeId);

    for (const neighbor of graph.get(nodeId) || []) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, component);
      }
    }
  }

  // Find all components
  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const component: string[] = [];
      dfs(node.id, component);
      components.push(component);
    }
  }

  return components;
}

/**
 * Calculate the depth of nodes from a root in a directed graph
 * Returns map of node ID to depth
 */
export function calculateDepth(
  nodes: { id: string; outgoingEdges: Array<{ targetId: string }> }[],
  rootId: string
): Map<string, number> {
  const depths: Map<string, number> = new Map();
  const visited = new Set<string>();

  // Helper function for DFS with depth tracking
  function dfs(nodeId: string, currentDepth: number): void {
    depths.set(nodeId, currentDepth);
    visited.add(nodeId);

    for (const edge of nodes.find(n => n.id === nodeId)?.outgoingEdges || []) {
      if (!visited.has(edge.targetId)) {
        dfs(edge.targetId, currentDepth + 1);
      }
    }
  }

  dfs(rootId, 0);

  return depths;
}

/**
 * Validate that the graph is acyclic
 * Returns true if acyclic, false otherwise
 */
export function isGraphAcyclic(
  nodes: { id: string; outgoingEdges: Array<{ targetId: string }> }[]
): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  // Helper function for DFS cycle detection
  function hasCycle(nodeId: string): boolean {
    if (recursionStack.has(nodeId)) {
      return true;
    }
    if (visited.has(nodeId)) {
      return false;
    }

    visited.add(nodeId);
    recursionStack.add(nodeId);

    for (const edge of nodes.find(n => n.id === nodeId)?.outgoingEdges || []) {
      if (hasCycle(edge.targetId)) {
        return true;
      }
    }

    recursionStack.delete(nodeId);
    return false;
  }

  for (const node of nodes) {
    if (!visited.has(node.id) && hasCycle(node.id)) {
      return false;
    }
  }

  return true;
}