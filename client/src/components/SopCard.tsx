import type { Sop, RiskLevel } from "@/lib/sops";
import {
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  History,
  ShieldAlert,
} from "lucide-react";

const CATEGORY_TINT: Record<string, string> = {
  Engineering: "text-sky-800 border-sky-200 bg-sky-50",
  Support: "text-indigo-800 border-indigo-200 bg-indigo-50",
  Billing: "text-violet-800 border-violet-200 bg-violet-50",
  Operations: "text-blue-800 border-blue-200 bg-blue-50",
  Security: "text-purple-800 border-purple-200 bg-purple-50",
};

const RISK_TINT: Record<RiskLevel, string> = {
  Low: "text-green-800 border-green-200 bg-green-50",
  Medium: "text-blue-800 border-blue-200 bg-blue-50",
  High: "text-amber-700 border-amber-200 bg-amber-50",
  Critical: "text-red-700 border-red-200 bg-red-50",
};

export function StatusPill({ status }: { status: Sop["status"] }) {
  const approved = status === "approved";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-[11px] font-semibold tracking-wide backdrop-blur-xl",
        approved
          ? "border-green-200 bg-green-50 text-green-800"
          : "border-amber-200 bg-amber-50 text-amber-800",
      ].join(" ")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${approved ? "bg-green-600" : "bg-amber-600"}`}
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
    <article className="glass-card glass-card-hover flex flex-col gap-4 rounded-2xl p-5 overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={[
              "rounded-2xl border px-2.5 py-1 text-[11px] font-semibold tracking-wide backdrop-blur-xl",
              CATEGORY_TINT[sop.category] ??
                "text-indigo-800 border-indigo-200 bg-indigo-50",
            ].join(" ")}
          >
            {sop.category}
          </span>
          <span
            className={[
              "flex items-center gap-1 rounded-2xl border px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase",
              RISK_TINT[sop.riskLevel || "Low"],
            ].join(" ")}
          >
            {sop.requiresHumanGate && <ShieldAlert className="h-2.5 w-2.5" />}
            {sop.riskLevel || "Low"} Risk
          </span>
          {sop.version > 1 && (
            <span className="flex items-center gap-1 rounded-2xl border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 text-[10px] font-semibold text-slate-700">
              <History className="h-2.5 w-2.5" />v{sop.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {sop.isStale && (
            <span className="flex items-center gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              <AlertTriangle className="h-2.5 w-2.5" />
              Stale
            </span>
          )}
          <StatusPill status={sop.status} />
        </div>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-[17px] leading-snug font-semibold text-[#1d1d1f]">
          {sop.title}
        </h3>
        <p className="text-[13px] leading-relaxed text-[#6e6e73]">
          {sop.summary}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
        <p className="text-[10px] tracking-[0.12em] font-semibold text-slate-500 uppercase">
          Trigger condition
        </p>
        <code className="mt-1 block font-mono text-[12px] leading-relaxed break-words font-semibold text-slate-800">
          {sop.trigger}
        </code>
      </div>

      {sop.requiresHumanGate && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-800 font-semibold">
          <ShieldAlert className="h-3 w-3" /> Execution Gate: Human approval
          required before agent execution.
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
            className="glass-button specular flex h-11 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-lg px-5 text-[13px] font-medium text-amber-800 active:scale-95"
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
