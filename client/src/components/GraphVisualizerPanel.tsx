import { useState, useEffect } from 'react';
import { Network, RefreshCw, Layers } from 'lucide-react';
import { getGraphEntities, type GraphDataResponse } from '../services/apiClient';

export function GraphVisualizerPanel() {
  const [loading, setLoading] = useState(false);
  const [graphData, setGraphData] = useState<GraphDataResponse | null>(null);

  const fetchGraph = async () => {
    setLoading(true);
    try {
      const data = await getGraphEntities();
      setGraphData(data);
    } catch {
      setGraphData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGraph();
  }, []);

  return (
    <div className="glass-panel rounded-2xl p-5 border border-black/[0.08] space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-5 w-5 text-[#0071e3]" />
          <div>
            <h3 className="text-[16px] font-semibold text-[#1d1d1f]">Apache AGE Enterprise Knowledge Graph</h3>
            <p className="text-[12.5px] text-[#6e6e73]">PostgreSQL Cypher Vertices (Person, System, SOP, Rule, Step) & Relationships</p>
          </div>
        </div>
        <button
          type="button"
          onClick={fetchGraph}
          disabled={loading}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-[12px] font-medium text-slate-700 hover:bg-slate-50 active:scale-95 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Graph
        </button>
      </div>

      {!graphData || graphData.nodes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-[13px] text-slate-500 space-y-2">
          <Layers className="mx-auto h-6 w-6 text-slate-400" />
          <p>No graph nodes found yet. Run an ingestion crawl to extract graph entities!</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-[12px] font-medium text-slate-600">
            <span>Vertices (Nodes): <strong>{graphData.nodes.length}</strong></span>
            <span>Edges (Relationships): <strong>{graphData.edges.length}</strong></span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {graphData.nodes.map((node) => (
              <div key={node.id} className="rounded-xl border border-slate-200 bg-white/80 p-3.5 space-y-1 text-[12.5px]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">{node.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    node.label === 'System' ? 'bg-blue-100 text-blue-800' :
                    node.label === 'SOP' ? 'bg-[#0071e3]/10 text-[#0071e3]' :
                    node.label === 'Person' ? 'bg-purple-100 text-purple-800' : 'bg-slate-100 text-slate-800'
                  }`}>
                    {node.label}
                  </span>
                </div>
                <div className="text-[11px] font-mono text-slate-500">ID: {node.id}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
