import { installHarness } from '../harness/index.js';
import {
  observabilityMiddleware,
  recordAgentExecution,
  recordTokenUsage,
  getMetricsSnapshot,
} from '../../src/middleware/observability.js';

export async function runObservabilityTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Observability & Metrics Middleware Test');
  console.log('=================================================');

  // 1. Test Agent Execution & Token Usage Recording.
  // The registry is module-global and shared with earlier suites, so assert on
  // deltas relative to the pre-test snapshot. getMetricsSnapshot returns the
  // live registry, so clone it to freeze the baseline.
  const before = structuredClone(getMetricsSnapshot());

  recordAgentExecution('COMPLETED');
  recordAgentExecution('AWAITING_APPROVAL');
  recordTokenUsage('google', 150, 45);
  recordTokenUsage('openrouter', 200, 80);

  // 2. Test Middleware Request Tracking
  const middleware = observabilityMiddleware();
  let finishCallback: any = null;

  const mockReq: any = {
    method: 'POST',
    path: '/api/sops/search',
    route: { path: '/api/sops/search' },
  };

  const mockRes: any = {
    statusCode: 200,
    on: (event: string, cb: any) => {
      if (event === 'finish') finishCallback = cb;
    },
  };

  middleware(mockReq, mockRes, () => {});

  if (typeof finishCallback === 'function') {
    finishCallback();
  }

  // 3. Verify Metrics Snapshot
  const snapshot = getMetricsSnapshot();

  if (!snapshot || typeof snapshot.uptime_seconds !== 'number') {
    console.error('❌ OBSERVABILITY TEST FAILED: Invalid metrics snapshot object!', snapshot);
    return false;
  }

  const beforeCounts = before.agents?.executions ?? {};
  if (
    snapshot.agents.executions.COMPLETED - (beforeCounts.COMPLETED ?? 0) !== 1 ||
    snapshot.agents.executions.AWAITING_APPROVAL - (beforeCounts.AWAITING_APPROVAL ?? 0) !== 1
  ) {
    console.error('❌ OBSERVABILITY TEST FAILED: Agent execution counts mismatch!', snapshot.agents);
    return false;
  }

  if (
    snapshot.llm.token_usage.google.input - (before.llm?.token_usage?.google?.input ?? 0) !== 150 ||
    snapshot.llm.token_usage.openrouter.output - (before.llm?.token_usage?.openrouter?.output ?? 0) !== 80
  ) {
    console.error('❌ OBSERVABILITY TEST FAILED: Token usage metrics mismatch!', snapshot.llm);
    return false;
  }

  console.log('✅ OBSERVABILITY TEST PASSED: Successfully tracked request latencies, agent executions, and LLM token usage.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runObservabilityTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
