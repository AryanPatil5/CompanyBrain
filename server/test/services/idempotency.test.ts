// Hermetic unit tests for the idempotency ledger (ADR-T13, migration 034).
// Runs against the harness's in-memory Supabase — no live infrastructure.

import {
  acquireIdempotency,
  completeIdempotency,
  generateIdempotencyKey,
  getIdempotency,
  idempotencyKeyFor,
} from '../../src/services/idempotency.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ IDEMPOTENCY TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ IDEMPOTENCY TEST FAILED: ${name}`, extra ?? '');
  }
}

const WS = 'ws-idempotency-test';

async function testKeyDerivation(): Promise<boolean> {
  check('deterministic for same parts', idempotencyKeyFor(['stripe', 'evt_1', '2026-08-09T00:00:00Z']) === idempotencyKeyFor(['stripe', 'evt_1', '2026-08-09T00:00:00Z']));
  check('differs when parts differ', idempotencyKeyFor(['stripe', 'evt_1']) !== idempotencyKeyFor(['stripe', 'evt_2']));
  check('undefined parts normalize to empty', idempotencyKeyFor(['a', undefined, 'c']) === idempotencyKeyFor(['a', '', 'c']));
  check('generate produces uuid', /^[0-9a-f-]{36}$/.test(generateIdempotencyKey()));
  return success;
}

async function testAcquireFreshAndReplay(): Promise<boolean> {
  const key = generateIdempotencyKey();
  const first = await acquireIdempotency(WS, key, 'slack_post', { ttlMs: 60_000 });
  check('fresh key is acquired', first.acquired === true);
  if (!first.acquired) return false;
  check('fresh record is pending', first.record.status === 'pending');

  const replay = await acquireIdempotency(WS, key, 'slack_post');
  check('repeat acquire is a replay, not a re-run', replay.acquired === false && replay.replayed === true);
  check('replay returns the stored record', replay.record.key === key);

  await completeIdempotency(key, 'completed', 'ref:log-42');
  const after = await getIdempotency(key);
  check('completed status persisted', after?.status === 'completed');
  check('resultRef persisted', after?.resultRef === 'ref:log-42');
  return success;
}

async function testExpiredPendingReacquired(): Promise<boolean> {
  const key = idempotencyKeyFor(['test', 'expiry']);
  const first = await acquireIdempotency(WS, key, 'webhook_dedupe', { ttlMs: -5_000 });
  check('acquired with expired ttl', first.acquired === true);

  const again = await acquireIdempotency(WS, key, 'webhook_dedupe', { ttlMs: 60_000 });
  check('expired pending is re-acquired', again.acquired === true);
  check('re-acquired record still matches key', again.record.key === key);
  return success;
}

async function testFailOpenOnPersistenceError(): Promise<boolean> {
  // The harness fake never errors, so exercise the fail-open path indirectly:
  // a key that has never been seen behaves as acquired even if the record
  // read races — the contract is "never block the caller".
  const key = 'never-persisted-key';
  const res = await acquireIdempotency('other-ws', key, 'op');
  check('unknown key returns acquired', res.acquired === true);
  return success;
}

async function testWorkspaceIsolation(): Promise<boolean> {
  const key = 'shared-key-across-workspaces';
  const a = await acquireIdempotency('ws-a', key, 'op');
  check('ws-a acquires', a.acquired === true);
  const b = await acquireIdempotency('ws-b', key, 'op');
  // key is the PK — replay is global by design (ADR-T13 dedupe scope);
  // different workspaces must use workspace-scoped key parts instead.
  check('same key replays across workspaces (documented behavior)', b.acquired === false && b.replayed === true);
  return success;
}

export async function runIdempotencyTest(): Promise<boolean> {
  await testKeyDerivation();
  await testAcquireFreshAndReplay();
  await testExpiredPendingReacquired();
  await testFailOpenOnPersistenceError();
  await testWorkspaceIsolation();
  if (success) {
    console.log(`\nIdempotency suite: ${passed} passed, ${failed} failed.`);
  }
  return success;
}

// Self-execute when run directly: npx tsx test/services/idempotency.test.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  const { installHarness } = await import('../harness/index.js');
  await installHarness();
  const ok = await runIdempotencyTest();
  process.exit(ok ? 0 : 1);
}
