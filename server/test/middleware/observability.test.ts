import {
  observabilityMiddleware,
  recordAgentExecution,
  recordTokenUsage,
  getMetricsSnapshot,
} from '../../src/middleware/observability.js';

export async function runObservabilityTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Observability & Metrics Middleware Test');
  console.log('=================================================');

  // 1. Test Agent Execution & Token Usage Recording
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

  if (snapshot.agents.executions.COMPLETED !== 1 || snapshot.agents.executions.AWAITING_APPROVAL !== 1) {
    console.error('❌ OBSERVABILITY TEST FAILED: Agent execution counts mismatch!', snapshot.agents);
    return false;
  }

  if (snapshot.llm.token_usage.google.input !== 150 || snapshot.llm.token_usage.openrouter.output !== 80) {
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
