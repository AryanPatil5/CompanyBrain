import { supabase } from '../config/supabase.js';
import { generatePlan } from './planner.js';
import { auditPlan } from './auditor.js';
import { executePlan } from './executor.js';
import { ExecutionResult, WorkflowContext } from './types.js';
import { saveWorkflowState, getWorkflowState, updateStepStatus } from './persistentStore.js';
import { transitionState, WorkflowStatus } from './stateMachine.js';

/**
 * Multi-Agent Orchestrator Service
 * State machine governing Planner -> Auditor -> Approval Check -> Executor with Redis checkpointing.
 */
export async function runWorkflow(
  userQuery: string,
  context: WorkflowContext,
  resumeWorkflowId?: string
): Promise<ExecutionResult> {

  const workflowId =
    resumeWorkflowId ||
    `wf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  let currentLifecycle: WorkflowStatus = 'IDLE';

  // Resume existing workflow
  let existingState: ExecutionResult | null = null;
  if (resumeWorkflowId) {
    existingState = await getWorkflowState(resumeWorkflowId);

    if (
      existingState &&
      existingState.status === 'paused_approval' &&
      context.approvalId
    ) {
      currentLifecycle = 'AWAITING_APPROVAL';
    }
  }

  // Planning
  currentLifecycle = transitionState(currentLifecycle, 'PLANNING').to;

  const plan = existingState?.plan
    ? existingState.plan
    : await generatePlan(userQuery, context);


  let initialState: ExecutionResult = {
    workflow_id: workflowId,
    status: 'completed',
    plan,
    audit:
      existingState?.audit || {
        approved: false,
        requires_human_approval: false,
        risk_level: 'Low',
        flagged_reasons: [],
      },
    executed_steps: existingState?.executed_steps || [],
  };

  await saveWorkflowState(workflowId, initialState);

  // Audit
  currentLifecycle = transitionState(currentLifecycle, 'AUDITING').to;

  const audit = existingState?.audit
    ? existingState.audit
    : await auditPlan(plan, context);


  initialState.audit = audit;

  await saveWorkflowState(workflowId, initialState);

  // Human Approval

  if (audit.requires_human_approval && !context.approvalId) {

    currentLifecycle = transitionState(
      currentLifecycle,
      'AWAITING_APPROVAL'
    ).to;

    let approvalId = `appr_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 6)}`;

    try {

      const { data: ticket } = await supabase
        .from('pending_approvals')
        .insert({
          sop_id: plan.sop_id || null,
          agent_id: context.userId || 'mcp-agent',
          requested_by: 'multi-agent-orchestrator',
          risk_level: audit.risk_level,
          status: 'pending',
          reason: `Flagged by Auditor Agent: ${audit.flagged_reasons.join('; ')}`,
          execution_context: {
            plan_id: plan.id,
            user_query: userQuery,
            workflow_id: workflowId,
          },
        })
        .select('id')
        .single();


      if (ticket?.id) {
        approvalId = ticket.id;
      }
    } catch (err) {
      console.warn('[17] Supabase insert failed:', err);
    }

    const pausedResult: ExecutionResult = {
      workflow_id: workflowId,
      status: 'paused_approval',
      plan,
      audit,
      executed_steps: [],
      approval_id: approvalId,
      error: `Workflow paused: Human manager approval required ticket #${approvalId}. Reasons: ${audit.flagged_reasons.join(
        ' | '
      )}`,
    };

    await saveWorkflowState(workflowId, pausedResult);

    return pausedResult;
  }

  // Approval validation
  if (context.approvalId) {

    try {
      const { data: ticket } = await supabase
        .from('pending_approvals')
        .select('id,status,consumed_at')
        .eq('id', context.approvalId)
        .single();

      if (
        !ticket ||
        ticket.status !== 'approved' ||
        ticket.consumed_at !== null
      ) {
        return {
          workflow_id: workflowId,
          status: 'failed',
          plan,
          audit,
          executed_steps: [],
          error: `Approval ticket ${context.approvalId} is invalid.`,
        };
      }

      await supabase
        .from('pending_approvals')
        .update({
          consumed_at: new Date().toISOString(),
        })
        .eq('id', context.approvalId);

    } catch (err) {
      console.warn('[22] Approval validation failed:', err);
    }
  }

  // Execute
  currentLifecycle = transitionState(currentLifecycle, 'EXECUTING').to;

  const executedSteps = await executePlan(plan, context);

  for (const step of executedSteps) {
    await updateStepStatus(
      workflowId,
      step.step_id,
      step.outcome,
      step.response_data
    );
  }

  const hasErrors = executedSteps.some((s) => s.outcome === 'error');

  currentLifecycle = transitionState(
    currentLifecycle,
    hasErrors ? 'FAILED' : 'COMPLETED'
  ).to;

  const finalResult: ExecutionResult = {
    workflow_id: workflowId,
    status: hasErrors ? 'failed' : 'completed',
    plan,
    audit,
    executed_steps: executedSteps,
  };

  await saveWorkflowState(workflowId, finalResult);

  return finalResult;
}

export const executeWorkflow = runWorkflow;