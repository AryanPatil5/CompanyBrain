import { runWorkflow } from '../../src/agents/orchestrator.js';

export async function runMultiAgentOrchestratorTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Multi-Agent Orchestrator Test Suite   ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';
  const lowTrustUser = {
    workspaceId,
    userId: 'low-trust-agent-01',
    userRole: 'member',
    trustRole: 'low_trust' as const,
  };

  // 1. Test Low-Risk Workflow Execution
  const lowRiskRes = await runWorkflow('Post status update to Slack #general channel', lowTrustUser);

  if (!lowRiskRes.workflow_id || !lowRiskRes.plan || !lowRiskRes.audit) {
    console.error('❌ MULTI-AGENT TEST FAILED: Planner/Auditor pipeline output incomplete!', lowRiskRes);
    return false;
  }

  if (lowRiskRes.audit.requires_human_approval) {
    console.error('❌ MULTI-AGENT TEST FAILED: Low risk query was incorrectly flagged for human approval!');
    return false;
  }

  console.log(`✅ MULTI-AGENT TEST PASSED: Low-risk workflow executed automatically (Status: ${lowRiskRes.status}).`);

  // 2. Test High-Risk Workflow Execution (Refund / Database Mutation)
  const highRiskRes = await runWorkflow('Issue $500 refund to customer for invoice inv_98231 in Stripe', lowTrustUser);

  if (!highRiskRes.audit.requires_human_approval) {
    console.error('❌ MULTI-AGENT TEST FAILED: High-risk refund action was NOT flagged by Auditor!');
    return false;
  }

  if (highRiskRes.status !== 'paused_approval' || !highRiskRes.approval_id) {
    console.error('❌ MULTI-AGENT TEST FAILED: High-risk workflow did not pause for manager approval!', highRiskRes);
    return false;
  }

  console.log(`✅ MULTI-AGENT TEST PASSED: High-risk workflow correctly flagged by Auditor and paused for human manager approval (Ticket #${highRiskRes.approval_id}).`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMultiAgentOrchestratorTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
