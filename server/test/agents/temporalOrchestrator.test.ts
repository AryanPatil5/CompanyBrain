import { temporalOrchestrator } from '../../src/agents/temporalOrchestrator.js';

export async function runTemporalOrchestratorTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Temporal.io Workflow Orchestrator Test ');
  console.log('=================================================');

  const workflowId = `wf_test_${Date.now()}`;

  // 1. Run low-risk workflow automatically to completion
  const lowRiskRes = await temporalOrchestrator.executeWorkflow({
    userQuery: 'Post status update to Slack channel',
    context: { trustRole: 'member' },
    workflowId: `${workflowId}_low`,
  });

  if (lowRiskRes.status !== 'completed' || lowRiskRes.executed_steps.length === 0) {
    console.error('❌ TEMPORAL ORCHESTRATOR TEST FAILED: Low-risk workflow did not complete successfully!', lowRiskRes);
    return false;
  }
  console.log(`✅ TEMPORAL TEST PASSED: Low-risk workflow completed (${lowRiskRes.workflow_id}).`);

  // 2. Run high-risk financial refund workflow -> verify workflow pauses for HITL Signal Gate
  const highRiskRes = await temporalOrchestrator.executeWorkflow({
    userQuery: 'Issue $250 refund in Stripe for customer account',
    context: { trustRole: 'member' },
    workflowId: `${workflowId}_high`,
  });

  if (highRiskRes.status !== 'paused_approval') {
    console.error('❌ TEMPORAL ORCHESTRATOR TEST FAILED: High-risk workflow was not paused for manager approval!', highRiskRes);
    return false;
  }
  console.log(`✅ TEMPORAL TEST PASSED: High-risk workflow correctly paused for manager approval (${highRiskRes.workflow_id}).`);

  // 3. Dispatch Temporal Signal (APPROVE) -> verify workflow resumes to completion
  const signalRes = await temporalOrchestrator.handleWorkflowSignal(`${workflowId}_high`, {
    action: 'APPROVE',
    approvalId: `appr_approved_${Date.now()}`,
  });

  if (signalRes.status !== 'completed' || signalRes.executed_steps.length === 0) {
    console.error('❌ TEMPORAL ORCHESTRATOR TEST FAILED: Workflow signal resumption failed!', signalRes);
    return false;
  }
  console.log(`✅ TEMPORAL TEST PASSED: Dispatched Temporal APPROVE signal and workflow resumed to completion (${signalRes.workflow_id}).`);

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTemporalOrchestratorTest().then((success) => {
    if (!success) process.exit(1);
  });
}
