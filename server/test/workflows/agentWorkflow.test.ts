import { installHarness } from '../harness/index.js';
import {
  planStepActivity,
  researchStepActivity,
  auditStepActivity,
  executeStepActivity,
} from '../../src/workflows/activities/agentActivities.js';

export async function runAgentWorkflowTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Temporal.io Agent Workflow Test Suite ');
  console.log('=================================================');

  const context = {
    workspaceId: '00000000-0000-0000-0000-000000000000',
    userId: 'user_temporal_test',
  };

  // Test 1: Planning Activity Execution
  try {
    const plan = await planStepActivity('How do I process a refund?', context);
    if (!plan || !plan.id || !Array.isArray(plan.steps)) {
      console.error('❌ TEMPORAL WORKFLOW TEST FAILED: Planning activity returned invalid plan!', plan);
      return false;
    }
    console.log(`✅ TEMPORAL WORKFLOW TEST PASSED: Executed Planning Activity (${plan.id}).`);
  } catch (err: any) {
    console.error('❌ TEMPORAL WORKFLOW TEST EXCEPTION (Planning Activity):', err.message);
    return false;
  }

  // Test 2: Research & Auditing Activities
  try {
    const plan = await planStepActivity('Check database status', context);
    const research = await researchStepActivity('Check database status', context.workspaceId);
    const audit = await auditStepActivity(plan, context);

    if (!audit || typeof audit.approved !== 'boolean') {
      console.error('❌ TEMPORAL WORKFLOW TEST FAILED: Audit activity returned invalid result!', audit);
      return false;
    }
    console.log(`✅ TEMPORAL WORKFLOW TEST PASSED: Executed Research (${research.length} items) & Auditing Activities (Risk: ${audit.risk_level}).`);
  } catch (err: any) {
    console.error('❌ TEMPORAL WORKFLOW TEST EXCEPTION (Audit Activity):', err.message);
    return false;
  }

  // Test 3: Plan Execution Activity & Activity Error Recovery
  try {
    const plan = await planStepActivity('Post update to Slack channel', context);
    const executed = await executeStepActivity(plan, context);

    if (!Array.isArray(executed) || executed.length === 0) {
      console.error('❌ TEMPORAL WORKFLOW TEST FAILED: Plan Execution Activity returned empty steps!', executed);
      return false;
    }
    console.log(`✅ TEMPORAL WORKFLOW TEST PASSED: Plan Execution Activity completed (${executed.length} steps executed successfully).`);
  } catch (err: any) {
    console.error('❌ TEMPORAL WORKFLOW TEST EXCEPTION (Execution Activity):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgentWorkflowTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
