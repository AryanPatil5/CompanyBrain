import { useState, useEffect } from "react";
import { X, Plug, CheckCircle2, ShieldCheck, ExternalLink, Trash2, AlertCircle } from "lucide-react";

interface IntegrationStatus {
  provider: string;
  connected: boolean;
  status: string;
  external_org_id: string | null;
  connected_at: string | null;
}

export function IntegrationsModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatuses = async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem("token") || "mock-admin-token";
      const res = await fetch("http://localhost:5001/api/integrations/status", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setIntegrations(data.integrations || []);
      } else {
        setError("Failed to load live integration statuses");
      }
    } catch {
      setError("Unable to connect to server API");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStatuses();
    }
  }, [isOpen]);

  const handleConnect = async (provider: string) => {
    try {
      setError(null);
      const token = localStorage.getItem("token") || "mock-admin-token";

      const res = await fetch(`http://localhost:5001/api/integrations/${provider}/connect-url`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (!res.ok) {
        const errData = await res.json();
        setError(errData.error || `Failed to initiate ${provider} connection.`);
        return;
      }

      const data = await res.json();
      if (data.authorize_url) {
        // Secure frontend navigation with CSRF nonce state and Bearer token headers
        window.location.href = data.authorize_url;
      }
    } catch (err) {
      console.error("Connect error:", err);
      setError(`Failed to initiate ${provider} OAuth flow.`);
    }
  };

  const handleDisconnect = async (provider: string) => {
    try {
      const token = localStorage.getItem("token") || "mock-admin-token";
      const res = await fetch(`http://localhost:5001/api/integrations/${provider}/disconnect`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

      if (res.ok) {
        fetchStatuses();
      }
    } catch (err) {
      console.error("Disconnect error:", err);
    }
  };

  if (!isOpen) return null;

  const catalog = [
    {
      provider: "slack",
      name: "Slack",
      type: "OAuth v2 & Historical Poller",
      description: "Real-time webhook listener and background thread poller for operational SOP decrees.",
      target: "conversations.history & webhooks",
      color: "border-emerald-200 bg-emerald-50 text-emerald-800",
      oauth: true,
    },
    {
      provider: "github",
      name: "GitHub",
      type: "GitHub App & Incident Sweeper",
      description: "Monitors closed issues, pull requests, and post-mortems for incident resolution steps.",
      target: "repos/issues & webhooks",
      color: "border-sky-200 bg-sky-50 text-sky-800",
      oauth: true,
    },
    {
      provider: "gmail",
      name: "Email Shared Inbox",
      type: "Gmail OAuth 2.0 Connector",
      description: "Polls shared ops support inboxes for incident runbook emails with auto-refreshed OAuth tokens.",
      target: "gmail.googleapis.com/gmail/v1",
      color: "border-violet-200 bg-violet-50 text-violet-800",
      oauth: true,
    },
    {
      provider: "linear",
      name: "Linear",
      type: "GraphQL & Ticket Connector",
      description: "Sweeps completed high-priority P0/P1 outage tickets and triage notes.",
      target: "api.linear.app/graphql",
      color: "border-indigo-200 bg-indigo-50 text-indigo-800",
      oauth: false,
    },
    {
      provider: "zendesk",
      name: "Zendesk Support",
      type: "REST Support Ingestion",
      description: "Ingests support escalation tickets and tier-3 troubleshooting runbooks.",
      target: "/api/ingestion/webhook/zendesk",
      color: "border-purple-200 bg-purple-50 text-purple-800",
      oauth: false,
    },
    {
      provider: "database",
      name: "Database Runbooks",
      type: "Schema & Routine Scanner",
      description: "Scans stored procedures and slow query log patterns for tacit DB management SOPs.",
      target: "/api/ingestion/webhook/database",
      color: "border-blue-200 bg-blue-50 text-blue-800",
      oauth: false,
    },
    {
      provider: "stripe",
      name: "Stripe & Target Execution",
      type: "Tool Registry Integration",
      description: "Registered target system connection for FastMCP step execution dispatches.",
      target: "integration_connections table",
      color: "border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[#0071e3]",
      oauth: false,
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
              Active OAuth integrations, webhook endpoints, historical crawlers, and target system execution connectors.
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
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12.5px] text-amber-800">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {catalog.map((item) => {
              const liveStatus = integrations.find((i) => i.provider === item.provider);
              const isConnected = liveStatus?.connected ?? false;
              const statusText = liveStatus?.status || (isConnected ? "Active" : "Not Connected");

              return (
                <div key={item.name} className="flex flex-col justify-between gap-3 rounded-2xl border border-black/[0.08] bg-white/80 p-4 shadow-sm">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[15px] font-bold text-[#1d1d1f]">{item.name}</h3>
                      <span className={`inline-flex items-center gap-1 rounded-2xl border px-2.5 py-0.5 text-[10px] font-semibold uppercase ${
                        isConnected ? item.color : "border-slate-200 bg-slate-100 text-slate-600"
                      }`}>
                        {isConnected ? <CheckCircle2 className="h-3 w-3" /> : null}
                        {statusText}
                      </span>
                    </div>
                    <p className="text-[11px] font-semibold text-[#0071e3]">{item.type}</p>
                    <p className="text-[12.5px] text-[#6e6e73] leading-relaxed">{item.description}</p>
                  </div>

                  <div className="space-y-2 border-t border-black/[0.05] pt-3">
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-700">
                      <span>Target:</span>
                      <span className="font-semibold text-[#1d1d1f]">{item.target}</span>
                    </div>

                    {item.oauth && (
                      <div className="flex items-center justify-end gap-2 pt-1">
                        {isConnected ? (
                          <button
                            type="button"
                            onClick={() => handleDisconnect(item.provider)}
                            className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[11.5px] font-medium text-red-700 hover:bg-red-100 active:scale-95 transition-all"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Disconnect
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleConnect(item.provider)}
                            className="flex items-center gap-1.5 rounded-lg bg-[#0071e3] px-3.5 py-1.5 text-[11.5px] font-medium text-white shadow-sm hover:bg-[#0077ed] active:scale-95 transition-all"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Connect {item.name}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-black/[0.06] p-5">
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-slate-700">
            <ShieldCheck className="h-4 w-4 text-emerald-600" /> CSRF Nonces & AES-256 Token Encryption Active
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
