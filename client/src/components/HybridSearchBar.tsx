import { useState } from 'react';
import { Search, Sparkles, ShieldCheck, Zap } from 'lucide-react';
import { searchHybrid, type HybridSearchResultItem } from '../services/apiClient';

export function HybridSearchBar() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<HybridSearchResultItem[]>([]);
  const [searched, setSearched] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setSearched(true);
    try {
      const items = await searchHybrid(query);
      setResults(items);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSearch} className="relative flex items-center">
        <Search className="absolute left-4 h-4 w-4 text-[#6e6e73]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Hybrid Search (e.g. ERR_502_GATEWAY or slow postgres query)..."
          className="h-12 w-full rounded-2xl border border-black/[0.1] bg-white/70 pl-11 pr-32 text-[14px] text-[#1d1d1f] placeholder:text-[#6e6e73] backdrop-blur-xl focus:border-[#0071e3] focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="absolute right-2 flex h-8 items-center gap-1.5 rounded-xl bg-[#0071e3] px-3.5 text-[12px] font-medium text-white shadow-sm hover:bg-[#0071e3]/90 active:scale-95 cursor-pointer disabled:opacity-50"
        >
          <Sparkles className="h-3 w-3" />
          RRF Search
        </button>
      </form>

      {searched && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-[12px] font-medium text-[#6e6e73]">
            <span>Reciprocal Rank Fusion (RRF) Results</span>
            <span>{results.length} fused matches found</span>
          </div>

          {results.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-[13px] text-slate-500">
              No matching SOPs found for "{query}".
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {results.map((item) => (
              <div key={item.id} className="glass-card flex flex-col justify-between gap-3 rounded-xl p-4 border border-black/[0.06]">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-[14.5px] font-semibold text-[#1d1d1f]">{item.title}</h4>
                  <span className="rounded-full bg-[#0071e3]/10 px-2.5 py-0.5 text-[10.5px] font-semibold text-[#0071e3]">
                    RRF Score: {item.rrfScore.toFixed(4)}
                  </span>
                </div>

                <p className="text-[12.5px] text-[#6e6e73] line-clamp-2">{item.trigger_condition}</p>

                <div className="flex items-center justify-between pt-1 text-[11px] text-[#6e6e73]">
                  <span className="flex items-center gap-1">
                    <Zap className="h-3 w-3 text-amber-500" />
                    Dense Rank: {item.denseRank ? `#${item.denseRank}` : 'N/A'}
                  </span>
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3 text-emerald-500" />
                    Sparse Rank: {item.sparseRank ? `#${item.sparseRank}` : 'N/A'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
