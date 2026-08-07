import { logger } from '../../logger.js';
import { generatePlan } from '../../agents/planner.js';
import { auditPlan } from '../../agents/auditor.js';
import { executePlan } from '../../agents/executor.js';
import { ExecutionPlan, AuditResult, ExecutedStepResult, WorkflowContext } from '../../agents/types.js';
import { hybridSearch } from '../../services/retrieval/hybridSearch.js';
import { startTraceSpan, recordMetric } from '../../middleware/telemetry.js';

export async function planStepActivity(
  userQuery: string,
  context: WorkflowContext
): Promise<ExecutionPlan> {
  const span = startTraceSpan('Temporal Activity: planStepActivity', { userQuery, workspaceId: context.workspaceId });
  const startTime = Date.now();

  try {
    logger.info(`[Temporal Activity] Executing Planning for query: "${userQuery}"...`);
    const plan = await generatePlan(userQuery, context);

    const duration = Date.now() - startTime;
    span.end('ok');
    recordMetric('agent_execution_duration_ms', duration, { activity: 'planStepActivity' });
    recordMetric('llm_token_usage_total', 450, { model: 'gemini-2.0-flash' });

    return plan;
  } catch (err: any) {
    span.end('error', err.message);
    throw err;
  }
}

export async function researchStepActivity(
  query: string,
  workspaceId: string
): Promise<any[]> {
  const span = startTraceSpan('Temporal Activity: researchStepActivity', { query, workspaceId });
  const startTime = Date.now();

  try {
    logger.info(`[Temporal Activity] Executing Hybrid Research Activity for: "${query}"...`);
    const results = await hybridSearch({
      query,
      workspaceId,
      userId: 'system-temporal',
      limit: 5,
    });

    const duration = Date.now() - startTime;
    span.end('ok');
    recordMetric('agent_execution_duration_ms', duration, { activity: 'researchStepActivity' });

    return results;
  } catch (err: any) {
    span.end('error', err.message);
    throw err;
  }
}

export async function auditStepActivity(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<AuditResult> {
  const span = startTraceSpan('Temporal Activity: auditStepActivity', { planId: plan.id });
  const startTime = Date.now();

  try {
    logger.info(`[Temporal Activity] Executing Audit Activity for plan #${plan.id}...`);
    const audit = await auditPlan(plan, context);

    const duration = Date.now() - startTime;
    span.end('ok');
    recordMetric('agent_execution_duration_ms', duration, { activity: 'auditStepActivity' });
    recordMetric('llm_token_usage_total', 150, { model: 'gemini-2.0-flash' });

    return audit;
  } catch (err: any) {
    span.end('error', err.message);
    throw err;
  }
}

export async function executeStepActivity(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<ExecutedStepResult[]> {
  const span = startTraceSpan('Temporal Activity: executeStepActivity', { planId: plan.id });
  const startTime = Date.now();

  try {
    logger.info(`[Temporal Activity] Executing Plan Execution Activity for plan #${plan.id}...`);
    const results = await executePlan(plan, context);

    const duration = Date.now() - startTime;
    span.end('ok');
    recordMetric('agent_execution_duration_ms', duration, { activity: 'executeStepActivity' });

    return results;
  } catch (err: any) {
    span.end('error', err.message);
    throw err;
  }
}
