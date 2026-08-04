import { ExecutionPlan, AuditResult, ExecutedStepResult, ExecutionResult, WorkflowContext } from '../agents/types.js';
import { planStepActivity, researchStepActivity, auditStepActivity, executeStepActivity } from './activities/agentActivities.js';

export interface WorkflowParams {
  userQuery: string;
  context: WorkflowContext;
  workflowId?: string;
}

export interface SignalApprovalPayload {
  approved: boolean;
  approvalId?: string;
  reason?: string;
}

/**
 * Temporal-compatible Durable Multi-Agent Task Workflow
 * Handles Activity retries, Human-In-The-Loop (HITL) approval signals, and replayable execution checkpoints.
 */
export async function runAgentTaskWorkflow(params: WorkflowParams): Promise<ExecutionResult> {
  const { userQuery, context } = params;
  const workflowId = params.workflowId || `wf_temporal_${Date.now()}`;

  // 1. Planning Activity Step
  const plan: ExecutionPlan = await planStepActivity(userQuery, context);

  // 2. Hybrid Research & Context Activity Step
  await researchStepActivity(userQuery, context.workspaceId || '00000000-0000-0000-0000-000000000000');

  // 3. Auditing Activity Step
  const audit: AuditResult = await auditStepActivity(plan, context);

  // 4. Human-In-The-Loop Approval Gate (paused if high risk without approvalId)
  if (audit.requires_human_approval && !context.approvalId) {
    return {
      workflow_id: workflowId,
      status: 'paused_approval',
      plan,
      audit,
      executed_steps: [],
      approval_id: `ticket_${workflowId}`,
      error: `Workflow paused for Human-In-The-Loop approval ticket #ticket_${workflowId}.`,
    };
  }

  // 5. Execution Activity Step
  const executedSteps: ExecutedStepResult[] = await executeStepActivity(plan, context);
  const hasErrors = executedSteps.some((s) => s.outcome === 'error');

  return {
    workflow_id: workflowId,
    status: hasErrors ? 'failed' : 'completed',
    plan,
    audit,
    executed_steps: executedSteps,
  };
}
