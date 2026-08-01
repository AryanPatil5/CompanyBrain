import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Database, ShieldCheck, AlertTriangle, Activity } from "lucide-react";
import { GlassSidebar } from "@/components/GlassSidebar";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SopCard } from "@/components/SopCard";
import { SopInspector } from "@/components/SopInspector";
import { fetchSops, approveSopApi, confirmSopApi, fetchAnalytics, MOCK_SOPS, type Sop, type Analytics } from "@/lib/sops";

export const Route = createFileRoute("/")(  {
  head: () => ({
    meta: [
      { title: "Company Brain — Procedural Skills Library" },
      {
        name: "description",
        content:
          "Inspect and approve operational SOPs for autonomous AI agents in the Company Brain knowledge engine.",
      },
      { property: "og:title", content: "Company Brain — Procedural Skills Library" },
      {
        property: "og:description",
        content:
          "An AI-native operational knowledge engine for inspecting and approving agent SOPs.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [sops, setSops] = useState<Sop[]>(MOCK_SOPS);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("All");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ sops: next, live: isLive }, stats] = await Promise.all([
      fetchSops(),
      fetchAnalytics(),
    ]);
    setSops(next);
    setLive(isLive);
    setAnalytics(stats);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => (category === "All" ? sops : sops.filter((s) => s.category === category)),
    [sops, category],
  );

  // Approval handler with optimistic state & API persistence
  const approve = async (id: string) => {
    setSops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: "approved" as const } : s)),
    );

    if (live) {
      const success = await approveSopApi(id);
      if (!success) {
        console.error(`Failed to persist approval for SOP: ${id}`);
        void load();
      }
    }
  };

  // Confirm SOP as current (reset staleness)
  const confirm = async (id: string) => {
    setSops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, isStale: false, lastConfirmedAt: new Date().toISOString() } : s)),
    );

    if (live) {
      const success = await confirmSopApi(id);
      if (!success) {
        console.error(`Failed to confirm SOP: ${id}`);
        void load();
      }
    }
  };

  const activeSop = sops.find((s) => s.id === activeId) ?? null;

  return (
    <div className="relative min-h-screen">
      <div className="ambient-field" aria-hidden />

      <div className="relative flex min-h-screen gap-5 p-5">
        <GlassSidebar />

        <main className="flex min-w-0 flex-1 flex-col gap-5">
          <header className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-3xl px-6 py-5">
            <div className="space-y-1.5">
              <h1 className="text-[26px] leading-tight font-semibold">
                Procedural Skills Library
              </h1>
              <p className="text-[13.5px] text-muted-foreground">
                Inspect and approve operational SOPs for autonomous AI agents.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden items-center gap-2 text-[12px] text-muted-foreground sm:flex">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald shadow-[0_0_10px_2px_var(--emerald)]" : "bg-amber shadow-[0_0_10px_2px_var(--amber)]"}`}
                />
                {live ? "Live API" : "Offline · mock data"}
              </span>
              <button
                type="button"
                onClick={() => void load()}
                className="glass-button specular flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-medium"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
                Refresh Engine
              </button>
            </div>
          </header>

          {/* Analytics Stats Bar */}
          {analytics && live && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3">
                <Database className="h-4 w-4 text-indigo" />
                <div>
                  <p className="text-[20px] font-semibold leading-tight">{analytics.total_sops}</p>
                  <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">Total SOPs</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3">
                <ShieldCheck className="h-4 w-4 text-emerald" />
                <div>
                  <p className="text-[20px] font-semibold leading-tight">{analytics.by_status?.Approved || 0}</p>
                  <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">Approved</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3">
                <AlertTriangle className="h-4 w-4 text-amber" />
                <div>
                  <p className="text-[20px] font-semibold leading-tight">{analytics.stale_count}</p>
                  <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">Stale</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3">
                <Activity className="h-4 w-4 text-cyan" />
                <div>
                  <p className="text-[20px] font-semibold leading-tight">{analytics.recent_executions}</p>
                  <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">Executions (7d)</p>
                </div>
              </div>
            </div>
          )}

          <SegmentedControl value={category} onChange={setCategory} />

          <section className="grid grid-cols-1 gap-5 pb-6 md:grid-cols-2 2xl:grid-cols-3">
            {filtered.map((sop) => (
              <SopCard
                key={sop.id}
                sop={sop}
                onInspect={() => setActiveId(sop.id)}
                onApprove={() => void approve(sop.id)}
                onConfirm={() => void confirm(sop.id)}
              />
            ))}
            {filtered.length === 0 && (
              <p className="text-[13.5px] text-muted-foreground">
                No SOPs indexed for this category yet.
              </p>
            )}
          </section>
        </main>
      </div>

      <SopInspector
        sop={activeSop}
        onClose={() => setActiveId(null)}
        onApprove={(id) => void approve(id)}
        onConfirm={(id) => void confirm(id)}
      />
    </div>
  );
}