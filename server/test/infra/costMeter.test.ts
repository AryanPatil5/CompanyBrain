// Hermetic unit tests for the cost-meter scaffold (Phase 0 Task 10).
// Uses the in-memory store seam — no live infrastructure, no Supabase writes.

import {
  checkQuota,
  costMeter,
  estimateCostCents,
  getWorkspaceUsage,
  recordUsage,
  setUsageStoreForTest,
  usageFromContext,
  type UsageRow,
  type UsageStore,
} from '../../src/services/costMeter.js';
import { runWithCorrelationId } from '../../src/logger.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ COSTMETER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ COSTMETER TEST FAILED: ${name}`, extra ?? '');
  }
}

function memoryStore(): { store: UsageStore; rows: any[]; failPersist: (flag: boolean) => void } {
  const rows: any[] = [];
  let fail = false;
  const store: UsageStore = {
    async persist(row: any): Promise<void> {
      if (fail) throw new Error('usage_meters unavailable');
      rows.push({ ...row });
    },
    async query(workspaceId: string): Promise<UsageRow[]> {
      return rows
        .filter((row) => row.workspace_id === workspaceId)
        .map((row) => ({
          resource: row.resource,
          units: Number(row.units) || 0,
          costCents: Number(row.cost_cents) || 0,
          provider: row.provider ?? null,
          model: row.model ?? null,
        }));
    },
  };
  return {
    store,
    rows,
    failPersist: (flag: boolean) => {
      fail = flag;
    },
  };
}

async function testEstimateCost(): Promise<boolean> {
  check('ollama is free', estimateCostCents('ollama', 'llama3', 1_000_000, 1_000_000) === 0);
  check('deepseek input pricing', estimateCostCents('openrouter', 'deepseek/deepseek-v4-flash-0731', 1_000_000, 0) === 15);
  check('deepseek output pricing', estimateCostCents('openrouter', 'deepseek/deepseek-v4-flash-0731', 0, 1_000_000) === 60);
  check('gemini pricing', estimateCostCents('gemini', 'gemini-2.5-flash', 1_000_000, 0) === 125);
  check('unknown model falls back to default', estimateCostCents('openrouter', 'future-model-x', 1_000_000, 1_000_000) === 200);
  check('estimate rounds', estimateCostCents('openrouter', 'deepseek/deepseek-v4-flash-0731', 100, 0) === 0);
  return success;
}

async function testRecordUsagePersistsAllFields(): Promise<boolean> {
  const mem = memoryStore();
  setUsageStoreForTest(mem.store);

  await recordUsage({
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash-0731',
    promptTokens: 500,
    completionTokens: 200,
    totalTokens: 700,
    latencyMs: 1234,
    workspaceId: 'ws-usage-1',
    correlationId: 'corr-usage-1',
  });

  check('one row persisted', mem.rows.length === 1);
  const row = mem.rows[0];
  check('row has workspace_id', row.workspace_id === 'ws-usage-1');
  check('row has resource llm:provider:model', row.resource === 'llm:openrouter:deepseek/deepseek-v4-flash-0731');
  check('row has provider', row.provider === 'openrouter');
  check('row has model', row.model === 'deepseek/deepseek-v4-flash-0731');
  check('row has prompt_tokens', row.prompt_tokens === 500);
  check('row has completion_tokens', row.completion_tokens === 200);
  check('row has total_tokens', row.total_tokens === 700);
  check('row has latency_ms', row.latency_ms === 1234);
  check('row has correlation_id', row.correlation_id === 'corr-usage-1');
  check('row has units=totalTokens', row.units === 700);
  check('row has numeric cost_cents', typeof row.cost_cents === 'number' && row.cost_cents >= 0);
  check('row has ISO period', !Number.isNaN(Date.parse(row.period)));
  return success;
}

async function testRecordUsageNeverFailsOnPersistenceError(): Promise<boolean> {
  const mem = memoryStore();
  mem.failPersist(true);
  setUsageStoreForTest(mem.store);

  let threw = false;
  try {
    await recordUsage({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      latencyMs: 50,
      workspaceId: 'ws-usage-fail',
      correlationId: 'corr-usage-fail',
    });
  } catch {
    threw = true;
  }
  check('recordUsage resolves despite persistence failure', threw === false);
  check('no rows persisted on failure', mem.rows.length === 0);
  return success;
}

async function testGetWorkspaceUsage(): Promise<boolean> {
  const mem = memoryStore();
  mem.rows.push({
    workspace_id: 'ws-usage-2',
    resource: 'llm:openrouter:deepseek/deepseek-v4-flash-0731',
    units: 500,
    cost_cents: 3,
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash-0731',
  });
  mem.rows.push({
    workspace_id: 'ws-usage-2',
    resource: 'llm:gemini:gemini-2.5-flash',
    units: 700,
    cost_cents: 7,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
  });
  mem.rows.push({
    workspace_id: 'ws-usage-other',
    resource: 'llm:openrouter:some-model',
    units: 999,
    cost_cents: 99,
    provider: 'openrouter',
    model: 'some-model',
  });
  setUsageStoreForTest(mem.store);

  const summary = await getWorkspaceUsage('ws-usage-2');
  check('summary requests', summary.requests === 2);
  check('summary totalTokens', summary.totalTokens === 1200);
  check('summary totalCostCents', summary.totalCostCents === 10);
  check('summary byProvider openrouter tokens', summary.byProvider['openrouter']?.tokens === 500);
  check('summary byProvider gemini cost', summary.byProvider['gemini']?.costCents === 7);
  check('summary byResource counts', summary.byResource['llm:gemini:gemini-2.5-flash']?.requests === 1);
  check('other workspace isolated', summary.totalTokens === 1200);

  const empty = await getWorkspaceUsage('ws-usage-none');
  check('unknown workspace returns empty summary', empty.requests === 0 && empty.totalCostCents === 0);
  return success;
}

