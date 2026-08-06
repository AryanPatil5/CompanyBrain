import { topologicalSort, findShortestPath, findConnectedComponents, calculateDepth, isGraphAcyclic } from '../graph/algorithms.js';

jest.mock('../graph/algorithms.js');

describe('Phase 0: Graph Algorithms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should perform topological sort on linear graph', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'C' }] },
      { id: 'C', outgoingEdges: [] }
    ];

    const result = topologicalSort(nodes);
    expect(result).toEqual(['A', 'B', 'C']);
  });

  test('should detect cycle in graph', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'C' }] },
      { id: 'C', outgoingEdges: [{ targetId: 'A' }] }
    ];

    expect(() => topologicalSort(nodes)).toThrow('Graph contains a cycle');
  });

  test('should find shortest path between nodes', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }, { targetId: 'C' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'D' }] },
      { id: 'C', outgoingEdges: [{ targetId: 'D' }] },
      { id: 'D', outgoingEdges: [] }
    ];

    const result = findShortestPath(nodes, 'A', 'D');
    expect(result).toEqual(['A', 'B', 'D']);
  });

  test('should find connected components in undirected graph', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }, { targetId: 'C' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'A' }, { targetId: 'C' }] },
      { id: 'C', outgoingEdges: [{ targetId: 'A' }, { targetId: 'B' }] },
      { id: 'D', outgoingEdges: [{ targetId: 'E' }] },
      { id: 'E', outgoingEdges: [{ targetId: 'D' }] },
      { id: 'F', outgoingEdges: [] }
    ];

    const result = findConnectedComponents(nodes);
    expect(result).toEqual([['A', 'B', 'C'], ['D', 'E'], ['F']]);
  });

  test('should calculate depth from root node', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }, { targetId: 'C' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'D' }] },
      { id: 'C', outgoingEdges: [] },
      { id: 'D', outgoingEdges: [] }
    ];

    const result = calculateDepth(nodes, 'A');
    expect(result.get('A')).toBe(0);
    expect(result.get('B')).toBe(1);
    expect(result.get('C')).toBe(1);
    expect(result.get('D')).toBe(2);
  });

  test('should validate acyclic graph', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'C' }] },
      { id: 'C', outgoingEdges: [] }
    ];

    expect(isGraphAcyclic(nodes)).toBe(true);
  });

  test('should reject cyclic graph', () => {
    const nodes = [
      { id: 'A', outgoingEdges: [{ targetId: 'B' }] },
      { id: 'B', outgoingEdges: [{ targetId: 'C' }] },
      { id: 'C', outgoingEdges: [{ targetId: 'A' }] }
    ];

    expect(isGraphAcyclic(nodes)).toBe(false);
  });
});