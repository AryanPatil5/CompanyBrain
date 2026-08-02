import { X, Plug, CheckCircle2, ShieldCheck } from "lucide-react";

export function IntegrationsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  const integrations = [
    {
      name: "Slack",
      type: "Webhook & Historical Crawler",
      status: "Active",
      description: "Real-time webhook listener and background historical thread poller for operational SOP decrees.",
      target: "conversations.history & webhooks",
      color: "border-emerald-200 bg-emerald-50 text-emerald-800",
    },
    {
      name: "GitHub",
      type: "Webhook & Incident Sweeper",
      status: "Active",
      description: "Monitors closed issues, pull requests, and post-mortems for incident resolution steps.",
      target: "repos/issues & webhooks",
      color: "border-sky-200 bg-sky-50 text-sky-800",
    },
    {
      name: "Linear",
      type: "GraphQL & Ticket Connector",
      status: "Active",
      description: "Sweeps completed high-priority P0/P1 outage tickets and triage notes.",
      target: "api.linear.app/graphql",
      color: "border-indigo-200 bg-indigo-50 text-indigo-800",
    },
    {
      name: "Zendesk Support",
      type: "REST Support Ingestion",
      status: "Active",
      description: "Ingests support escalation tickets and tier-3 troubleshooting runbooks.",
      target: "/api/ingestion/webhook/zendesk",
      color: "border-purple-200 bg-purple-50 text-purple-800",
    },
    {
      name: "Email Shared Inbox",
      type: "Gmail & MS Graph Connector",
      status: "Active",
      description: "Polls shared ops support inboxes for incident runbook emails.",
      target: "/api/ingestion/webhook/email",
      color: "border-violet-200 bg-violet-50 text-violet-800",
    },
    {
      name: "Database Runbooks",
      type: "Schema & Routine Scanner",
      status: "Active",
      description: "Scans stored procedures and slow query log patterns for tacit DB management SOPs.",
      target: "/api/ingestion/webhook/database",
      color: "border-blue-200 bg-blue-50 text-blue-800",
    },
    {
      name: "Stripe & Target Execution",
      type: "Tool Registry Integration",
      status: "Active",
      description: "Registered target system connection for FastMCP step execution dispatches.",
      target: "integration_connections table",
      color: "border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[#0071e3]",
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
                <Plug className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide text-[#0071e3] uppercase">
                Multi-Source Knowledge Pipeline
              </span>
            </div>
            <h2 className="text-[21px] font-semibold tracking-tight text-[#1d1d1f]">Connected Target Integrations</h2>
            <p className="text-[12.5px] text-[#6e6e73]">
              Active webhook endpoints, historical crawlers, and target system execution connectors.
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

        <div className="flex-1 space-y-4 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {integrations.map((item) => (
              <div key={item.name} className="flex flex-col justify-between gap-2.5 rounded-2xl border border-black/[0.08] bg-white/80 p-4 shadow-sm">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[15px] font-bold text-[#1d1d1f]">{item.name}</h3>
                    <span className={`inline-flex items-center gap-1 rounded-2xl border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${item.color}`}>
                      <CheckCircle2 className="h-3 w-3" /> {item.status}
                    </span>
                  </div>
                  <p className="text-[11px] font-semibold text-[#0071e3]">{item.type}</p>
                  <p className="text-[12.5px] text-[#6e6e73] leading-relaxed">{item.description}</p>
                </div>
                <div className="flex items-center justify-between border-t border-black/[0.05] pt-2 text-[11px] font-mono text-slate-700">
                  <span>Target:</span>
                  <span className="font-semibold text-[#1d1d1f]">{item.target}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-black/[0.06] p-5">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-700">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> HMAC Signatures & RBAC Protection Active
          </p>
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
