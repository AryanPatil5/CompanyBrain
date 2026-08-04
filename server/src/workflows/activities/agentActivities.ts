import { generatePlan } from '../../agents/planner.js';
import { auditPlan } from '../../agents/auditor.js';
import { executePlan } from '../../agents/executor.js';
import { ExecutionPlan, AuditResult, ExecutedStepResult, WorkflowContext } from '../../agents/types.js';
import { hybridSearch } from '../../services/retrieval/hybridSearch.js';

export async function planStepActivity(
  userQuery: string,
  context: WorkflowContext
): Promise<ExecutionPlan> {
  console.log(`[Temporal Activity] Executing Planning for query: "${userQuery}"...`);
  return await generatePlan(userQuery, context);
}

export async function researchStepActivity(
  query: string,
  workspaceId: string
): Promise<any[]> {
  console.log(`[Temporal Activity] Executing Hybrid Research Activity for: "${query}"...`);
  return await hybridSearch({
    query,
    workspaceId,
    userId: 'system-temporal',
    limit: 5,
  });
}

export async function auditStepActivity(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<AuditResult> {
  console.log(`[Temporal Activity] Executing Audit Activity for plan #${plan.id}...`);
  return await auditPlan(plan, context);
}

export async function executeStepActivity(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<ExecutedStepResult[]> {
  console.log(`[Temporal Activity] Executing Plan Execution Activity for plan #${plan.id}...`);
  return await executePlan(plan, context);
}
