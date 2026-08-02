import { X, Network, Server, ShieldCheck, Activity, Terminal, ExternalLink } from "lucide-react";

export function FastMcpNetworkModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  const tools = [
    {
      name: "get_sop_by_id",
      description: "Retrieves approved SOP steps & rules for autonomous agent execution.",
      gating: "Blocks low-trust agents on High/Critical risk SOPs",
      badge: "Guardrail Enforced",
    },
    {
      name: "search_operational_sops",
      description: "Searches approved operational procedures by keyword or category.",
      gating: "Read query access",
      badge: "Public Skill",
    },
    {
      name: "get_sop_with_history",
      description: "Fetches SOP details alongside immutable version evolution snapshots.",
      gating: "Read audit access",
      badge: "Audit Log",
    },
    {
      name: "request_execution_approval",
      description: "Submits real-time human approval ticket to manager dashboard for high-risk SOPs.",
      gating: "Human-in-the-Loop Gate",
      badge: "Real-Time Ticket",
    },
    {
      name: "check_approval_status",
      description: "Checks resolution status of a pending manager approval request.",
      gating: "Ticket status polling",
      badge: "Status Query",
    },
    {
      name: "execute_sop_step",
      description: "Executes step against target systems (Stripe, GitHub, Postgres, Slack, Admin CLI) via tool registry.",
      gating: "Requires manager ticket approval for High/Critical risk SOPs",
      badge: "Execution Layer",
    },
    {
      name: "log_sop_execution",
      description: "Reports execution outcomes back to Company Brain observability logs.",
      gating: "Automated telemetry",
      badge: "Observability",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/25 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl duration-300 ease-out animate-in fade-in zoom-in-95 shadow-[0_16px_50px_rgba(0,0,0,0.1)]">
        <header className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[#0071e3]">
                <Network className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide text-[#0071e3] uppercase">
                Model Context Protocol Engine
              </span>
            </div>
            <h2 className="text-[21px] font-semibold tracking-tight text-[#1d1d1f]">FastMCP Agent Network</h2>
            <p className="text-[12.5px] text-[#6e6e73]">
              Exposing verified procedural skills to Claude, Cursor, and autonomous AI agents over FastMCP.
            </p>
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

        <div className="flex-1 space-y-5 overflow-y-auto p-6">
          {/* Server Connection Status Banner */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-green-200 bg-green-50/60 p-4 space-y-1">
              <div className="flex items-center gap-2 text-green-800 text-[12px] font-semibold">
                <Server className="h-4 w-4 text-green-600" /> FastMCP Server
              </div>
              <p className="text-[16px] font-bold text-green-900 font-mono">http://localhost:8080/mcp</p>
              <p className="text-[11px] text-green-700">Transport: HTTP Stream</p>
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 space-y-1">
              <div className="flex items-center gap-2 text-sky-800 text-[12px] font-semibold">
                <ShieldCheck className="h-4 w-4 text-sky-600" /> Human Gate
              </div>
              <p className="text-[16px] font-bold text-sky-900">Enforced</p>
              <p className="text-[11px] text-sky-700">High/Critical Risk Gated</p>
            </div>
            <div className="rounded-2xl border border-purple-200 bg-purple-50/60 p-4 space-y-1">
              <div className="flex items-center gap-2 text-purple-800 text-[12px] font-semibold">
                <Activity className="h-4 w-4 text-purple-600" /> Available Tools
              </div>
              <p className="text-[16px] font-bold text-purple-900">7 Active Tools</p>
              <p className="text-[11px] text-purple-700">FastMCP v2.5.0 Protocol</p>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-[11.5px] font-semibold text-[#6e6e73] uppercase">Exposed Agent Tool Capabilities ({tools.length})</h3>
            <div className="space-y-2.5">
              {tools.map((t) => (
                <div key={t.name} className="flex flex-col gap-1.5 rounded-2xl border border-black/[0.08] bg-white/80 p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Terminal className="h-4 w-4 text-[#0071e3]" />
                      <code className="font-mono text-[13.5px] font-bold text-[#1d1d1f]">{t.name}</code>
                    </div>
                    <span className="rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.08] px-2.5 py-0.5 font-mono text-[10px] font-semibold text-[#0071e3]">
                      {t.badge}
                    </span>
                  </div>
                  <p className="text-[13px] text-[#6e6e73]">{t.description}</p>
                  <p className="text-[11px] font-semibold text-slate-700">
                    Governance Constraint: <span className="font-medium text-[#1d1d1f]">{t.gating}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-black/[0.06] p-5">
          <a
            href="http://localhost:8080/mcp"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-[12.5px] font-semibold text-[#0071e3] hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open FastMCP Endpoint
          </a>
          <button
            type="button"
            onClick={onClose}
            className="glass-button flex h-11 items-center justify-center overflow-hidden rounded-lg px-6 text-[13px] font-medium active:scale-95"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
