import { useEffect, useState } from "react";
import { X, ShieldCheck, AlertTriangle, History, Clock, ChevronDown, ChevronUp } from "lucide-react";
import type { Sop, SopVersion } from "@/lib/sops";
import { fetchVersions } from "@/lib/sops";
import { StatusPill } from "./SopCard";

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
    initial_extraction: "Created from thread",
    manual_edit: "Edited by user",
    approval: "Approved for MCP",
    re_extraction: "Re-extracted from source",
    conflict_resolution: "Conflict resolved",
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] duration-500 ease-out animate-in fade-in zoom-in-95">
        <header className="flex items-start justify-between gap-4 border-b border-white/10 p-6">
          <div className="space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-indigo/30 bg-indigo/10 px-2.5 py-1 text-[11px] font-medium text-indigo">
                {sop.category}
              </span>
              <StatusPill status={sop.status} />
              {sop.isStale && (
                <span className="flex items-center gap-1 rounded-full border border-amber/30 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Stale
                </span>
              )}
              {sop.version > 1 && (
                <span className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  <History className="h-2.5 w-2.5" />
                  v{sop.version}
                </span>
              )}
            </div>
            <h2 className="text-[21px] leading-snug font-semibold">{sop.title}</h2>
            <code className="block font-mono text-[12px] text-cyan">
              {sop.trigger}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="glass-button flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-6">
          {/* Execution Steps */}
          {sop.steps.map((step, i) => (
            <div
              key={i}
              className="glass-card flex gap-4 rounded-2xl p-4"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/[0.06] font-mono text-[12px] text-foreground">
                {i + 1}
              </span>
              <div className="space-y-2 min-w-0">
                <p className="text-[13.5px] leading-relaxed">{step.instruction}</p>
                <div className="flex flex-wrap gap-1.5">
                  <span className="inline-block rounded-md border border-white/12 bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {step.target}
                  </span>
                  {step.condition && (
                    <span className="inline-block rounded-md border border-cyan/20 bg-cyan/[0.06] px-2 py-0.5 font-mono text-[10px] text-cyan">
                      if: {step.condition}
                    </span>
                  )}
                  {step.onFailure && (
                    <span className="inline-block rounded-md border border-amber/20 bg-amber/[0.06] px-2 py-0.5 font-mono text-[10px] text-amber">
                      fallback: {step.onFailure}
                    </span>
                  )}
                </div>
                {step.parameters && Object.keys(step.parameters).length > 0 && (
                  <div className="rounded-lg border border-white/8 bg-black/20 px-2.5 py-1.5">
                    <p className="text-[9px] tracking-[0.1em] text-muted-foreground uppercase mb-1">Parameters</p>
                    <code className="text-[11px] text-muted-foreground">
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
                className="flex w-full items-center gap-2 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.06]"
              >
                <History className="h-3.5 w-3.5" />
                Version History ({versions.length})
                {showVersions ? <ChevronUp className="ml-auto h-3 w-3" /> : <ChevronDown className="ml-auto h-3 w-3" />}
              </button>
              {showVersions && (
                <div className="mt-2 space-y-1.5 pl-2">
                  {versions.map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-xl border border-white/6 bg-white/[0.02] px-3 py-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/12 bg-white/[0.05] font-mono text-[10px]">
                        {v.version_number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium">
                          {REASON_LABELS[v.change_reason] || v.change_reason}
                        </p>
                        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
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

        <footer className="flex flex-wrap justify-end gap-2 border-t border-white/10 p-5">
          <button
            type="button"
            onClick={onClose}
            className="glass-button rounded-full px-5 py-2.5 text-[13px] font-medium"
          >
            Close
          </button>
          {sop.isStale && onConfirm && (
            <button
              type="button"
              onClick={() => onConfirm(sop.id)}
              className="glass-button flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-medium text-amber"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Confirm Current
            </button>
          )}
          <button
            type="button"
            disabled={sop.status === "approved"}
            onClick={() => onApprove(sop.id)}
            className="specular relative flex items-center gap-2 overflow-hidden rounded-full border border-white/20 bg-gradient-to-b from-indigo to-primary px-5 py-2.5 text-[13px] font-medium text-primary-foreground shadow-[0_0_30px_-6px_var(--indigo)] transition-transform duration-300 hover:-translate-y-px disabled:pointer-events-none disabled:opacity-50"
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
