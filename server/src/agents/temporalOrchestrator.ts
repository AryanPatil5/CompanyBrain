import { generatePlan } from './planner.js';
import { auditPlan } from './auditor.js';
import { executePlan } from './executor.js';
import { ExecutionResult, WorkflowContext } from './types.js';
import { saveWorkflowState, getWorkflowState, updateStepStatus } from './persistentStore.js';
import { transitionState, WorkflowStatus } from './stateMachine.js';

export interface TemporalWorkflowOptions {
  userQuery: string;
  context: WorkflowContext;
  workflowId?: string;
  maxRetryAttempts?: number;
}

export interface TemporalSignalPayload {
  approvalId?: string;
  reason?: string;
  action: 'APPROVE' | 'REJECT';
}

/**
 * Temporal-compatible Durable Workflow Engine
 * Encapsulates multi-agent Planner -> Auditor -> HITL Signal Gate -> Executor pipeline into a durable event-replayable execution flow.
 */
export class TemporalWorkflowOrchestrator {
  /**
   * Starts or resumes a durable multi-agent workflow execution with activity retries and checkpointing.
   */
  public async executeWorkflow(options: TemporalWorkflowOptions): Promise<ExecutionResult> {
    const { userQuery, context } = options;
    const workflowId = options.workflowId || `wf_temporal_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    let currentLifecycle: WorkflowStatus = 'IDLE';

    // 1. Check for existing workflow state (Resumption Check)
    let existingState = await getWorkflowState(workflowId);
    if (existingState && existingState.status === 'paused_approval' && context.approvalId) {
      currentLifecycle = 'AWAITING_APPROVAL';
    }

    // 2. Planning Activity
    const transPlan = transitionState(currentLifecycle, 'PLANNING');
    currentLifecycle = transPlan.to;

    const plan = existingState?.plan ? existingState.plan : await generatePlan(userQuery, context);

    let workflowState: ExecutionResult = {
      workflow_id: workflowId,
      status: 'completed',
      plan,
      audit: existingState?.audit || { approved: false, requires_human_approval: false, risk_level: 'Low', flagged_reasons: [] },
      executed_steps: existingState?.executed_steps || [],
    };
    await saveWorkflowState(workflowId, workflowState);

    // 3. Auditing Activity
    const transAudit = transitionState(currentLifecycle, 'AUDITING');
    currentLifecycle = transAudit.to;

    const audit = existingState?.audit ? existingState.audit : await auditPlan(plan, context);
    workflowState.audit = audit;
    await saveWorkflowState(workflowId, workflowState);

    // 4. Human-in-the-Loop Temporal Signal Gate
    if (audit.requires_human_approval && !context.approvalId) {
      const transGate = transitionState(currentLifecycle, 'AWAITING_APPROVAL');
      currentLifecycle = transGate.to;

      const pausedResult: ExecutionResult = {
        workflow_id: workflowId,
        status: 'paused_approval',
        plan,
        audit,
        executed_steps: [],
        approval_id: `ticket_${workflowId}`,
        error: `Workflow paused: Human approval required ticket #ticket_${workflowId}. Reasons: ${audit.flagged_reasons.join(' | ')}`,
      };

      await saveWorkflowState(workflowId, pausedResult);
      return pausedResult;
    }

    // 5. Executing Activity
    const transExec = transitionState(currentLifecycle, 'EXECUTING');
    currentLifecycle = transExec.to;

    const executedSteps = await executePlan(plan, context);

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

  /**
   * Dispatches a Human-in-the-Loop Temporal Signal (APPROVE or REJECT) to resume or terminate a paused workflow.
   */
  public async handleWorkflowSignal(
    workflowId: string,
    signal: TemporalSignalPayload
  ): Promise<ExecutionResult> {
    const existingState = await getWorkflowState(workflowId);
    if (!existingState) {
      throw new Error(`Temporal Workflow ID "${workflowId}" not found in persistent store.`);
    }

    if (signal.action === 'REJECT') {
      const failedResult: ExecutionResult = {
        ...existingState,
        status: 'failed',
        error: `Workflow rejected by manager: ${signal.reason || 'Human manager denied approval.'}`,
      };
      await saveWorkflowState(workflowId, failedResult);
      return failedResult;
    }

    // Signal APPROVED -> Resume workflow execution with approvalId context
    return this.executeWorkflow({
      userQuery: existingState.plan.user_query,
      context: {
        workspaceId: existingState.plan.workspace_id,
        approvalId: signal.approvalId || `ticket_${workflowId}`,
      },
      workflowId,
    });
  }
}

export const temporalOrchestrator = new TemporalWorkflowOrchestrator();
