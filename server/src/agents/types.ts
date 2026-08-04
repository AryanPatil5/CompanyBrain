export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface PlanStep {
  id: string;
  step_number: number;
  action: string;
  target_system: string;
  tool_name: string;
  parameters: Record<string, any>;
  depends_on?: string[];
  risk_level?: RiskLevel;
  requires_human_gate?: boolean;
}

export interface ExecutionPlan {
  id: string;
  user_query: string;
  workspace_id: string;
  steps: PlanStep[];
  sop_id?: string;
  sop_title?: string;
  created_at: string;
}

export interface AuditResult {
  approved: boolean;
  requires_human_approval: boolean;
  risk_level: RiskLevel;
  flagged_reasons: string[];
  sop_id?: string;
  sop_title?: string;
}

export interface ExecutedStepResult {
  step_id: string;
  step_number: number;
  action: string;
  target_system: string;
  tool_name: string;
  outcome: 'success' | 'error' | 'skipped';
  http_status?: number;
  response_data?: any;
  error?: string;
}

export interface ExecutionResult {
  workflow_id: string;
  status: 'completed' | 'paused_approval' | 'failed';
  plan: ExecutionPlan;
  audit: AuditResult;
  executed_steps: ExecutedStepResult[];
  approval_id?: string;
  error?: string;
}

export interface WorkflowContext {
  workspaceId?: string;
  userId?: string;
  userRole?: string;
  trustRole?: 'low_trust' | 'high_trust' | 'admin' | string;
  mcpToken?: string;
  approvalId?: string;
}
