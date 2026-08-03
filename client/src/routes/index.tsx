import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Database, ShieldCheck, AlertTriangle, Activity, Sparkles, ShieldAlert, Check, X } from "lucide-react";
import { GlassSidebar, type NavTab } from "@/components/GlassSidebar";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SopCard } from "@/components/SopCard";
import { SopInspector } from "@/components/SopInspector";
import { TeachBrainModal } from "@/components/TeachBrainModal";
import { FastMcpNetworkModal } from "@/components/FastMcpNetworkModal";
import { IntegrationsModal } from "@/components/IntegrationsModal";
import { IngestionStatusWidget } from "@/components/IngestionStatusWidget";
import { HybridSearchBar } from "@/components/HybridSearchBar";
import { AgentExecutionConsole } from "@/components/AgentExecutionConsole";
import { GraphVisualizerPanel } from "@/components/GraphVisualizerPanel";
import {
  fetchSops,
  approveSopApi,
  confirmSopApi,
  fetchAnalytics,
  fetchPendingApprovals,
  resolveApprovalApi,
  MOCK_SOPS,
  type Sop,
  type Analytics,
  type PendingApproval,
} from "@/lib/sops";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Company Brain — Procedural Skills Library" },
      {
        name: "description",
        content:
          "Inspect and approve operational SOPs for autonomous AI agents in the Company Brain knowledge engine.",
      },
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
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [isTeachModalOpen, setIsTeachModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<NavTab>("skills");

  const load = useCallback(async () => {
    setLoading(true);
    const [{ sops: next, live: isLive }, stats, approvals] = await Promise.all([
      fetchSops(),
      fetchAnalytics(),
      fetchPendingApprovals(),
    ]);
    setSops(next);
    setLive(isLive);
    setAnalytics(stats);
    setPendingApprovals(approvals);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () => (category === "All" ? sops : sops.filter((s) => s.category === category)),
    [sops, category],
  );

  const approve = async (id: string) => {
    setSops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, status: "approved" as const } : s)),
    );

    if (live) {
      const success = await approveSopApi(id);
      if (!success) {
        void load();
      }
    }
  };

  const confirm = async (id: string) => {
    setSops((prev) =>
      prev.map((s) => (s.id === id ? { ...s, isStale: false, lastConfirmedAt: new Date().toISOString() } : s)),
    );

    if (live) {
      const success = await confirmSopApi(id);
      if (!success) {
        void load();
      }
    }
  };

  const handleResolveApproval = async (approvalId: string, status: "approved" | "rejected") => {
    setPendingApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    if (live) {
      await resolveApprovalApi(approvalId, status);
      void load();
    }
  };

  const activeSop = sops.find((s) => s.id === activeId) ?? null;

  return (
    <div className="relative min-h-screen">
      <div className="ambient-field" aria-hidden />

      <div className="relative flex min-h-screen gap-5 p-5">
        <GlassSidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onTeachClick={() => setIsTeachModalOpen(true)}
        />

        <main className="flex min-w-0 flex-1 flex-col gap-5">
          <header className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-2xl px-6 py-5 overflow-hidden">
            <div className="space-y-1">
              <h1 className="text-[26px] leading-tight font-semibold text-[#1d1d1f]">
                Procedural Skills Library
              </h1>
              <p className="text-[13.5px] text-[#6e6e73]">
                Inspect, govern, and approve operational SOPs for autonomous AI agents.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="hidden items-center gap-2 text-[12px] font-medium text-[#6e6e73] sm:flex">
                <span
                  className={`h-2 w-2 rounded-full ${live ? "bg-[#10b981] shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-[#f59e0b] shadow-[0_0_8px_rgba(245,158,11,0.6)]"}`}
                />
                {live ? "Live API" : "Offline · mock data"}
              </span>

              <button
                type="button"
                onClick={() => setIsTeachModalOpen(true)}
                className="specular flex h-11 items-center gap-2 overflow-hidden rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-5 text-[13px] font-medium text-white shadow-[0_4px_14px_rgba(0,113,227,0.25)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-95 cursor-pointer"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Teach the Brain
              </button>

              <button
                type="button"
                onClick={() => void load()}
                className="glass-button specular flex h-11 items-center gap-2 overflow-hidden rounded-lg px-5 text-[13px] font-medium text-[#1d1d1f] active:scale-95 cursor-pointer"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
                Refresh Engine
              </button>
            </div>
          </header>

          {/* Real-time Agent Approval Queue */}
          {pendingApprovals.length > 0 && live && (
            <section className="glass-card rounded-2xl border-amber-200 bg-amber-50/50 p-5 space-y-3 overflow-hidden">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-amber-800 flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" /> Agent Real-Time Execution Approval Queue ({pendingApprovals.length})
                </h3>
                <span className="text-[11px] font-semibold text-slate-500">Human Guardrail Triggered</span>
              </div>
              <div className="space-y-2">
                {pendingApprovals.map((req) => (
                  <div key={req.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/80 p-3.5 shadow-sm overflow-hidden">
                    <div className="space-y-0.5">
                      <p className="text-[13.5px] font-medium text-[#1d1d1f]">
                        Agent <code className="text-sky-800 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded-2xl font-mono font-semibold">{req.agent_id}</code> requested to execute: <span className="font-semibold text-[#1d1d1f]">{req.skills_sops?.title || "High-Risk SOP"}</span>
                      </p>
                      <p className="text-[11.5px] text-slate-700">
                        Risk Level: <span className="text-amber-700 font-semibold">{req.risk_level}</span> · Reason: {req.reason}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, "approved")}
                        className="glass-button flex h-10 items-center gap-1.5 overflow-hidden rounded-lg border-green-200 bg-green-50 px-4 text-[12px] font-semibold text-green-800 hover:bg-green-100 active:scale-95 cursor-pointer"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve Execution
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, "rejected")}
                        className="glass-button flex h-10 items-center gap-1.5 overflow-hidden rounded-lg border-red-200 bg-red-50 px-4 text-[12px] font-semibold text-red-700 hover:bg-red-100 active:scale-95 cursor-pointer"
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Analytics Stats Bar */}
          {analytics && live && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3.5 overflow-hidden">
                <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#0071e3]/10 text-[#0071e3]">
                  <Database className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-[22px] font-semibold leading-none text-[#1d1d1f]">{analytics.total_sops}</p>
                  <p className="mt-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Total SOPs</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3.5 overflow-hidden">
                <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#10b981]/10 text-[#059669]">
                  <ShieldCheck className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-[22px] font-semibold leading-none text-[#1d1d1f]">{analytics.by_status?.Approved || 0}</p>
                  <p className="mt-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Approved</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3.5 overflow-hidden">
                <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-amber-100/70 text-amber-700">
                  <ShieldAlert className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-[22px] font-semibold leading-none text-[#1d1d1f]">{analytics.pending_approvals_count || 0}</p>
                  <p className="mt-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Gated Queue</p>
                </div>
              </div>
              <div className="glass-card flex items-center gap-3 rounded-2xl px-4 py-3.5 overflow-hidden">
                <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#0284c7]/10 text-[#0369a1]">
                  <Activity className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-[22px] font-semibold leading-none text-[#1d1d1f]">{analytics.recent_executions}</p>
                  <p className="mt-1 text-[10px] font-semibold tracking-wider text-slate-500 uppercase">Executions (7d)</p>
                </div>
              </div>
            </div>
          )}

          {/* Active Tab View Switching */}
          {activeTab === "graph" && (
            <GraphVisualizerPanel />
          )}

          {activeTab === "agents" && (
            <AgentExecutionConsole />
          )}

          {activeTab === "skills" && (
            <>
              <IngestionStatusWidget />
              <HybridSearchBar />
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
                  <p className="text-[13.5px] text-[#6e6e73]">
                    No SOPs indexed for this category yet.
                  </p>
                )}
              </section>
            </>
          )}
        </main>
      </div>

      <SopInspector
        sop={activeSop}
        onClose={() => setActiveId(null)}
        onApprove={(id) => void approve(id)}
        onConfirm={(id) => void confirm(id)}
      />

      <TeachBrainModal
        isOpen={isTeachModalOpen}
        onClose={() => setIsTeachModalOpen(false)}
        onSuccess={() => void load()}
      />

      <FastMcpNetworkModal
        isOpen={activeTab === "mcp"}
        onClose={() => setActiveTab("skills")}
      />

      <IntegrationsModal
        isOpen={activeTab === "integrations"}
        onClose={() => setActiveTab("skills")}
      />
    </div>
  );
}