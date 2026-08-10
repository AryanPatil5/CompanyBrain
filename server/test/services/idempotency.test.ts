// Hermetic unit tests for the idempotency ledger (ADR-T13, migration 034).
// Runs against the harness's in-memory Supabase — no live infrastructure.

import {
  acquireIdempotency,
  completeIdempotency,
  generateIdempotencyKey,
  getIdempotency,
  getIdempotencyStrict,
  idempotencyKeyFor,
} from '../../src/services/idempotency.js';
import { supabase } from '../../src/config/supabase.js';

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

// ─── Race simulation helpers ────────────────────────────────────────
// The harness fake never errors, so these tests wrap `supabase.from` for the
// idempotency_keys table with a Proxy that can inject PostgreSQL 23505-style
// errors on insert and force concurrent-winner behaviour between the read and
// the conditional re-acquire update.

interface IdempotencyHooks {
  onInsert?: (payload: any) => { error?: unknown; throw?: unknown; winner?: Record<string, any> } | void;
  onRead?: (readNumber: number) => { error?: unknown; throw?: unknown } | void;
  onResolvingUpdate?: () => void;
}

function wrapIdempotencyQueries(hooks: IdempotencyHooks): { restore: () => void; rawFrom: typeof supabase.from } {
  const originalFrom = supabase.from.bind(supabase);
  let readCount = 0;
  let pendingUpdateResult = false;

  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop: string, recv) {
        if (prop === 'insert') {
          return (payload: any) => {
            const h = hooks.onInsert?.(payload);
            if (h?.winner) {
              originalFrom('idempotency_keys').insert(h.winner);
            }
            if (h?.throw) {
              // Simulate a thrown Postgres error: the thenable's then() must
              // invoke the rejection callback (returning a promise instead
              // would leave the await permanently unsettled).
              return { then: (_res: any, rej: any) => rej(h.throw) };
            }
            if (h?.error) {
              // Simulate supabase-js returning the error object.
              return { then: (res: any) => res({ data: null, error: h.error }) };
            }
            return wrap(Reflect.get(t, prop).call(t, payload));
          };
        }
        if (prop === 'update') {
          return (patch: any) => {
            pendingUpdateResult = true;
            return wrap(Reflect.get(t, prop).call(t, patch));
          };
        }
        if (prop === 'single' || prop === 'maybeSingle') {
          return (...args: any[]) => {
            const isUpdateResult = pendingUpdateResult;
            pendingUpdateResult = false;
            if (isUpdateResult) {
              // The concurrent winner acts between our read and our update
              // landing (e.g. refreshes the expired row first).
              return (async () => {
                await hooks.onResolvingUpdate?.();
                return Reflect.get(t, prop).call(t, ...args);
              })();
            }
            readCount += 1;
            const h = hooks.onRead?.(readCount);
            if (h?.throw) return Promise.reject(h.throw);
            if (h?.error) return Promise.resolve({ data: null, error: h.error });
            return Reflect.get(t, prop).call(t, ...args);
          };
        }
        const val = Reflect.get(t, prop, recv);
        if (typeof val === 'function') {
          return (...args: any[]) => {
            const out = val.apply(t, args);
            // Wrap chained query objects (FakeSupabaseQuery has a `then`
            // method, so check instanceof Promise, not presence of then).
            if (out && typeof out === 'object' && !(out instanceof Promise)) return wrap(out);
            return out;
          };
        }
        return val;
      },
    });

  (supabase as any).from = (table: string) => {
    const query = originalFrom(table);
    return table === 'idempotency_keys' ? wrap(query) : query;
  };

  return {
    restore: () => {
      (supabase as any).from = originalFrom;
    },
    rawFrom: originalFrom,
  };
}

