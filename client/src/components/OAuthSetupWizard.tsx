import { useState } from "react";
import { X, KeyRound, Copy, Check, ExternalLink, ShieldCheck, ArrowRight } from "lucide-react";
import { API_BASE_URL } from "../lib/api-config";

interface OAuthSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  initialProvider?: "slack" | "github" | "gmail";
  onSuccess?: () => void;
}

export function OAuthSetupWizard({
  isOpen,
  onClose,
  initialProvider = "slack",
  onSuccess,
}: OAuthSetupWizardProps) {
  const [activeTab, setActiveTab] = useState<"slack" | "github" | "gmail">(initialProvider);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  if (!isOpen) return null;

  const appBaseUrl = API_BASE_URL;

  const getCallbackUrl = () => {
    if (activeTab === "slack") return `${appBaseUrl}/api/integrations/slack/callback`;
    if (activeTab === "github") return `${appBaseUrl}/api/integrations/github/callback`;
    return `${appBaseUrl}/api/integrations/gmail/callback`;
  };

  const copyCallbackUrl = () => {
    navigator.clipboard.writeText(getCallbackUrl());
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);

    try {
      const token = localStorage.getItem("token") || "mock-admin-token";
      const res = await fetch(`${API_BASE_URL}/api/integrations/platform-config/${activeTab}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          extra_config: activeTab === "github" ? { app_name: clientId } : {},
        }),
      });

      if (res.ok) {
        setStatusMsg({ type: "success", text: `Successfully saved ${activeTab.toUpperCase()} OAuth App configuration!` });
        setClientId("");
        setClientSecret("");
        if (onSuccess) onSuccess();
      } else {
        const errData = await res.json();
        setStatusMsg({ type: "error", text: errData.error || "Failed to save configuration." });
      }
    } catch {
      setStatusMsg({ type: "error", text: "Network error connecting to backend API." });
    } finally {
      setSaving(false);
    }
  };

  const instructions = {
    slack: {
      title: "Slack App Setup",
      docLink: "https://api.slack.com/apps",
      steps: [
        "Create a Slack App at api.slack.com/apps",
        "Go to OAuth & Permissions -> Add Redirect URL below",
        "Under Bot Token Scopes, add: channels:history, channels:read, chat:write",
        "Copy Client ID & Client Secret below",
      ],
      idLabel: "Slack Client ID",
      secretLabel: "Slack Client Secret",
    },
    github: {
      title: "GitHub App Setup",
      docLink: "https://github.com/settings/apps",
      steps: [
        "Create a GitHub App at Settings -> Developer settings -> GitHub Apps",
        `Set Webhook URL to ${API_BASE_URL}/api/ingestion/webhook/github`,
        "Set Callback URL below",
        "Copy GitHub App Slug Name below",
      ],
      idLabel: "GitHub App Slug Name",
      secretLabel: "GitHub Webhook Secret (Optional)",
    },
    gmail: {
      title: "Gmail OAuth Setup",
      docLink: "https://console.cloud.google.com/apis/credentials",
      steps: [
        "Open Google Cloud Console -> APIs & Services -> Credentials",
        "Create OAuth 2.0 Client ID (Web application)",
        "Add Authorized Redirect URI below",
        "Enable the Gmail API in your Google Cloud project",
      ],
      idLabel: "Google Client ID",
      secretLabel: "Google Client Secret",
    },
  };

  const currentInst = instructions[activeTab];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div
        onClick={onClose}
        className="absolute inset-0 bg-black/30 backdrop-blur-md duration-300 animate-in fade-in"
      />
      <div className="glass-panel relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl duration-300 ease-out animate-in fade-in zoom-in-95 shadow-[0_20px_60px_rgba(0,0,0,0.15)]">
        <header className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-2xl border border-[#0071e3]/20 bg-[#0071e3]/[0.08] text-[#0071e3]">
                <KeyRound className="h-3.5 w-3.5" />
              </span>
              <span className="text-[11px] font-semibold tracking-wide text-[#0071e3] uppercase">
                OAuth Platform Setup Wizard
              </span>
            </div>
            <h2 className="text-[20px] font-semibold tracking-tight text-[#1d1d1f]">Configure OAuth App Credentials</h2>
            <p className="text-[12.5px] text-[#6e6e73]">
              Set platform-level OAuth credentials for Slack, GitHub, or Gmail directly in the UI.
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

        {/* Tab Selection */}
        <div className="flex border-b border-black/[0.06] bg-slate-50/50 px-6 pt-3">
          {(["slack", "github", "gmail"] as const).map((provider) => (
            <button
              key={provider}
              type="button"
              onClick={() => {
                setActiveTab(provider);
                setStatusMsg(null);
              }}
              className={`mr-4 border-b-2 pb-3 text-[13px] font-semibold transition-all capitalize ${
                activeTab === provider
                  ? "border-[#0071e3] text-[#0071e3]"
                  : "border-transparent text-slate-500 hover:text-slate-800"
              }`}
            >
              {provider} App Setup
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {statusMsg && (
            <div
              className={`rounded-xl border p-3.5 text-[12.5px] font-medium ${
                statusMsg.type === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              {statusMsg.text}
            </div>
          )}

          {/* Guide Steps */}
          <div className="rounded-2xl border border-black/[0.08] bg-slate-50/80 p-4 space-y-2.5">
            <div className="flex items-center justify-between">
              <h4 className="text-[13px] font-bold text-[#1d1d1f]">{currentInst.title}</h4>
              <a
                href={currentInst.docLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[#0071e3] hover:underline"
              >
                Open Developer Console <ExternalLink className="h-3 w-3" />
              </a>
            </div>

            <ol className="space-y-1.5 pl-4 list-decimal text-[12px] text-slate-600">
              {currentInst.steps.map((step, idx) => (
                <li key={idx}>{step}</li>
              ))}
            </ol>

            <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-black/[0.06] bg-white p-2.5">
              <div className="space-y-0.5 overflow-hidden">
                <span className="text-[10px] font-semibold text-slate-600 uppercase">Authorized Redirect Callback URL:</span>
                <p className="truncate text-[11.5px] font-mono text-slate-800">{getCallbackUrl()}</p>
              </div>
              <button
                type="button"
                onClick={copyCallbackUrl}
                className="flex items-center gap-1 shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 active:scale-95"
              >
                {copiedUrl ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                {copiedUrl ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          {/* Form Inputs */}
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[12px] font-semibold text-[#1d1d1f]">{currentInst.idLabel}</label>
              <input
                type="text"
                required
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={`Paste ${currentInst.idLabel}...`}
                className="w-full rounded-xl border border-black/[0.12] bg-white px-3.5 py-2 text-[13px] text-[#1d1d1f] placeholder:text-slate-400 focus:border-[#0071e3] focus:outline-none"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[12px] font-semibold text-[#1d1d1f]">{currentInst.secretLabel}</label>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={`Paste ${currentInst.secretLabel}...`}
                className="w-full rounded-xl border border-black/[0.12] bg-white px-3.5 py-2 text-[13px] text-[#1d1d1f] placeholder:text-slate-400 focus:border-[#0071e3] focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-1.5 rounded-xl bg-[#0071e3] px-5 py-2 text-[12.5px] font-medium text-white shadow-sm hover:bg-[#0077ed] active:scale-95 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Credentials"} <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </form>
        </div>

        <footer className="flex items-center justify-between border-t border-black/[0.06] p-4 bg-slate-50/50 text-[11.5px] text-slate-500">
          <p className="flex items-center gap-1">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Client Secrets Encrypted via AES-256-GCM at Rest
          </p>
        </footer>
      </div>
    </div>
  );
}
