import { AuditResult, ExecutionPlan, WorkflowContext, RiskLevel } from './types.js';

/**
 * Auditor Agent: Evaluates ExecutionPlan against company safety policy rules and human-in-the-loop gates.
 */
export async function auditPlan(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<AuditResult> {
  const flaggedReasons: string[] = [];
  let maxRisk: RiskLevel = 'Low';
  let requiresHumanApproval = false;

  const { trustRole = 'low_trust' } = context;

  for (const step of plan.steps) {
    const actionLower = (step.action || '').toLowerCase();
    const targetLower = (step.target_system || '').toLowerCase();
    const paramsStr = JSON.stringify(step.parameters || {}).toLowerCase();

    // Policy Rule 1: High value financial operations (refund > $100)
    const amountMatch = paramsStr.match(/amount["\s:]+(\d+)/);
    const amount = amountMatch ? parseInt(amountMatch[1], 10) : 0;

    if (actionLower.includes('refund') || paramsStr.includes('refund')) {
      if (amount > 100 || actionLower.includes('high') || paramsStr.includes('high')) {
        flaggedReasons.push(`Policy Trigger: Financial refund action detected (amount: $${amount || '>100'}). Human manager approval required.`);
        requiresHumanApproval = true;
        maxRisk = 'High';
      }
    }

    // Policy Rule 2: Database mutations, drops, or truncate
    if (targetLower.includes('postgres') || targetLower.includes('database')) {
      if (actionLower.includes('delete') || actionLower.includes('drop') || actionLower.includes('mutate') || actionLower.includes('update')) {
        flaggedReasons.push(`Policy Trigger: Direct database mutation action "${step.action}" on ${step.target_system}. Human manager approval required.`);
        requiresHumanApproval = true;
        if (maxRisk !== 'Critical') maxRisk = 'High';
      }
    }

    // Policy Rule 3: Secret rotation, credential revocation, or admin access elevation
    if (actionLower.includes('secret') || actionLower.includes('credential') || actionLower.includes('revoke') || actionLower.includes('elevate')) {
      flaggedReasons.push(`Policy Trigger: Security critical credential/permission modification "${step.action}".`);
      requiresHumanApproval = true;
      maxRisk = 'Critical';
    }

    // Policy Rule 4: Step explicit risk_level or human_gate tag
    if (step.risk_level === 'High' || step.risk_level === 'Critical' || step.requires_human_gate) {
      flaggedReasons.push(`Policy Trigger: Step ${step.step_number} explicitly marked with risk level "${step.risk_level || 'High'}".`);
      requiresHumanApproval = true;
      if (step.risk_level === 'Critical') maxRisk = 'Critical';
      else if (maxRisk !== 'Critical') maxRisk = 'High';
    }
  }

  // Admin users or high_trust sessions can bypass non-critical gates if pre-authorized
  if (trustRole === 'admin' && maxRisk !== 'Critical') {
    requiresHumanApproval = false;
  }

  return {
    approved: !requiresHumanApproval,
    requires_human_approval: requiresHumanApproval,
    risk_level: maxRisk,
    flagged_reasons: flaggedReasons,
    sop_id: plan.sop_id,
    sop_title: plan.sop_title,
  };
}