async function testGetWorkspaceUsageFailsSoft(): Promise<boolean> {
  setUsageStoreForTest({
    async persist(): Promise<void> {},
    async query(): Promise<UsageRow[]> {
      throw new Error('store down');
    },
  });
  const summary = await getWorkspaceUsage('ws-usage-down');
  check('query failure returns empty summary without throwing', summary.requests === 0 && summary.totalCostCents === 0);
  return success;
}

async function testCheckQuota(): Promise<boolean> {
  const saved = process.env.COST_QUOTA_WS_QUOTA1;
  delete process.env.COST_QUOTA_WS_QUOTA1;

  const mem = memoryStore();
  mem.rows.push({
    workspace_id: 'WS-QUOTA1',
    resource: 'llm:openrouter:model',
    units: 1000,
    cost_cents: 250,
    provider: 'openrouter',
    model: 'model',
  });
  setUsageStoreForTest(mem.store);

  const noQuota = await checkQuota('WS-QUOTA1');
  check('no env quota means allowed', noQuota.allowed === true && noQuota.quotaCents === 0);

  process.env.COST_QUOTA_WS_QUOTA1 = '500';
  const under = await checkQuota('WS-QUOTA1');
  check('usage under quota allowed', under.allowed === true && under.usageCents === 250);

  process.env.COST_QUOTA_WS_QUOTA1 = '100';
  const over = await checkQuota('WS-QUOTA1');
  check('usage over quota flagged', over.allowed === false && over.reason === 'quota_exceeded');

  if (saved === undefined) delete process.env.COST_QUOTA_WS_QUOTA1;
  else process.env.COST_QUOTA_WS_QUOTA1 = saved;
  return success;
}

async function testUsageFromContext(): Promise<boolean> {
  const fromContext = usageFromContext('openrouter', 'm', { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, 10);
  check('no context falls back to system workspace', fromContext.workspaceId === 'system');
  check('correlationId present', typeof fromContext.correlationId === 'string');

  let inside: ReturnType<typeof usageFromContext> | null = null;
  runWithCorrelationId('ctx-corr-1', () => {
    inside = usageFromContext('openrouter', 'm', { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, 10);
  });
  check('context correlationId used', inside?.correlationId === 'ctx-corr-1');
  check('context workspace defaults to system', inside?.workspaceId === 'system');

  let withWs: ReturnType<typeof usageFromContext> | null = null;
  runWithCorrelationId('ctx-corr-2', () => {
    withWs = usageFromContext('openrouter', 'm', { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, 10, 'explicit-ws');
  });
  check('explicit workspaceId wins over context', withWs?.workspaceId === 'explicit-ws');
  check('explicit workspaceId wins over system fallback', withWs?.correlationId === 'ctx-corr-2');
  return success;
}

async function testClassApiPreserved(): Promise<boolean> {
  const mem = memoryStore();
  setUsageStoreForTest(mem.store);

  await costMeter.recordUsage('ws-class-1', 'llm:openrouter:m', { seconds: Math.floor(Date.now() / 1000), nanos: 0 }, 100, 0.1);
  const cost = costMeter.getWorkspaceCost('ws-class-1', { seconds: Math.floor(Date.now() / 1000), nanos: 0 }, 'hourly');
  check('class recordUsage persisted', mem.rows.length === 1);
  check('class getWorkspaceCost works', cost === 10);

  const byResource = costMeter.getCostByResource('ws-class-1', { seconds: Math.floor(Date.now() / 1000), nanos: 0 }, 'hourly');
  check('class getCostByResource works', byResource['llm:openrouter:m'] === 10);

  const total = costMeter.getTotalCost({ seconds: Math.floor(Date.now() / 1000), nanos: 0 }, 'daily');
  check('class getTotalCost works', total === 10);
  return success;
}

async function runCostMeterTests(): Promise<boolean> {
  const suites: Array<() => Promise<boolean>> = [
    testEstimateCost,
    testRecordUsagePersistsAllFields,
    testRecordUsageNeverFailsOnPersistenceError,
    testGetWorkspaceUsage,
    testGetWorkspaceUsageFailsSoft,
    testCheckQuota,
    testUsageFromContext,
    testClassApiPreserved,
  ];
  for (const suite of suites) {
    await suite();
  }
  setUsageStoreForTest(null);
  console.log(`\n[CostMeter Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCostMeterTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
