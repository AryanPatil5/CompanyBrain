import { useEffect, useState } from "react";
import { X, ShieldCheck, AlertTriangle, History, Clock, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react";
import type { Sop, SopVersion, RiskLevel } from "@/lib/sops";
import { fetchVersions } from "@/lib/sops";
import { StatusPill } from "./SopCard";

const RISK_TINT: Record<RiskLevel, string> = {
  Low: "text-[#059669] border-[#10b981]/25 bg-[#10b981]/10",
  Medium: "text-[#0284c7] border-[#0284c7]/25 bg-[#0284c7]/10",
  High: "text-[#d97706] border-[#f59e0b]/25 bg-[#f59e0b]/10",
  Critical: "text-[#dc2626] border-[#ef4444]/25 bg-[#ef4444]/10",
};

export function SopInspector({
  sop,
  onClose,
  onApprove,
  onConfirm,
}: {
  sop: Sop | null;
  onClose: () => void;
  onApprove: (id: string) => void;
  onConfirm?: (id: string) => void;
}) {
  const [versions, setVersions] = useState<SopVersion[]>([]);
  const [showVersions, setShowVersions] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (sop) {
      void fetchVersions(sop.id).then(setVersions);
    } else {
      setVersions([]);
      setShowVersions(false);
    }
  }, [sop?.id]);

  if (!sop) return null;

  const REASON_LABELS: Record<string, string> = {
    initial_extraction: "Created from source thread",
    manual_edit: "Edited by team lead",
    approval: "Approved for FastMCP",
    re_extraction: "Re-extracted from source",
    conflict_resolution: "Conflict/Duplicate resolved",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/25 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl duration-300 ease-out animate-in fade-in zoom-in-95">
        <header className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-[#0071e3]/20 bg-[#0071e3]/[0.08] px-2.5 py-1 text-[11px] font-medium text-[#0071e3]">
                {sop.category}
              </span>
              <span className={`flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase ${RISK_TINT[sop.riskLevel || "Low"]}`}>
                {sop.requiresHumanGate && <ShieldAlert className="h-3 w-3" />}
                {sop.riskLevel || "Low"} Risk
              </span>
              <StatusPill status={sop.status} />
              {sop.isStale && (
                <span className="flex items-center gap-1 rounded-md border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-2 py-0.5 text-[10px] font-medium text-[#d97706]">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Stale
                </span>
              )}
              {sop.version > 1 && (
                <span className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 text-[10px] font-medium text-[#6e6e73]">
                  <History className="h-2.5 w-2.5" />
                  v{sop.version}
                </span>
              )}
            </div>
            <h2 className="text-[21px] leading-snug font-semibold text-[#1d1d1f]">{sop.title}</h2>
            <code className="block font-mono text-[12px] font-medium text-[#0369a1]">
              {sop.trigger}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="glass-button flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-[#6e6e73] hover:text-[#1d1d1f] active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-6">
          {sop.requiresHumanGate && (
            <div className="rounded-lg border border-[#f59e0b]/30 bg-[#f59e0b]/[0.08] p-3.5 text-[12.5px] text-[#b45309]">
              <p className="font-semibold flex items-center gap-1.5">
                <ShieldAlert className="h-4 w-4" /> Real-Time Execution Guardrail Active
              </p>
              <p className="mt-1 text-[12px]">
                Because this procedure carries <strong>{sop.riskLevel} Risk</strong>, autonomous agents in low-trust roles are automatically gated and must submit a real-time execution approval request before performing these actions.
              </p>
            </div>
          )}

          {/* Execution Steps */}
          {sop.steps.map((step, i) => (
            <div
              key={i}
              className="glass-card flex gap-4 rounded-lg p-4 overflow-hidden"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-black/[0.08] bg-white font-mono text-[12px] font-semibold text-[#1d1d1f] shadow-sm">
                {i + 1}
              </span>
              <div className="space-y-2 min-w-0">
                <p className="text-[13.5px] leading-relaxed text-[#1d1d1f]">{step.instruction}</p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-block rounded-md border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 font-mono text-[11px] font-medium text-[#6e6e73]">
                    {step.target}
                  </span>
                  {step.condition && (
                    <span className="inline-block rounded-md border border-[#0284c7]/20 bg-[#0284c7]/[0.08] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#0369a1]">
                      if: {step.condition}
                    </span>
                  )}
                  {step.onFailure && (
                    <span className="inline-block rounded-md border border-[#f59e0b]/20 bg-[#f59e0b]/[0.08] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#b45309]">
                      fallback: {step.onFailure}
                    </span>
                  )}
                </div>
                {step.parameters && Object.keys(step.parameters).length > 0 && (
                  <div className="rounded-md border border-[#0284c7]/15 bg-[#0284c7]/[0.04] px-2.5 py-1.5">
                    <p className="text-[9px] tracking-[0.1em] text-[#6e6e73] uppercase font-semibold mb-1">Parameters</p>
                    <code className="text-[11px] font-mono text-[#0369a1]">
                      {Object.entries(step.parameters).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(" · ")}
                    </code>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Version History (collapsible) */}
          {versions.length > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowVersions(!showVersions)}
                className="flex w-full items-center gap-2 rounded-lg border border-black/[0.06] bg-black/[0.02] px-4 py-3 text-left text-[12px] font-medium text-[#6e6e73] transition-colors hover:bg-black/[0.05] active:scale-95"
              >
                <History className="h-3.5 w-3.5" />
                Version Audit History ({versions.length})
                {showVersions ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
              </button>
              {showVersions && (
                <div className="mt-2 space-y-1.5 pl-2">
                  {versions.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-lg border border-black/[0.06] bg-white/50 px-3 py-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-black/[0.08] bg-white font-mono text-[10px] font-semibold text-[#1d1d1f]">
                        {v.version_number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-[#1d1d1f]">
                          {REASON_LABELS[v.change_reason] || v.change_reason}
                        </p>
                        <p className="flex items-center gap-1.5 text-[10px] text-[#6e6e73]">
                          <Clock className="h-2.5 w-2.5" />
                          {new Date(v.created_at).toLocaleString()} · {v.changed_by}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-black/[0.06] p-5">
          <button
            type="button"
            onClick={onClose}
            className="glass-button flex h-11 items-center justify-center overflow-hidden rounded-lg px-6 text-[13px] font-medium active:scale-95"
          >
            Close
          </button>
          {sop.isStale && onConfirm && (
            <button
              type="button"
              onClick={() => onConfirm(sop.id)}
              className="glass-button flex h-11 items-center gap-2 overflow-hidden rounded-lg px-6 text-[13px] font-medium text-[#d97706] active:scale-95"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Confirm Current
            </button>
          )}
          <button
            type="button"
            disabled={sop.status === "approved"}
            onClick={() => onApprove(sop.id)}
            className="specular flex h-11 items-center gap-2 overflow-hidden rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-6 text-[13px] font-medium text-white shadow-[0_2px_10px_rgba(0,113,227,0.25)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
          >
            <ShieldCheck className="h-4 w-4" />
            {sop.status === "approved"
              ? "Approved for MCP Agents"
              : "Approve SOP for MCP Agents"}
          </button>
        </footer>
      </div>
    </div>
  );
}
