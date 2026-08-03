import { API_BASE_URL } from '../lib/api-config';
import { getToken } from '../lib/sops';

const DEFAULT_HEADERS = () => ({
  'Authorization': `Bearer ${getToken()}`,
  'Content-Type': 'application/json',
  'ngrok-skip-browser-warning': 'true',
});

export interface IngestionRunResponse {
  success: boolean;
  jobId: string;
  status: string;
}

export interface IngestionJobStatusResponse {
  jobId: string;
  name: string;
  status: string;
  progress: number;
  failedReason?: string;
  returnvalue?: any;
}

export interface HybridSearchResultItem {
  id: string;
  title: string;
  trigger_condition: string;
  category: string;
  risk_level: string;
  requires_human_gate: boolean;
  similarity: number;
  rrfScore: number;
  denseRank: number | null;
  sparseRank: number | null;
}

export interface AgentWorkflowResponse {
  workflow_id: string;
  status: 'completed' | 'paused_approval' | 'failed';
  plan?: {
    id: string;
    sop_title?: string;
    steps: Array<{
      id: string;
      step_number: number;
      action: string;
      target_system: string;
      risk_level?: string;
    }>;
  };
  audit?: {
    approved: boolean;
    requires_human_approval: boolean;
    risk_level: string;
    flagged_reasons: string[];
  };
  executed_steps?: Array<{
    step_id: string;
    action: string;
    target_system: string;
    outcome: string;
  }>;
  approval_id?: string;
  error?: string;
}

export interface GraphDataResponse {
  success: boolean;
  nodes: Array<{
    id: string;
    label: string;
    name: string;
    properties?: Record<string, any>;
  }>;
  edges: Array<{
    id: string;
    source_id: string;
    target_id: string;
    edge_type: string;
  }>;
}

/**
 * Trigger an asynchronous knowledge ingestion crawler run in BullMQ queue.
 */
export async function triggerIngestion(
  jobName: string = 'all',
  payload: Record<string, any> = {}
): Promise<IngestionRunResponse> {
  const res = await fetch(`${API_BASE_URL}/api/ingestion/run`, {
    method: 'POST',
    headers: DEFAULT_HEADERS(),
    body: JSON.stringify({ job_name: jobName, ...payload }),
  });

  if (!res.ok) {
    throw new Error(`Failed to queue ingestion job (${res.status})`);
  }

  return await res.json();
}

/**
 * Poll ingestion job progress status from BullMQ.
 */
export async function getIngestionJobStatus(jobId: string): Promise<IngestionJobStatusResponse> {
  const res = await fetch(`${API_BASE_URL}/api/ingestion/jobs/${jobId}`, {
    headers: DEFAULT_HEADERS(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch job status (${res.status})`);
  }

  return await res.json();
}

/**
 * Execute Reciprocal Rank Fusion (RRF) Hybrid Search combining pgvector dense + Postgres sparse keyword matching.
 */
export async function searchHybrid(query: string): Promise<HybridSearchResultItem[]> {
  if (!query.trim()) return [];

  const res = await fetch(`${API_BASE_URL}/api/sops/search?q=${encodeURIComponent(query)}`, {
    headers: DEFAULT_HEADERS(),
  });

  if (!res.ok) {
    throw new Error(`Hybrid search failed (${res.status})`);
  }

  const data = await res.json();
  return data.results || [];
}

/**
 * Execute Multi-Agent Orchestration workflow (Planner -> Auditor -> Executor).
 */
export async function runAgentWorkflow(
  query: string,
  approvalId?: string
): Promise<AgentWorkflowResponse> {
  const res = await fetch(`${API_BASE_URL}/api/sops/workflow`, {
    method: 'POST',
    headers: DEFAULT_HEADERS(),
    body: JSON.stringify({ query, approval_id: approvalId }),
  });

  if (!res.ok) {
    throw new Error(`Agent workflow execution failed (${res.status})`);
  }

  return await res.json();
}

/**
 * Fetch Apache AGE Enterprise Knowledge Graph nodes and edges.
 */
export async function getGraphEntities(): Promise<GraphDataResponse> {
  const res = await fetch(`${API_BASE_URL}/api/sops/graph`, {
    headers: DEFAULT_HEADERS(),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch graph data (${res.status})`);
  }

  return await res.json();
}
