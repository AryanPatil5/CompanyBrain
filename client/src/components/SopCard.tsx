import type { Sop, RiskLevel } from "@/lib/sops";
import { ChevronRight, ShieldCheck, AlertTriangle, History, ShieldAlert } from "lucide-react";

const CATEGORY_TINT: Record<string, string> = {
  Engineering: "text-[#0369a1] border-[#0284c7]/20 bg-[#0284c7]/[0.08]",
  Support: "text-[#4f46e5] border-[#6366f1]/20 bg-[#6366f1]/[0.08]",
  Billing: "text-[#7c3aed] border-[#8b5cf6]/20 bg-[#8b5cf6]/[0.08]",
  Operations: "text-[#0284c7] border-[#0284c7]/20 bg-[#0284c7]/[0.06]",
  Security: "text-[#9333ea] border-[#a855f7]/20 bg-[#a855f7]/[0.08]",
};

const RISK_TINT: Record<RiskLevel, string> = {
  Low: "text-[#059669] border-[#10b981]/25 bg-[#10b981]/10",
  Medium: "text-[#0284c7] border-[#0284c7]/25 bg-[#0284c7]/10",
  High: "text-[#d97706] border-[#f59e0b]/25 bg-[#f59e0b]/10",
  Critical: "text-[#dc2626] border-[#ef4444]/25 bg-[#ef4444]/10",
};

export function StatusPill({ status }: { status: Sop["status"] }) {
  const approved = status === "approved";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide backdrop-blur-xl",
        approved
          ? "border-[#10b981]/30 bg-[#10b981]/10 text-[#059669]"
          : "border-[#f59e0b]/30 bg-[#f59e0b]/10 text-[#d97706]",
      ].join(" ")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-sm ${approved ? "bg-[#10b981]" : "bg-[#f59e0b]"}`}
      />
      {approved ? "Approved" : "Draft"}
    </span>
  );
}

export function SopCard({
  sop,
  onInspect,
  onApprove,
  onConfirm,
}: {
  sop: Sop;
  onInspect: () => void;
  onApprove: () => void;
  onConfirm?: () => void;
}) {
  return (
    <article className="glass-card glass-card-hover flex flex-col gap-4 rounded-lg p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              "rounded-md border px-2.5 py-1 text-[11px] font-medium tracking-wide backdrop-blur-xl",
              CATEGORY_TINT[sop.category] ?? "text-[#4f46e5] border-[#6366f1]/20 bg-[#6366f1]/[0.08]",
            ].join(" ")}
          >
            {sop.category}
          </span>
          <span
            className={[
              "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase",
              RISK_TINT[sop.riskLevel || "Low"],
            ].join(" ")}
          >
            {sop.requiresHumanGate && <ShieldAlert className="h-2.5 w-2.5" />}
            {sop.riskLevel || "Low"} Risk
          </span>
          {sop.version > 1 && (
            <span className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 text-[10px] font-medium text-[#6e6e73]">
              <History className="h-2.5 w-2.5" />
              v{sop.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {sop.isStale && (
            <span className="flex items-center gap-1 rounded-md border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-2 py-0.5 text-[10px] font-medium text-[#d97706]">
              <AlertTriangle className="h-2.5 w-2.5" />
              Stale
            </span>
          )}
          <StatusPill status={sop.status} />
        </div>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-[17px] leading-snug font-semibold text-[#1d1d1f]">{sop.title}</h3>
        <p className="text-[13px] leading-relaxed text-[#6e6e73]">
          {sop.summary}
        </p>
      </div>

      <div className="rounded-lg border border-[#0284c7]/15 bg-[#0284c7]/[0.06] p-3">
        <p className="text-[10px] tracking-[0.12em] font-medium text-[#6e6e73] uppercase">
          Trigger condition
        </p>
        <code className="mt-1 block font-mono text-[12px] leading-relaxed break-words font-medium text-[#0369a1]">
          {sop.trigger}
        </code>
      </div>

      {sop.requiresHumanGate && (
        <p className="flex items-center gap-1.5 text-[11px] text-[#d97706] font-medium">
          <ShieldAlert className="h-3 w-3" /> Execution Gate: Human approval required before agent execution.
        </p>
      )}

      <div className="mt-auto flex gap-2 pt-1">
        <button
          type="button"
          onClick={onInspect}
          className="glass-button flex h-11 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-5 text-[13px] font-medium active:scale-95"
        >
          Inspect Steps
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        {sop.isStale && onConfirm ? (
          <button
            type="button"
            onClick={onConfirm}
            className="glass-button specular flex h-11 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-5 text-[13px] font-medium text-[#d97706] active:scale-95"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Confirm Current
          </button>
        ) : (
          <button
            type="button"
            onClick={onApprove}
            disabled={sop.status === "approved"}
            className="specular flex h-11 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-[#0071e3]/30 bg-[#0071e3] px-5 text-[13px] font-medium text-white shadow-[0_2px_10px_rgba(0,113,227,0.25)] transition-transform duration-200 hover:-translate-y-0.5 active:scale-95 disabled:pointer-events-none disabled:opacity-45"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Approve for MCP
          </button>
        )}
      </div>
    </article>
  );
}
