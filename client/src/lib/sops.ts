import { API_BASE_URL } from "./api-config";

export const SOP_CATEGORIES = ["All", "Database", "Infrastructure", "Security", "Billing", "Engineering", "General"] as const;

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

export interface SopVersion {
  id: string;
  sop_id: string;
  version_number: number;
  changed_by: string;
  change_reason: string;
  created_at: string;
}

export interface PendingApproval {
  id: string;
  sop_id: string;
  step_index: number;
  target_system: string;
  requested_by: string;
  parameters: Record<string, any>;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  sop_title?: string;
}

export interface Analytics {
  total_sops: number;
  stale_sops: number;
  executions_today: number;
  failed_ingestions: number;
}

// Fallback mock SOPs used only if backend is completely unreachable
export const MOCK_SOPS: Sop[] = [
  {
    id: "sop_01",
    title: "Primary DB Slow Query Triage",
    category: "Database",
    status: "approved",
    trigger: "P99 DB latency > 500ms for 3 consecutive minutes",
    summary: "Identifies blocking queries, cancels orphaned transactions, and scales read-replicas if CPU exceeds 90%.",
    steps: [
      { instruction: "Check active long-running queries via pg_stat_activity", target: "PostgreSQL Primary" },
      { instruction: "Terminate queries executing for > 300s without lock", target: "PostgreSQL Primary" },
      { instruction: "Notify #ops-db-alerts with terminated PID details", target: "Slack" }
    ],
    version: 3,
    lastConfirmedAt: "2026-03-28",
    isStale: false,
    riskLevel: "High",
    requiresHumanGate: true,
  },
  {
    id: "sop_02",
    title: "Staging Redis Cache Flush & Warmup",
    category: "Infrastructure",
    status: "approved",
    trigger: "Staging cache inconsistency error rate > 5%",
    summary: "Flushes key pattern 'session:*' and triggers the background catalog warmup job.",
    steps: [
      { instruction: "Flush matching key pattern in staging Redis node", target: "Redis Staging" },
      { instruction: "Invoke /api/admin/warmup-cache endpoint", target: "Internal API" }
    ],
    version: 1,
    lastConfirmedAt: "2026-02-15",
    isStale: true,
    riskLevel: "Medium",
    requiresHumanGate: false,
  },
  {
    id: "sop_03",
    title: "Emergency Tenant Rate Limit Elevation",
    category: "Security",
    status: "draft",
    trigger: "DDoS heuristic flag or HTTP 429 spike > 10,000 req/min",
    summary: "Elevates Cloudflare WAF rate-limiting tier to strict mode for affected workspace.",
    steps: [
      { instruction: "Apply high-security rate-limit rule to tenant zone", target: "Cloudflare WAF" },
      { instruction: "Issue temporary API token with reduced quota", target: "Auth Service" }
    ],
    version: 2,
    lastConfirmedAt: "2026-03-20",
    isStale: false,
    riskLevel: "Critical",
    requiresHumanGate: true,
  }
];

export function getToken(): string {
  try {
    const token = typeof window !== 'undefined' ? localStorage.getItem("auth_token") : null;
    if (!token || token === "null" || token === "undefined") {
      return "mock-admin-token";
    }
    return token;
  } catch {
    return "mock-admin-token";
  }
}

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
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${API_BASE_URL}/api/sops`, {
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
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
    const res = await fetch(`${API_BASE_URL}/api/sops/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
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
    const res = await fetch(`${API_BASE_URL}/api/sops/${id}/confirm`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
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
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${API_BASE_URL}/api/sops/analytics`, {
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
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
    const res = await fetch(`${API_BASE_URL}/api/sops/${sopId}/versions`, {
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.versions || [];
  } catch {
    return [];
  }
}

export async function fetchPendingApprovals(): Promise<PendingApproval[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sops/approvals`, {
      headers: {
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.approvals || [];
  } catch {
    return [];
  }
}

export async function resolveApprovalApi(approvalId: string, status: "approved" | "rejected"): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/sops/approvals/${approvalId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
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
    const res = await fetch(`${API_BASE_URL}/api/ingestion/webhook/teach`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({
        ...payload,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Teach Brain error:", err);
    return false;
  }
}

export interface ElicitationResponse {
  success: boolean;
  questions: string[];
  error?: string;
}

export async function elicitSopQuestionsApi(sopDraft: Partial<Sop>): Promise<ElicitationResponse> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/ingestion/interview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getToken()}`,
        "ngrok-skip-browser-warning": "true",
      },
      body: JSON.stringify({ sop: sopDraft }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      return {
        success: false,
        questions: [],
        error: data.error || "Unable to generate interview questions for this SOP draft. Please try again or fill in the missing fields manually.",
      };
    }

    return {
      success: true,
      questions: data.questions || [],
    };
  } catch (err) {
    return {
      success: false,
      questions: [],
      error: "Network error connecting to backend API.",
    };
  }
}