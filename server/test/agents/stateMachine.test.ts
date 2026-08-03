import { transitionState, type WorkflowStatus } from '../../src/agents/stateMachine.js';

export async function runStateMachineTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Workflow State Machine Governor Test   ');
  console.log('=================================================');

  // 1. Test Valid Transitions (PLANNING -> AUDITING -> EXECUTING -> COMPLETED)
  const step1 = transitionState('IDLE', 'PLANNING');
  const step2 = transitionState('PLANNING', 'AUDITING');
  const step3 = transitionState('AUDITING', 'EXECUTING');
  const step4 = transitionState('EXECUTING', 'COMPLETED');

  if (!step1.success || !step2.success || !step3.success || !step4.success) {
    console.error('❌ STATE MACHINE TEST FAILED: Valid transition rejected!', { step1, step2, step3, step4 });
    return false;
  }
  console.log('✅ STATE MACHINE TEST PASSED: Valid workflow lifecycle (IDLE → PLANNING → AUDITING → EXECUTING → COMPLETED) governed successfully.');

  // 2. Test Illegal Transition (IDLE -> EXECUTING without PLANNING/AUDITING)
  const illegalStep = transitionState('IDLE', 'EXECUTING');
  if (illegalStep.success) {
    console.error('❌ STATE MACHINE TEST FAILED: Illegal direct transition IDLE → EXECUTING was permitted!');
    return false;
  }
  console.log(`✅ STATE MACHINE TEST PASSED: Illegal transition correctly blocked (${illegalStep.error}).`);

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStateMachineTest().then((success) => {
    if (!success) process.exit(1);
  });
}
