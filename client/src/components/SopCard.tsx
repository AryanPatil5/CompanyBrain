import type { Sop } from "@/lib/sops";
import { ChevronRight, ShieldCheck, AlertTriangle, History } from "lucide-react";

const CATEGORY_TINT: Record<string, string> = {
  Engineering: "text-cyan border-cyan/30 bg-cyan/10",
  Support: "text-indigo border-indigo/30 bg-indigo/10",
  Billing: "text-violet border-violet/30 bg-violet/10",
  Operations: "text-cyan border-cyan/25 bg-cyan/[0.07]",
  Security: "text-violet border-violet/30 bg-violet/10",
};

export function StatusPill({ status }: { status: Sop["status"] }) {
  const approved = status === "approved";
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide backdrop-blur-xl",
        approved
          ? "border-emerald/30 bg-emerald/10 text-emerald"
          : "border-amber/30 bg-amber/10 text-amber",
      ].join(" ")}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${approved ? "bg-emerald shadow-[0_0_8px_2px_var(--emerald)]" : "bg-amber shadow-[0_0_8px_2px_var(--amber)]"}`}
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
    <article className="glass-card glass-card-hover flex flex-col gap-4 rounded-3xl p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={[
              "rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-wide backdrop-blur-xl",
              CATEGORY_TINT[sop.category] ?? "text-indigo border-indigo/30 bg-indigo/10",
            ].join(" ")}
          >
            {sop.category}
          </span>
          {sop.version > 1 && (
            <span className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <History className="h-2.5 w-2.5" />
              v{sop.version}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {sop.isStale && (
            <span className="flex items-center gap-1 rounded-full border border-amber/30 bg-amber/10 px-2 py-0.5 text-[10px] font-medium text-amber">
              <AlertTriangle className="h-2.5 w-2.5" />
              Stale
            </span>
          )}
          <StatusPill status={sop.status} />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-[17px] leading-snug font-semibold">{sop.title}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {sop.summary}
        </p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-black/25 p-3">
        <p className="text-[10.5px] tracking-[0.12em] text-muted-foreground uppercase">
          Trigger condition
        </p>
        <code className="mt-1.5 block font-mono text-[12px] leading-relaxed break-words text-cyan">
          {sop.trigger}
        </code>
      </div>

      <div className="mt-auto flex gap-2 pt-1">
        <button
          type="button"
          onClick={onInspect}
          className="glass-button flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium"
        >
          Inspect Steps
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        {sop.isStale && onConfirm ? (
          <button
            type="button"
            onClick={onConfirm}
            className="glass-button specular flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-amber"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Confirm Current
          </button>
        ) : (
          <button
            type="button"
            onClick={onApprove}
            disabled={sop.status === "approved"}
            className="glass-button specular flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-45"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Approve for MCP
          </button>
        )}
      </div>
    </article>
  );
}
