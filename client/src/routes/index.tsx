import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Database, ShieldCheck, AlertTriangle, Activity, Sparkles, ShieldAlert, Check, X } from "lucide-react";
import { GlassSidebar } from "@/components/GlassSidebar";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SopCard } from "@/components/SopCard";
import { SopInspector } from "@/components/SopInspector";
import { TeachBrainModal } from "@/components/TeachBrainModal";
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
        <GlassSidebar onTeachClick={() => setIsTeachModalOpen(true)} />

        <main className="flex min-w-0 flex-1 flex-col gap-5">
          <header className="glass-panel flex flex-wrap items-center justify-between gap-4 rounded-3xl px-6 py-5">
            <div className="space-y-1.5">
              <h1 className="text-[26px] leading-tight font-semibold">
                Procedural Skills Library
              </h1>
              <p className="text-[13.5px] text-muted-foreground">
                Inspect, govern, and approve operational SOPs for autonomous AI agents.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="hidden items-center gap-2 text-[12px] text-muted-foreground sm:flex">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald shadow-[0_0_10px_2px_var(--emerald)]" : "bg-amber shadow-[0_0_10px_2px_var(--amber)]"}`}
                />
                {live ? "Live API" : "Offline · mock data"}
              </span>

              <button
                type="button"
                onClick={() => setIsTeachModalOpen(true)}
                className="specular flex items-center gap-2 rounded-full border border-indigo/40 bg-gradient-to-b from-indigo/80 to-primary/60 px-4 py-2 text-[13px] font-medium text-primary-foreground shadow-[0_0_20px_-4px_var(--indigo)]"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Teach the Brain
              </button>

              <button
                type="button"
                onClick={() => void load()}
                className="glass-button specular flex items-center gap-2 rounded-full px-5 py-2 text-[13px] font-medium"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                />
                Refresh Engine
              </button>
            </div>
          </header>

          {/* Real-time Agent Approval Queue (Human Execution Gate) */}
          {pendingApprovals.length > 0 && live && (
            <section className="glass-card rounded-3xl border-amber/40 bg-amber/[0.04] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-amber flex items-center gap-2">
                  <ShieldAlert className="h-4 w-4" /> Agent Real-Time Execution Approval Queue ({pendingApprovals.length})
                </h3>
                <span className="text-[11px] text-muted-foreground">Human Guardrail Triggered</span>
              </div>
              <div className="space-y-2">
                {pendingApprovals.map((req) => (
                  <div key={req.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/40 p-3.5">
                    <div className="space-y-1">
                      <p className="text-[13.5px] font-medium">
                        Agent <code className="text-cyan font-mono">{req.agent_id}</code> requested to execute: <span className="text-foreground">{req.skills_sops?.title || "High-Risk SOP"}</span>
                      </p>
                      <p className="text-[11.5px] text-muted-foreground">
                        Risk Level: <span className="text-amber font-semibold">{req.risk_level}</span> · Reason: {req.reason}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, "approved")}
                        className="glass-button flex items-center gap-1.5 rounded-full border-emerald/30 bg-emerald/10 px-3.5 py-1.5 text-[12px] font-medium text-emerald hover:bg-emerald/20"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve Execution
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveApproval(req.id, "rejected")}
                        className="glass-button flex items-center gap-1.5 rounded-full border-rose-500/30 bg-rose-500/10 px-3.5 py-1.5 text-[12px] font-medium text-rose-400 hover:bg-rose-500/20"
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
                <ShieldAlert className="h-4 w-4 text-amber" />
                <div>
                  <p className="text-[20px] font-semibold leading-tight">{analytics.pending_approvals_count || 0}</p>
                  <p className="text-[10.5px] tracking-wide text-muted-foreground uppercase">Gated Queue</p>
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

      <TeachBrainModal
        isOpen={isTeachModalOpen}
        onClose={() => setIsTeachModalOpen(false)}
        onSuccess={() => void load()}
      />
    </div>
  );
}