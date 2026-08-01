export type SopStatus = "draft" | "approved";
export type RiskLevel = "Low" | "Medium" | "High" | "Critical";

export interface SopStep {
  instruction: string;
  target: string;
  condition?: string;
  onFailure?: string;
  parameters?: Record<string, any>;
}

export interface Sop {
  id: string;
  title: string;
  category: string;
  status: SopStatus;
  trigger: string;
  summary: string;
  steps: SopStep[];
  version: number;
  lastConfirmedAt: string;
  isStale: boolean;
  riskLevel: RiskLevel;
  requiresHumanGate: boolean;
}

export interface PendingApproval {
  id: string;
  sop_id: string;
  agent_id: string;
  requested_by: string;
  risk_level: RiskLevel;
  status: "pending" | "approved" | "rejected";
  reason: string;
  created_at: string;
  skills_sops?: {
    title: string;
    category: string;
    trigger_condition: string;
  };
}

export interface Analytics {
  total_sops: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  by_risk: Record<string, number>;
  stale_count: number;
  pending_approvals_count: number;
  recent_executions: number;
  sources_ingested: Record<string, number>;
}

export interface SopVersion {
  id: string;
  version_number: number;
  changed_by: string;
  change_reason: string;
  created_at: string;
}

export const SOP_CATEGORIES = [
  "All",
  "Engineering",
  "Support",
  "Billing",
  "Operations",
  "Security",
] as const;

export const MOCK_SOPS: Sop[] = [
  {
    id: "sop-vip-rate-limit",
    title: "Enterprise VIP Rate Limit Override Protocol",
    category: "Engineering",
    status: "draft",
    trigger: "customer.tier == 'enterprise' AND api_429_count > 25 within 10m",
    summary:
      "Temporarily elevates API quota for enterprise tenants experiencing throttling during peak load windows.",
    steps: [
      {
        instruction:
          "Confirm the tenant's contract tier and current burst allowance in the accounts table.",
        target: "Postgres",
      },
      {
        instruction:
          "Raise the tenant rate-limit bucket to 3x baseline with a 4 hour expiry token.",
        target: "Admin CLI",
      },
      {
        instruction:
          "Annotate the subscription record so overage is not auto-billed for the override window.",
        target: "Stripe",
      },
      {
        instruction:
          "Post an override summary to #enterprise-ops and open a follow-up capacity ticket.",
        target: "Slack",
      },
    ],
    version: 1,
    lastConfirmedAt: new Date().toISOString(),
    isStale: false,
    riskLevel: "High",
    requiresHumanGate: true,
  },
];

function mapBackendSopToFrontend(raw: any): Sop {
  return {
    id: raw.id,
    title: raw.title,
    category: raw.category || "Engineering",
    status: (raw.status || "Draft").toLowerCase() as SopStatus,
    trigger: raw.trigger_condition || raw.trigger || "Manual Trigger",
    summary: raw.summary || raw.trigger_condition || "Extracted operational procedure.",
    steps: Array.isArray(raw.execution_steps)
      ? raw.execution_steps.map((step: any) => ({
          instruction: step.action || step.instruction || "",
          target: step.target_system || step.target || "System",
          condition: step.condition || undefined,
          onFailure: step.on_failure || undefined,
          parameters: step.parameters || undefined,
        }))
      : Array.isArray(raw.steps)
      ? raw.steps
      : [],
    version: raw.version || 1,
    lastConfirmedAt: raw.last_confirmed_at || new Date().toISOString(),
    isStale: raw.is_stale || false,
    riskLevel: (raw.risk_level || "Low") as RiskLevel,
    requiresHumanGate: raw.requires_human_gate || false,
  };
}

export async function fetchSops(): Promise<{ sops: Sop[]; live: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:5001/api/sops", {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

    const data = await res.json();
    const rawList = Array.isArray(data) ? data : data?.sops ?? [];

    if (!rawList.length) {
      return { sops: MOCK_SOPS, live: true };
    }

    const mappedList = rawList.map(mapBackendSopToFrontend);
    return { sops: mappedList, live: true };
  } catch (error) {
    console.warn("Express backend offline:", error);
    return { sops: MOCK_SOPS, live: false };
  }
}

export async function approveSopApi(id: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:5001/api/sops/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "Approved" }),
    });
    return res.ok;
  } catch (err) {
    console.error("Failed to persist approval:", err);
    return false;
  }
}

export async function confirmSopApi(id: string): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:5001/api/sops/${id}/confirm`, {
      method: "POST",
    });
    return res.ok;
  } catch (err) {
    console.error("Failed to confirm SOP:", err);
    return false;
  }
}

export async function fetchAnalytics(): Promise<Analytics | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("http://localhost:5001/api/sops/analytics", {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchVersions(sopId: string): Promise<SopVersion[]> {
  try {
    const res = await fetch(`http://localhost:5001/api/sops/${sopId}/versions`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.versions || [];
  } catch {
    return [];
  }
}

export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  try {
    const res = await fetch("http://localhost:5001/api/sops/approvals");
    if (!res.ok) return [];
    const data = await res.json();
    return data.approvals || [];
  } catch {
    return [];
  }
}

export async function resolveApprovalApi(approvalId: string, status: "approved" | "rejected"): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:5001/api/sops/approvals/${approvalId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function teachBrainApi(payload: {
  title: string;
  category: string;
  description: string;
  steps: string[];
  author?: string;
}): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:5001/api/ingestion/webhook/teach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace_id: "00000000-0000-0000-0000-000000000000",
        ...payload,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Teach Brain error:", err);
    return false;
  }
}