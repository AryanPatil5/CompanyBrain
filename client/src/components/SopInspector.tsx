import { useEffect, useState } from "react";
import {
  X,
  ShieldCheck,
  AlertTriangle,
  History,
  Clock,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Sparkles,
  RefreshCw,
  HelpCircle,
  AlertCircle,
} from "lucide-react";
import type { Sop, SopVersion, RiskLevel } from "@/lib/sops";
import { fetchVersions, elicitSopQuestionsApi } from "@/lib/sops";
import { StatusPill } from "./SopCard";

const RISK_TINT: Record<RiskLevel, string> = {
  Low: "text-green-800 border-green-200 bg-green-50",
  Medium: "text-blue-800 border-blue-200 bg-blue-50",
  High: "text-amber-700 border-amber-200 bg-amber-50",
  Critical: "text-red-700 border-red-200 bg-red-50",
};

const CATEGORY_TINT: Record<string, string> = {
  Engineering: "text-sky-800 border-sky-200 bg-sky-50",
  Support: "text-indigo-800 border-indigo-200 bg-indigo-50",
  Billing: "text-violet-800 border-violet-200 bg-violet-50",
  Operations: "text-blue-800 border-blue-200 bg-blue-50",
  Security: "text-purple-800 border-purple-200 bg-purple-50",
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
  const [interviewLoading, setInterviewLoading] = useState(false);
  const [interviewQuestions, setInterviewQuestions] = useState<string[]>([]);
  const [interviewError, setInterviewError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (sop) {
      void fetchVersions(sop.id).then(setVersions);
      setInterviewQuestions([]);
      setInterviewError(null);
    } else {
      setVersions([]);
      setShowVersions(false);
      setInterviewQuestions([]);
      setInterviewError(null);
    }
  }, [sop?.id]);

  if (!sop) return null;

  const handleRunInterview = async () => {
    setInterviewLoading(true);
    setInterviewError(null);

    const res = await elicitSopQuestionsApi({
      title: sop.title,
      category: sop.category,
      trigger: sop.trigger,
      steps: sop.steps,
    });

    setInterviewLoading(false);

    if (res.success && res.questions.length > 0) {
      setInterviewQuestions(res.questions);
    } else {
      setInterviewError(
        res.error ||
          "Unable to generate interview questions for this SOP draft. Please try again or fill in the missing fields manually.",
      );
    }
  };

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
      <div className="glass-panel relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl duration-300 ease-out animate-in fade-in zoom-in-95">
        <header className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6">
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-2xl border px-2.5 py-1 text-[11px] font-semibold tracking-wide backdrop-blur-xl ${CATEGORY_TINT[sop.category] ?? "text-indigo-800 border-indigo-200 bg-indigo-50"}`}
              >
                {sop.category}
              </span>
              <span
                className={`flex items-center gap-1 rounded-2xl border px-2.5 py-1 text-[11px] font-semibold uppercase ${RISK_TINT[sop.riskLevel || "Low"]}`}
              >
                {sop.requiresHumanGate && <ShieldAlert className="h-3 w-3" />}
                {sop.riskLevel || "Low"} Risk
              </span>
              <StatusPill status={sop.status} />
              {sop.isStale && (
                <span className="flex items-center gap-1 rounded-2xl border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                  <AlertTriangle className="h-2.5 w-2.5" />
                  Stale
                </span>
              )}
              {sop.version > 1 && (
                <span className="flex items-center gap-1 rounded-2xl border border-black/[0.08] bg-black/[0.03] px-2 py-0.5 text-[10px] font-semibold text-slate-700">
                  <History className="h-2.5 w-2.5" />v{sop.version}
                </span>
              )}
            </div>
            <h2 className="text-[21px] leading-snug font-semibold text-[#1d1d1f]">
              {sop.title}
            </h2>
            <code className="block font-mono text-[12px] font-semibold text-slate-800 bg-slate-50 border border-slate-200 rounded-2xl p-2.5">
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

        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <div className="space-y-2">
            <h3 className="text-[11px] font-semibold text-[#6e6e73] uppercase">
              Summary
            </h3>
            <p className="text-[13.5px] leading-relaxed text-[#1d1d1f]">
              {sop.summary}
            </p>
          </div>

          {/* Interactive Elicitation Section */}
          <div className="rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.03] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-[#0071e3]" />
                <span className="text-[13px] font-semibold text-[#1d1d1f]">
                  AI Elicitation Interview
                </span>
              </div>
              <button
                type="button"
                onClick={handleRunInterview}
                disabled={interviewLoading}
                className="flex items-center gap-1.5 rounded-lg border border-[#0071e3]/30 bg-white px-3 py-1.5 text-[12px] font-semibold text-[#0071e3] shadow-sm hover:bg-[#0071e3]/[0.05] active:scale-95 disabled:opacity-50"
              >
                {interviewLoading ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Analyzing Edge Cases...
                  </>
                ) : (
                  <>
                    <HelpCircle className="h-3.5 w-3.5" />
                    Run Interview
                  </>
                )}
              </button>
            </div>

            {/* Error Alert Toast Panel */}
            {interviewError && (
              <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-red-800 animate-in fade-in">
                <div className="flex items-start gap-2 text-[12.5px]">
                  <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                  <p className="font-medium">{interviewError}</p>
                </div>
                <button
                  type="button"
                  onClick={handleRunInterview}
                  className="flex items-center gap-1 shrink-0 rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700 active:scale-95"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry
                </button>
              </div>
            )}

            {/* Questions Panel */}
            {interviewQuestions.length > 0 && (
              <div className="space-y-2 pt-1 animate-in fade-in">
                <p className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">
                  Clarifying Edge Cases ({interviewQuestions.length}):
                </p>
                <div className="space-y-2">
                  {interviewQuestions.map((q, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2.5 rounded-xl border border-black/10 bg-white/90 p-3 text-[12.5px] text-[#1d1d1f] shadow-sm"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#0071e3] text-white text-[10px] font-bold">
                        {idx + 1}
                      </span>
                      <p className="leading-snug font-medium">{q}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <h3 className="text-[11px] font-semibold text-[#6e6e73] uppercase">
              Execution Steps ({sop.steps.length})
            </h3>
            <div className="space-y-2.5">
              {sop.steps.map((step, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-3 rounded-2xl border border-black/[0.08] bg-white/70 p-3.5 shadow-sm"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[11px] font-bold text-[#0071e3]">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-[13px] font-medium text-[#1d1d1f]">
                      {step.instruction}
                    </p>
                    <span className="inline-block rounded-2xl border border-black/[0.06] bg-black/[0.03] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#6e6e73]">
                      Target: {step.target}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {versions.length > 0 && (
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowVersions(!showVersions)}
                className="flex w-full items-center gap-2 rounded-lg border border-black/[0.06] bg-black/[0.02] px-4 py-3 text-left text-[12px] font-semibold text-[#6e6e73] transition-colors hover:bg-black/[0.05] active:scale-95"
              >
                <History className="h-3.5 w-3.5" />
                Version Audit History ({versions.length})
                {showVersions ? (
                  <ChevronUp className="ml-auto h-3 w-3" />
                ) : (
                  <ChevronDown className="ml-auto h-3 w-3" />
                )}
              </button>
              {showVersions && (
                <div className="mt-2 space-y-1.5 pl-2">
                  {versions.map((v) => (
                    <div
                      key={v.id}
                      className="flex items-center gap-3 rounded-2xl border border-black/[0.06] bg-white/50 px-3 py-2"
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-2xl border border-black/[0.08] bg-white font-mono text-[10px] font-semibold text-[#1d1d1f]">
                        {v.version_number}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-[#1d1d1f]">
                          {REASON_LABELS[v.change_reason] || v.change_reason}
                        </p>
                        <p className="flex items-center gap-1.5 text-[10px] text-[#6e6e73]">
                          <Clock className="h-2.5 w-2.5" />
                          {new Date(v.created_at).toLocaleString()} ·{" "}
                          {v.changed_by}
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
              className="glass-button flex h-11 items-center gap-2 overflow-hidden rounded-lg px-6 text-[13px] font-medium text-amber-800 active:scale-95"
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
