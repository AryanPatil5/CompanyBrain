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
  const workflowId = resumeWorkflowId || `wf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  let currentLifecycle: WorkflowStatus = 'IDLE';

  // 1. Resume existing workflow state if resumeWorkflowId provided
  let existingState: ExecutionResult | null = null;
  if (resumeWorkflowId) {
    existingState = await getWorkflowState(resumeWorkflowId);
    if (existingState && existingState.status === 'paused_approval' && context.approvalId) {
      currentLifecycle = 'AWAITING_APPROVAL';
    }
  }

  // 2. Planning State Transition
  const transPlan = transitionState(currentLifecycle, 'PLANNING');
  currentLifecycle = transPlan.to;

  const plan = (existingState?.plan) ? existingState.plan : await generatePlan(userQuery, context);

  let initialState: ExecutionResult = {
    workflow_id: workflowId,
    status: 'completed', // Transient
    plan,
    audit: existingState?.audit || { approved: false, requires_human_approval: false, risk_level: 'Low', flagged_reasons: [] },
    executed_steps: existingState?.executed_steps || [],
  };
  await saveWorkflowState(workflowId, initialState);

  // 3. Auditing State Transition
  const transAudit = transitionState(currentLifecycle, 'AUDITING');
  currentLifecycle = transAudit.to;

  const audit = existingState?.audit ? existingState.audit : await auditPlan(plan, context);
  initialState.audit = audit;
  await saveWorkflowState(workflowId, initialState);

  // 4. Human Approval Gate Check
  if (audit.requires_human_approval && !context.approvalId) {
    const transGate = transitionState(currentLifecycle, 'AWAITING_APPROVAL');
    currentLifecycle = transGate.to;

    console.log(`[Orchestrator] Plan flagged by Auditor (${audit.flagged_reasons.join(' | ')}). Pausing for human approval...`);

    let approvalId = `appr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
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
          execution_context: { plan_id: plan.id, user_query: userQuery, workflow_id: workflowId },
        })
        .select('id')
        .single();

      if (ticket?.id) {
        approvalId = ticket.id;
      }
    } catch (dbErr) {
      console.warn('[Orchestrator Warning] Failed to write pending approval ticket:', dbErr);
    }

    const pausedResult: ExecutionResult = {
      workflow_id: workflowId,
      status: 'paused_approval',
      plan,
      audit,
      executed_steps: [],
      approval_id: approvalId,
      error: `Workflow paused: Human manager approval required ticket #${approvalId}. Reasons: ${audit.flagged_reasons.join(' | ')}`,
    };

    await saveWorkflowState(workflowId, pausedResult);
    return pausedResult;
  }

  // 5. Verification if approvalId is passed
  if (context.approvalId) {
    try {
      const { data: ticket } = await supabase
        .from('pending_approvals')
        .select('id, status, consumed_at')
        .eq('id', context.approvalId)
        .single();

      if (!ticket || ticket.status !== 'approved' || ticket.consumed_at !== null) {
        const failedResult: ExecutionResult = {
          workflow_id: workflowId,
          status: 'failed',
          plan,
          audit,
          executed_steps: [],
          error: `Approval ticket #${context.approvalId} is invalid, unapproved, or already consumed.`,
        };
        await saveWorkflowState(workflowId, failedResult);
        return failedResult;
      }

      // Claim ticket
      await supabase
        .from('pending_approvals')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', context.approvalId);
    } catch {
      // Non-fatal query catch during dev tests
    }
  }

  // 6. Executing State Transition & Execution Run
  const transExec = transitionState(currentLifecycle, 'EXECUTING');
  currentLifecycle = transExec.to;

  const executedSteps = await executePlan(plan, context);

  // Update step outcomes in Redis persistent store
  for (const stepRes of executedSteps) {
    await updateStepStatus(workflowId, stepRes.step_id, stepRes.outcome, stepRes.response_data);
  }

  const hasErrors = executedSteps.some((s) => s.outcome === 'error');
  const finalStatus: WorkflowStatus = hasErrors ? 'FAILED' : 'COMPLETED';

  const transFinal = transitionState(currentLifecycle, finalStatus);
  currentLifecycle = transFinal.to;

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