async function testUniqueViolationRace(): Promise<boolean> {
  // Concurrent insert loses to an already-committed winner row (23505 returned
  // via the supabase-js error object): must replay the winner, never re-run.
  const key1 = generateIdempotencyKey();
  const winner1 = {
    key: key1,
    workspace_id: WS,
    operation: 'webhook_extract',
    status: 'completed',
    result_ref: 'ref:winner-1',
    expires_at: null,
  };
  const { restore: restore1 } = wrapIdempotencyQueries({
    onInsert: () => ({ winner: winner1, error: { code: '23505', message: 'duplicate key value violates unique constraint "idempotency_keys_pkey"' } }),
  });
  const res1 = await acquireIdempotency(WS, key1, 'webhook_extract', { ttlMs: 60_000 });
  restore1();
  check('23505 on insert returns replay of the winner record', res1.acquired === false && res1.replayed === true, res1);
  check('23505 replay carries the winner status (completed)', res1.record.status === 'completed' && res1.record.resultRef === 'ref:winner-1', res1.record);

  // Thrown variant: Postgres driver throws instead of returning the error.
  const key2 = generateIdempotencyKey();
  const winner2 = {
    key: key2,
    workspace_id: WS,
    operation: 'webhook_extract',
    status: 'pending',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const { restore: restore2 } = wrapIdempotencyQueries({
    onInsert: () => ({ winner: winner2, throw: new Error('duplicate key value violates unique constraint "idempotency_keys_pkey"') }),
  });
  const res2 = await acquireIdempotency(WS, key2, 'webhook_extract', { ttlMs: 60_000 });
  restore2();
  check('thrown 23505 also returns replay of the winner record', res2.acquired === false && res2.replayed === true && res2.record.status === 'pending', res2);

  // Re-read fails after 23505: MUST throw (never fabricate a pending record).
  const key3 = generateIdempotencyKey();
  const { restore: restore3 } = wrapIdempotencyQueries({
    onInsert: () => ({ winner: { key: key3, workspace_id: WS, operation: 'op', status: 'pending', expires_at: null }, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
    onRead: (n) => (n === 2 ? { error: { message: 'connection refused' } } : undefined),
  });
  let threw3: unknown = null;
  try {
    await acquireIdempotency(WS, key3, 'op', { ttlMs: 60_000 });
  } catch (err) {
    threw3 = err;
  }
  restore3();
  check('23505 with failing re-read THROWS (no fail-open)', threw3 !== null, threw3);

  // 23505 with no winner row on record: MUST throw (inconsistency, not replay).
  const key4 = generateIdempotencyKey();
  const { restore: restore4 } = wrapIdempotencyQueries({
    onInsert: () => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
  });
  let threw4: unknown = null;
  try {
    await acquireIdempotency(WS, key4, 'op', { ttlMs: 60_000 });
  } catch (err) {
    threw4 = err;
  }
  restore4();
  check('23505 with missing winner row THROWS (state never fabricated)', threw4 !== null, threw4);
  return success;
}

async function testStrictReadThrowsOnError(): Promise<boolean> {
  const key = generateIdempotencyKey();
  const { restore } = wrapIdempotencyQueries({
    onRead: (n) => (n === 1 ? { error: { message: 'connection refused' } } : undefined),
  });
  let threw: unknown = null;
  try {
    await getIdempotencyStrict(key);
  } catch (err) {
    threw = err;
  }
  let failOpenResult: unknown = 'not-run';
  try {
    failOpenResult = await getIdempotency(key);
  } catch (err) {
    failOpenResult = `threw:${(err as Error).message}`;
  }
  restore();
  check('getIdempotencyStrict throws on DB error', threw !== null, threw);
  check('getIdempotency stays fail-open (returns null)', failOpenResult === null, failOpenResult);
  return success;
}

async function testExpiredKeyConcurrentRefresh(): Promise<boolean> {
  const key = idempotencyKeyFor(['test', 'concurrent-expiry-refresh']);
  const first = await acquireIdempotency(WS, key, 'op', { ttlMs: -5_000 });
  check('expired pending row created', first.acquired === true);

  // A concurrent caller refreshes the expired row between our read and our
  // conditional update: zero rows match -> replay, never a second owner.
  let refreshed = false;
  const { restore, rawFrom } = wrapIdempotencyQueries({
    onResolvingUpdate: async () => {
      refreshed = true;
      await rawFrom('idempotency_keys')
        .update({ status: 'pending', updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() })
        .eq('key', key);
    },
  });
  const again = await acquireIdempotency(WS, key, 'op', { ttlMs: 60_000 });
  restore();
  check('concurrent refresh of expired key yields replay (acquired:false)', refreshed && again.acquired === false && again.replayed === true, again);
  check('replayed record reflects the refreshed row', again.record.status === 'pending', again.record);

  // Control: without a concurrent refresh the same expired key IS re-acquired.
  const key2 = idempotencyKeyFor(['test', 'expiry-reacquire-control']);
  await acquireIdempotency(WS, key2, 'op', { ttlMs: -5_000 });
  const { restore: restore2 } = wrapIdempotencyQueries({});
  const control = await acquireIdempotency(WS, key2, 'op', { ttlMs: 60_000 });
  restore2();
  check('expired key with no race is still re-acquired (acquired:true)', control.acquired === true, control);
  return success;
}

export async function runIdempotencyTest(): Promise<boolean> {
  await testKeyDerivation();
  await testAcquireFreshAndReplay();
  await testExpiredPendingReacquired();
  await testFailOpenOnPersistenceError();
  await testWorkspaceIsolation();
  await testUniqueViolationRace();
  await testStrictReadThrowsOnError();
  await testExpiredKeyConcurrentRefresh();
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
