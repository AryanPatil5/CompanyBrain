// Hermetic unit tests for per-process health endpoints (Phase 0 Task 2).
// No live infrastructure required: every check under test points at closed
// ports or uses injected fakes, and all checks self-bound with timeouts.

import {
  SERVICE_VERSION,
  buildHealthPayload,
  checkAIProviderConfigured,
  checkBullMQQueueCounts,
  checkPostgres,
  checkRedis,
  checkSupabase,
  checkTemporalConnectivity,
  getProcessStats,
  setProcessStat,
  startHealthServer,
  stopHealthServer,
  withTimeout,
} from '../../src/services/health.js';
import type { AddressInfo } from 'node:net';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ HEALTH TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ HEALTH TEST FAILED: ${name}`, extra ?? '');
  }
}

function checkThrows(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  return fn().then(
    () => false,
    () => true
  );
}

async function testWithTimeout(): Promise<boolean> {
  const fast = await withTimeout(500, Promise.resolve('ok'));
  check('withTimeout resolves fast promises', fast === 'ok');

  const slowRejected = await checkThrows('withTimeout rejects hung promises', () =>
    withTimeout(150, new Promise(() => {}))
  );
  check('withTimeout rejects hung promises', slowRejected);

  const rejectionPropagates = await checkThrows('withTimeout propagates rejections', () =>
    withTimeout(500, Promise.reject(new Error('boom')))
  );
  check('withTimeout propagates rejections', rejectionPropagates);
  return success;
}

async function testBuildHealthPayload(): Promise<boolean> {
  const payload = await buildHealthPayload(
    'test-api',
    {
      okDep: async () => true,
      badDep: async () => false,
      throwDep: async () => {
        throw new Error('check exploded');
      },
    },
    { extra: 42 }
  );

  check('payload.status is ok', payload.status === 'ok');
  check('payload.process is set', payload.process === 'test-api');
  check('payload.version matches package.json', payload.version === SERVICE_VERSION);
  check('payload.uptime is a number', typeof payload.uptime === 'number' && payload.uptime >= 0);
  check('payload.pid matches process pid', payload.pid === process.pid);
  check('payload.startedAt parses as date', !Number.isNaN(Date.parse(payload.startedAt)));
  check('ok dependency reported ok', payload.dependencies.okDep === 'ok');
  check('false dependency reported unavailable', payload.dependencies.badDep === 'unavailable');
  check('throwing dependency reported unavailable', payload.dependencies.throwDep === 'unavailable');
  check('details included', payload.details?.extra === 42);

  const noDetails = await buildHealthPayload('test-api', { okDep: async () => true });
  check('details omitted when empty', noDetails.details === undefined);
  return success;
}

async function testCheckRedisRefused(): Promise<boolean> {
  const started = Date.now();
  const ok = await checkRedis('redis://127.0.0.1:1', 400);
  const elapsed = Date.now() - started;
  check('checkRedis returns false against closed port', ok === false);
  check('checkRedis is time-bounded', elapsed < 3000);
  return success;
}

async function testCheckPostgresRefused(): Promise<boolean> {
  const started = Date.now();
  const ok = await checkPostgres('postgresql://127.0.0.1:1/company_brain', 400);
  const elapsed = Date.now() - started;
  check('checkPostgres returns false against closed port', ok === false);
  check('checkPostgres is time-bounded', elapsed < 3000);
  return success;
}

async function testCheckSupabaseOffline(): Promise<boolean> {
  const started = Date.now();
  const ok = await checkSupabase(500);
  const elapsed = Date.now() - started;
  check('checkSupabase returns false without live Supabase', ok === false);
  check('checkSupabase is time-bounded', elapsed < 3000);
  return success;
}

async function testCheckTemporalOffline(): Promise<boolean> {
  const started = Date.now();
  const ok = await checkTemporalConnectivity('127.0.0.1:1', 400);
  const elapsed = Date.now() - started;
  check('checkTemporalConnectivity returns false against closed port', ok === false);
  check('checkTemporalConnectivity is time-bounded', elapsed < 3000);
  return success;
}

async function testCheckAIProviderConfigured(): Promise<boolean> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'ENABLE_OLLAMA']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  const none = await checkAIProviderConfigured();
  check('checkAIProviderConfigured false with no keys', none === false);

  process.env.OPENROUTER_API_KEY = 'sk-test-not-a-secret';
  const withKey = await checkAIProviderConfigured();
  check('checkAIProviderConfigured true with provider key', withKey === true);
  delete process.env.OPENROUTER_API_KEY;

  process.env.ENABLE_OLLAMA = 'true';
  const withOllama = await checkAIProviderConfigured();
  check('checkAIProviderConfigured true with ollama enabled', withOllama === true);

  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return success;
}

async function testCheckBullMQQueueCounts(): Promise<boolean> {
  const fakeQueue = {
    getJobCounts: async () => ({ waiting: 3, active: 1, completed: 9, failed: 2, delayed: 0 }),
  };
  const counts = await checkBullMQQueueCounts(fakeQueue, 500);
  check('queue counts parsed', counts?.waiting === 3 && counts?.active === 1 && counts?.failed === 2 && counts?.delayed === 0);

  const rejectingQueue = {
    getJobCounts: async () => {
      throw new Error('redis down');
    },
  };
  const rejected = await checkBullMQQueueCounts(rejectingQueue, 500);
  check('queue counts null on failure', rejected === null);

  const hangingQueue = {
    getJobCounts: () => new Promise(() => {}),
  };
  const hung = await checkBullMQQueueCounts(hangingQueue, 150);
  check('queue counts null on hang', hung === null);
  return success;
}

async function testProcessStats(): Promise<boolean> {
  setProcessStat('test-stats', 'lastCrawlAt', '2026-01-01T00:00:00.000Z');
  setProcessStat('test-stats', 'running', true);
  const stats = getProcessStats('test-stats');
  check('stats registry roundtrip', stats.lastCrawlAt === '2026-01-01T00:00:00.000Z' && stats.running === true);
  const unknown = getProcessStats('never-registered');
  check('unknown process stats are empty', Object.keys(unknown).length === 0);
  return success;
}

async function testHealthServerHttp(): Promise<boolean> {
  const server = startHealthServer('test-http', 0, {
    checks: {
      fakeOk: async () => true,
      fakeDown: async () => false,
    },
    details: async () => ({ marker: 'present' }),
  });

  const same = startHealthServer('test-http', 0, {
    checks: { fakeOk: async () => true },
  });
  check('startHealthServer is idempotent per process', server === same);

  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;

  const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
  const body: any = await healthRes.json();
  check('GET /health returns 200', healthRes.status === 200);
  check('GET /health returns no-store', (healthRes.headers.get('cache-control') || '').includes('no-store'));
  check('GET /health payload status ok', body.status === 'ok');
  check('GET /health payload process', body.process === 'test-http');
  check('GET /health payload version', body.version === SERVICE_VERSION);
  check('GET /health payload dep ok', body.dependencies?.fakeOk === 'ok');
  check('GET /health payload dep down', body.dependencies?.fakeDown === 'unavailable');
  check('GET /health payload details', body.details?.marker === 'present');

  const healthzRes = await fetch(`http://127.0.0.1:${port}/healthz`);
  check('GET /healthz returns 200', healthzRes.status === 200);

  const nopeRes = await fetch(`http://127.0.0.1:${port}/nope`);
  check('unknown path returns 404', nopeRes.status === 404);

  stopHealthServer('test-http');
  await new Promise<void>((resolve) => server.once('close', resolve));
  return success;
}

async function runHealthTests(): Promise<boolean> {
  const suites: Array<() => Promise<boolean>> = [
    testWithTimeout,
    testBuildHealthPayload,
    testCheckRedisRefused,
    testCheckPostgresRefused,
    testCheckSupabaseOffline,
    testCheckTemporalOffline,
    testCheckAIProviderConfigured,
    testCheckBullMQQueueCounts,
    testProcessStats,
    testHealthServerHttp,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[Health Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHealthTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
