import { installHarness } from '../harness/index.js';
import { saveWorkflowState, getWorkflowState, updateStepStatus } from '../../src/agents/persistentStore.js';
import { ExecutionResult } from '../../src/agents/types.js';

export async function runPersistentStoreTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Agent Persistent Store Test Suite     ');
  console.log('=================================================');

  const testWorkflowId = `test_wf_${Date.now()}`;
  const initialPayload: ExecutionResult = {
    workflow_id: testWorkflowId,
    status: 'completed',
    plan: {
      id: 'plan_1',
      user_query: 'Run test triage',
      workspace_id: '00000000-0000-0000-0000-000000000000',
      steps: [
        { id: 'step_1', step_number: 1, action: 'Query DB', target_system: 'Postgres', tool_name: 'execute_sop_step', parameters: {} },
      ],
      created_at: new Date().toISOString(),
    },
    audit: {
      approved: true,
      requires_human_approval: false,
      risk_level: 'Low',
      flagged_reasons: [],
    },
    executed_steps: [],
  };

  // 1. Save Workflow State
  await saveWorkflowState(testWorkflowId, initialPayload);
  console.log('✅ PERSISTENT STORE PASSED: Saved initial workflow execution state.');

  // 2. Retrieve Workflow State
  const retrieved = await getWorkflowState(testWorkflowId);
  if (!retrieved || retrieved.workflow_id !== testWorkflowId) {
    console.error('❌ PERSISTENT STORE FAILED: Retrieved state mismatch!', retrieved);
    return false;
  }
  console.log('✅ PERSISTENT STORE PASSED: Retrieved matching workflow state.');

  // 3. Update Step Status
  await updateStepStatus(testWorkflowId, 'step_1', 'success', { row_count: 42 });
  const updated = await getWorkflowState(testWorkflowId);

  if (!updated || !Array.isArray(updated.executed_steps) || updated.executed_steps.length !== 1 || updated.executed_steps[0].outcome !== 'success') {
    console.error('❌ PERSISTENT STORE FAILED: Step status update failed!', updated);
    return false;
  }

  console.log('✅ PERSISTENT STORE PASSED: Successfully updated and verified step status/output in workflow state.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPersistentStoreTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
