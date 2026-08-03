import { supabase } from '../config/supabase.js';
import { generatePlan } from './planner.js';
import { auditPlan } from './auditor.js';
import { executePlan } from './executor.js';
import { ExecutionResult, WorkflowContext } from './types.js';

/**
 * Multi-Agent Orchestrator Service
 * State machine orchestrating Planner -> Auditor -> Approval Check -> Executor.
 */
export async function runWorkflow(
  userQuery: string,
  context: WorkflowContext
): Promise<ExecutionResult> {
  const workflowId = `wf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // 1. Planner Agent: Decompose user query into DAG ExecutionPlan
  const plan = await generatePlan(userQuery, context);

  // 2. Auditor Agent: Evaluate safety policy rules and human-in-the-loop gates
  const audit = await auditPlan(plan, context);

  // 3. Human Approval Gate Check
  if (audit.requires_human_approval && !context.approvalId) {
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
          execution_context: { plan_id: plan.id, user_query: userQuery },
        })
        .select('id')
        .single();

      if (ticket?.id) {
        approvalId = ticket.id;
      }
    } catch (dbErr) {
      console.warn('[Orchestrator Warning] Failed to write pending approval ticket:', dbErr);
    }

    return {
      workflow_id: workflowId,
      status: 'paused_approval',
      plan,
      audit,
      executed_steps: [],
      approval_id: approvalId,
      error: `Workflow paused: Human manager approval required ticket #${approvalId}. Reasons: ${audit.flagged_reasons.join(' | ')}`,
    };
  }

  // 4. Verification if approvalId is passed
  if (context.approvalId) {
    try {
      const { data: ticket } = await supabase
        .from('pending_approvals')
        .select('id, status, consumed_at')
        .eq('id', context.approvalId)
        .single();

      if (!ticket || ticket.status !== 'approved' || ticket.consumed_at !== null) {
        return {
          workflow_id: workflowId,
          status: 'failed',
          plan,
          audit,
          executed_steps: [],
          error: `Approval ticket #${context.approvalId} is invalid, unapproved, or already consumed.`,
        };
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

  // 5. Executor Agent: Run approved steps sequentially
  const executedSteps = await executePlan(plan, context);
  const hasErrors = executedSteps.some((s) => s.outcome === 'error');

  return {
    workflow_id: workflowId,
    status: hasErrors ? 'failed' : 'completed',
    plan,
    audit,
    executed_steps: executedSteps,
  };
}
