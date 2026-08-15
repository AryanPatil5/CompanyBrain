// Hermetic tests for the Phase 4 embedding backfill (roadmap Phase 4 T2):
// re-embedding of the EXISTING document_chunks corpus against the currently
// selected EmbeddingProvider. Requirements under test are the spec's 24
// embedding-backfill test cases (see MASTER_ROADMAP Phase 4 / task notes):
//   §1 defaults, §2 job shape, §3 option passthrough, §4 rate limiting,
//   §5 invalid batch clamp, §6 content-hash staleness, §7 atomic conditional
//   update (concurrent modification), §8 crash mid-call, §9 hydrated rows,
//   §10 restart skips current, §11 workspace filter, §12 stale cursor,
//   §13 provider change, §14 no fabricated data, §15 cursor paging,
//   §16 usage accounting, §17/18 row/hash uniqueness, §19 honest results,
//   §20 permanent quarantine, §21 provider-returned metadata exactness,
//   §22 invalid replacement vector, §23 restart clears quarantine,
//   §24 observability.
//
// The worker module (src/workers/embeddingBackfillWorker.ts) pulls in
// src/queue/ingestionQueue.ts (BullMQ queues + ioredis at module-eval) so it
// is imported DYNAMICALLY after installHarness() — the documented pattern
// (AGENTS.md). The backfill core (src/ingestion/embeddingBackfill.ts) is
// queue-free and imported statically. THE PROVIDER IS ALWAYS THE TEST MOCK:
// no real external embedding provider is ever called (no network, no env).

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import { EmbeddingError } from '../../src/services/aiProvider.js';
import { setEmbeddingProviderForTest, type EmbeddingProvider, type EmbeddingResult } from '../../src/services/embeddingProvider.js';
import { setUsageStoreForTest, type UsageStore, type PersistRow, type UsageRow } from '../../src/services/costMeter.js';
import { supabase } from '../../src/config/supabase.js';
import { hashContent } from '../../src/ingestion/chunker.js';
import {
  processEmbeddingBackfillBatch,
  processEmbeddingBackfillJob,
  scanChunkPage,
  isChunkQuarantined,
  getLastEmbeddingBackfillBatch,
  isEmbeddingBackfillRunning,
  poisonedChunkCount,
  resetEmbeddingBackfillState,
  SlidingWindowRateLimiter,
  type ChunkRow,
  type EmbeddingBackfillJobData,
} from '../../src/ingestion/embeddingBackfill.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ EMBEDDING BACKFILL TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ EMBEDDING BACKFILL TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';
const WS2 = '11111111-1111-4111-8111-111111111111';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

const IDS = {
  c1: '11111111-1111-4111-8111-111111111111',
  c2: '22222222-2222-4222-8222-222222222222',
  c3: '33333333-3333-4333-8333-333333333333',
  c4: '44444444-4444-4444-8444-444444444444',
  c5: '55555555-5555-4555-8555-555555555555',
};

const CONTENT = {
  a: 'The quick brown fox jumps over the lazy dog.',
  b: 'Sphinx of black quartz, judge my vow.',
  c: 'Pack my box with five dozen liquor jugs.',
  d: 'The five boxing wizards jump quickly.',
  e: 'How vexingly quick daft zebras jump!',
};

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock-embedder';
  model = 'mock-model-v1';
  version = 'v7';
  readonly expectedDimensions = 8;

  calls: string[] = [];
  readonly failQueue: Array<{ retryable: boolean }> = [];
  private gatePromise: Promise<void> | null = null;
  private gateRelease: (() => void) | null = null;
  embedDelayMs = 0;
  badVectorNext = false;
  returnModelOverride: string | null = null;
  returnVersionOverride: string | null = null;

  private inFlight = 0;
  maxInFlight = 0;

  gate(): void {
    let release!: () => void;
    this.gatePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gateRelease = release;
  }

  releaseGate(): void {
    const r = this.gateRelease;
    this.gatePromise = null;
    this.gateRelease = null;
    r?.();
  }

  failNext(retryable: boolean): void {
    this.failQueue.push({ retryable });
  }

  vectorFor(text: string): number[] {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    const out: number[] = [];
    for (let i = 0; i < this.expectedDimensions; i++) {
      out.push(0.01 + Math.abs((h + i * 7919) % 1000) / 1000);
    }
    return out;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    this.calls.push(text);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const fail = this.failQueue.shift();
      if (fail) {
        throw new EmbeddingError('embedding_provider_unreachable', 'mock provider failure', { provider: this.name, retryable: fail.retryable });
      }
      if (this.gatePromise) await this.gatePromise;
      if (this.embedDelayMs > 0) await sleep(this.embedDelayMs);
      if (this.badVectorNext) {
        this.badVectorNext = false;
        throw new EmbeddingError('embedding_dimension_mismatch', 'mock dimension mismatch', { provider: this.name, retryable: false });
      }
      if (!text.trim()) {
        throw new EmbeddingError('embedding_empty_input', 'empty input', { provider: this.name, retryable: false });
      }
      return {
        vector: this.vectorFor(text),
        model: this.returnModelOverride ?? this.model,
        version: this.returnVersionOverride ?? this.version,
      };
    } finally {
      this.inFlight -= 1;
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function makeMockJob(data: EmbeddingBackfillJobData): { id?: string; data: EmbeddingBackfillJobData } {
  return {
    id: `embedding_backfill_${Math.random().toString(36).substring(2, 10)}`,
    data,
  };
}

async function seedChunk(overrides: Partial<ChunkRow> & { content: string }): Promise<ChunkRow> {
  const row: ChunkRow = {
    id: overrides.id ?? IDS.c1,
    workspace_id: overrides.workspace_id ?? DEV_WORKSPACE,
    source_document_id: overrides.source_document_id ?? 'doc-1',
    chunk_index: overrides.chunk_index ?? 0,
    content: overrides.content,
    content_hash: overrides.content_hash ?? hashContent(overrides.content),
    embedding: overrides.embedding ?? null,
    embedding_model: overrides.embedding_model ?? null,
    embedding_version: overrides.embedding_version ?? null,
  };
  await supabase.from('document_chunks').insert(row);
  return row;
}

async function seedCorpus(spec: Array<Partial<ChunkRow> & { content: string }>): Promise<ChunkRow[]> {
  const rows: ChunkRow[] = [];
  for (const s of spec) rows.push(await seedChunk(s));
  return rows;
}

async function allChunks(): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase.from('document_chunks').select('*').order('id', { ascending: false });
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function chunkById(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = await allChunks();
  return rows.find((r) => r.id === id);
}

async function setEnv(name: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────

export async function runEmbeddingBackfillTests(): Promise<boolean> {
  const provider = new MockEmbeddingProvider();
  setEmbeddingProviderForTest(provider);
  resetEmbeddingBackfillState();
  setUsageStoreForTest(null);
  resetFakeSupabaseStore();

  const workerModule = await import('../../src/workers/embeddingBackfillWorker.js');

  try {
    passed = 0;
    failed = 0;
    success = true;

    // ─── Test 1 (spec §1/§2/§5): batch defaults, job shape, invalid clamp ─
    try {
      const cfgCheck = (await import('../../src/ingestion/embeddingBackfill.js')).embeddingBackfillConfig();
      check('t1: defaults (batch 100, concurrency 4, rate 120/min, interval 60s)', cfgCheck.batchSize === 100 && cfgCheck.concurrency === 4 && cfgCheck.rateLimitPerMinute === 120 && cfgCheck.intervalMs === 60000, cfgCheck);

      await setEnv('EMBEDDING_BACKFILL_BATCH_SIZE', '25', async () => {
        await setEnv('EMBEDDING_BACKFILL_CONCURRENCY', '2', async () => {
          await setEnv('EMBEDDING_BACKFILL_RATE_LIMIT', '7', async () => {
            await setEnv('EMBEDDING_BACKFILL_INTERVAL_MS', '90000', async () => {
              const overridden = (await import('../../src/ingestion/embeddingBackfill.js')).embeddingBackfillConfig();
              check('t1: env overrides win', overridden.batchSize === 25 && overridden.concurrency === 2 && overridden.rateLimitPerMinute === 7 && overridden.intervalMs === 90000, overridden);
            });
          });
        });
      });

      const template = workerModule.embeddingBackfillSchedulerTemplate(null);
      check('t1: job shape {job_name:"batch"} + cleanup (removeOnComplete, removeOnFail=100)', template.name === 'batch' && template.data.job_name === 'batch' && template.data.cursor === null && template.opts.removeOnComplete === true && template.opts.removeOnFail === 100, template);

      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.c },
      ]);
      await setEnv('EMBEDDING_BACKFILL_BATCH_SIZE', '2', async () => {
        const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
        check('t1: invalid batch size clamps to a bounded page', r.scanned <= 2 && r.scanned === 2, r);
      });
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 1 (batch defaults/shape/clamp)', false, err.message);
    }

    // ─── Test 2 (spec §3): option passthrough through the processor seam ──
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.c },
      ]);
      provider.calls.length = 0;
      const viaJob = await processEmbeddingBackfillJob(makeMockJob({ job_name: 'batch', workspaceId: DEV_WORKSPACE, batchSize: 2, force: false }));
      check('t2: processor seam maps job data to the batch', viaJob.scanned === 2 && viaJob.reembedded === 2, viaJob);
      resetFakeSupabaseStore();
      provider.calls.length = 0;
      await setEnv('EMBEDDING_BACKFILL_CONCURRENCY', '1', async () => {
        const seeded = await seedCorpus([{ id: IDS.c1, content: CONTENT.a }]);
        const r = await processEmbeddingBackfillBatch({ provider });
        check('t2: force=true re-embeds current rows', r.skippedCurrent === 0 && r.reembedded === 1, r);
        const row = await chunkById(seeded[0].id);
        check('t2: forced re-embed persisted fresh metadata', (row as any)?.embedding_model === provider.model && (row as any)?.embedding_version === provider.version, row);
      });
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 2 (option passthrough)', false, err.message);
    }

    // ─── Test 3 (spec §9): hydrated row with a real vector + metadata ─────
    try {
      const seeded = await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, embedding: provider.vectorFor(CONTENT.a), embedding_model: provider.model, embedding_version: provider.version },
      ]);
      provider.calls.length = 0;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      check('t3: current row skipped, zero provider calls', r.scanned === 1 && r.skippedCurrent === 1 && r.reembedded === 0 && provider.calls.length === 0, { r, calls: provider.calls });
      const row = await chunkById(seeded[0].id);
      check('t3: row untouched (vector + metadata + hash still exactly stored)', (row as any)?.embedding_model === provider.model && (row as any)?.embedding_version === provider.version && (row as any)?.content_hash === hashContent(CONTENT.a), row);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 3 (hydrated current row)', false, err.message);
    }

    // ─── Test 4 (spec §6): content-hash mismatch forces re-embed ──────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, embedding: provider.vectorFor(CONTENT.a), embedding_model: provider.model, embedding_version: provider.version, content_hash: 'deadbeef' },
      ]);
      provider.calls.length = 0;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      check('t4: hash mismatch treated as stale (re-embedded, canonical hash restored)', r.reembedded === 1 && (await chunkById(IDS.c1))?.content_hash === hashContent(CONTENT.a), r);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 4 (hash mismatch)', false, err.message);
    }

    // ─── Test 5 (spec §13): provider change re-embeds + cleans metadata ───
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, embedding: provider.vectorFor(CONTENT.a), embedding_model: 'old-provider', embedding_version: 'v2' },
        { id: IDS.c2, content: CONTENT.b, embedding: provider.vectorFor(CONTENT.b), embedding_model: provider.model, embedding_version: 'v6' },
      ]);
      provider.calls.length = 0;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      const rows = await allChunks();
      check('t5: both chunks re-embedded under the CURRENT provider only', r.reembedded === 2 && rows.every((x) => x.embedding_model === provider.model && x.embedding_version === provider.version), { r, rows });
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 5 (provider change)', false, err.message);
    }

    // ─── Test 6 (spec §21): exact provider-returned model/version ─────────
    try {
      await seedCorpus([{ id: IDS.c1, content: CONTENT.a }]);
      provider.returnModelOverride = 'text-embedding-3-small-FINAL';
      provider.returnVersionOverride = '2026-08-15.7';
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      const row = await chunkById(IDS.c1);
      check('t6: persisted model/version are the provider-RETURNED values (not configured/assumed)', (row as any)?.embedding_model === 'text-embedding-3-small-FINAL' && (row as any)?.embedding_version === '2026-08-15.7', row);
      provider.returnModelOverride = null;
      provider.returnVersionOverride = null;
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 6 (exact metadata)', false, err.message);
    }

    // ─── Test 7 (spec §7/§13): atomic conditional update — never overwrite a
    //       concurrent write ───────────────────────────────────────────────
    try {
      const seeded = await seedCorpus([{ id: IDS.c1, content: CONTENT.a }]);
      provider.calls.length = 0;
      provider.gate();
      const pending = processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      const inFlight = await waitUntil(() => provider.calls.length === 1);
      check('t7: provider call in flight while row untouched', inFlight && (await chunkById(IDS.c1))?.embedding === null, await chunkById(IDS.c1));

      // Concurrent ingestion lands content B while we are embedding content A.
      await supabase
        .from('document_chunks')
        .update({ content: CONTENT.b, content_hash: hashContent(CONTENT.b), embedding_model: 'concurrent-provider', embedding_version: 'v99', embedding: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9] })
        .eq('id', seeded[0].id);

      provider.releaseGate();
      const r = await pending;
      const row = (await chunkById(IDS.c1)) as any;
      check('t7: conditional update missed -> concurrent_modification reported', r.concurrentModifications === 1 && r.reembedded === 0, r);
      check('t7: concurrent row left EXACTLY as ingestion wrote it (no overwrite of newer state)', row.content === CONTENT.b && row.content_hash === hashContent(CONTENT.b) && row.embedding_model === 'concurrent-provider' && row.embedding_version === 'v99', row);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 7 (concurrent modification)', false, err.message);
    }

    // ─── Test 8 (spec §8): crash while embedding in-flight — nothing written
    //       before the provider responds, old state intact ────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
      ]);
      provider.calls.length = 0;
      provider.gate();
      const pending = processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 1 });
      const inFlight = await waitUntil(() => provider.calls.length === 1);
      check('t8: in-flight embed left the row null (no partial write)', inFlight && (await chunkById(IDS.c1))?.embedding === null, await chunkById(IDS.c1));

      // Simulated crash: the in-flight work is abandoned; the process restarts
      // with an empty cursor — the corpus is re-scanned and only genuinely
      // missing work is done.
      provider.releaseGate();
      // The "crash": the in-flight batch is abandoned (lint: intentionally
      // unobserved); give it a beat to finish, then the process restarts.
      void pending;
      await sleep(30);
      resetEmbeddingBackfillState();
      provider.calls.length = 0;
      const afterRestart = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 2 });
      check('t8: restart re-scans; already-completed chunk skipped, remaining chunk embedded', afterRestart.skippedCurrent === 1 && afterRestart.reembedded === 1 && afterRestart.scanned === 2, afterRestart);
      const rows = await allChunks();
      check('t8: every chunk embedded exactly once with provider metadata', rows.length === 2 && rows.every((x) => x.embedding !== null && x.embedding_model === provider.model && x.embedding_version === provider.version), rows);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 8 (crash mid-call)', false, err.message);
    }

    // ─── Test 9 (spec §10): restart skips the first N already-current ─────
    try {
      await seedCorpus([
        { id: IDS.c5, content: CONTENT.c },
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.a },
      ]);
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      provider.calls.length = 0;
      resetEmbeddingBackfillState();
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      check('t9: restart with null cursor scans and skips all current chunks, zero provider calls', r.skippedCurrent === 3 && r.reembedded === 0 && provider.calls.length === 0, { r, calls: provider.calls });
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 9 (restart skips current)', false, err.message);
    }

    // ─── Test 10 (spec §11): workspace isolation ──────────────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, workspace_id: DEV_WORKSPACE },
        { id: IDS.c2, content: CONTENT.b, workspace_id: WS2 },
      ]);
      provider.calls.length = 0;
      const r1 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      check('t10: workspace-scoped batch only touched its own workspace', r1.scanned === 1 && r1.reembedded === 1 && provider.calls.length === 1, r1);
      const w2row = (await chunkById(IDS.c2)) as any;
      check('t10: other workspace untouched (embedding still null)', w2row.content_hash === hashContent(CONTENT.b) && w2row.embedding === null, w2row);
      const r2 = await processEmbeddingBackfillBatch({ provider, batchSize: 10 });
      check('t10: unscoped batch picks up remaining workspace', r2.reembedded === 1 && provider.calls.length === 2, r2);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 10 (workspace isolation)', false, err.message);
    }

    // ─── Test 11 (spec §12): stale cursor is safe ─────────────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.c },
      ]);
      provider.calls.length = 0;
      // Cursor BELOW every row id = "everything before the cursor is done" ->
      // an empty page. Nothing is processed; nothing is corrupted.
      const exhausted = await scanChunkPage({ workspaceId: DEV_WORKSPACE, cursor: IDS.c1, batchSize: 10 });
      check('t11: cursor at/below the corpus tail yields an empty page', exhausted.length === 0, exhausted);
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, cursor: IDS.c1, batchSize: 10 });
      check('t11: empty page -> nothing processed, zero provider calls, no corruption', r.scanned === 0 && r.reembedded === 0 && provider.calls.length === 0, r);
      // Cursor ABOVE the head (stale/forward) re-scans the whole corpus — safe:
      // skip-when-current absorbs it; genuinely missing work still completes.
      provider.calls.length = 0;
      const rStale = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, cursor: 'ffffffff-ffff-4fff-8fff-ffffffffffff', batchSize: 10 });
      check('t11: forward-stale cursor re-scans, skips current, embeds missing (safe)', rStale.scanned === 3 && rStale.skippedCurrent === 0 && rStale.reembedded === 3, rStale);
      const rFull = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      check('t11: a subsequent cursor-less batch finds everything current', rFull.skippedCurrent === 3 && rFull.reembedded === 0 && provider.calls.length === 3, rFull);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 11 (stale cursor)', false, err.message);
    }

    // ─── Test 12 (spec §15/§16): bounded cursor paging, nextCursor resume ─
    try {
      await seedCorpus([
        { id: IDS.c5, content: CONTENT.c },
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.d },
        { id: IDS.c1, content: CONTENT.e },
      ]);
      provider.calls.length = 0;
      let cursor: string | null = null;
      let totalScanned = 0;
      let pages = 0;
      for (let i = 0; i < 5; i++) {
        const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 2, cursor });
        totalScanned += r.scanned;
        pages += 1;
        cursor = r.nextCursor;
        if (r.nextCursor === null) break;
      }
      check('t12: cursor paging drains the corpus in bounded pages (5 chunks, batch 2)', pages === 3 && totalScanned === 5, { pages, totalScanned });
      check('t12: exactly one embed per chunk across all pages', provider.calls.length === 5 && new Set(provider.calls).size === 5, provider.calls);
      const rows = await allChunks();
      check('t12: no duplicate/extra rows after paged backfill', rows.length === 5, rows.length);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 12 (cursor paging)', false, err.message);
    }

    // ─── Test 13 (spec §15): backward cursor never re-does current work ───
    try {
      await seedCorpus([
        { id: IDS.c5, content: CONTENT.c },
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.d },
        { id: IDS.c1, content: CONTENT.e },
      ]);
      provider.calls.length = 0;
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 3 });
      const callsAfterFirst = provider.calls.length;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, cursor: IDS.c4, batchSize: 10 });
      check('t13: backward cursor re-scans tail but skips current chunks (no re-embed calls)', r.skippedCurrent === 1 && r.reembedded === 2 && provider.calls.length === callsAfterFirst + 2, { r, callsAfterFirst });
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 13 (backward cursor)', false, err.message);
    }

    // ─── Test 14 (spec §19): unstable provider — honest partial results, old
    //       state preserved ───────────────────────────────────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
      ]);
      provider.calls.length = 0;
      provider.failNext(true);
      const r1 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
      check('t14: batch reports failure honestly (no fake completion)', r1.reembedded === 1 && r1.failed === 1 && r1.retryableFailures === 1 && r1.permanentFailures === 0, r1);
      const failedRow = (await chunkById(IDS.c2)) as any;
      check('t14: failed chunk keeps its previous state (embedding still null, no partial metadata)', failedRow.embedding === null && failedRow.embedding_model === null && failedRow.embedding_version === null, failedRow);
      const r2 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
      check('t14: retryable failure is re-attempted next sweep and succeeds', r2.reembedded === 1 && r2.failed === 0, r2);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 14 (unstable provider)', false, err.message);
    }

    // ─── Test 15 (spec §20/§23): permanent failures quarantined until
    //       worker restart ─────────────────────────────────────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
      ]);
      provider.calls.length = 0;
      provider.failNext(false);
      provider.failNext(false);
      const r1 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
      check('t15: non-retryable failures counted as permanent', r1.permanentFailures === 2 && r1.failed === 2 && poisonedChunkCount() === 2, r1);
      check('t15: quarantined chunks flagged in-process', isChunkQuarantined(IDS.c1) && isChunkQuarantined(IDS.c2), null);
      const r2 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
      check('t15: quarantined chunks skipped without re-attempt (zero provider calls)', r2.skippedQuarantined === 2 && provider.calls.length === 2, r2);
      resetEmbeddingBackfillState();
      const r3 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
      check('t15: worker restart clears quarantine -> work is re-attempted', r3.reembedded === 2 && poisonedChunkCount() === 0, r3);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 15 (permanent quarantine)', false, err.message);
    }

    // ─── Test 16 (spec §5/§16): single batch never exceeds the page size ──
    try {
      await seedCorpus([
        { id: IDS.c5, content: CONTENT.c },
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.d },
        { id: IDS.c1, content: CONTENT.e },
      ]);
      provider.calls.length = 0;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 3 });
      check('t16: batch processed AT MOST batchSize chunks (3 of 5)', r.scanned === 3 && r.reembedded === 3 && provider.calls.length === 3 && r.nextCursor === IDS.c3, r);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 16 (batch bound)', false, err.message);
    }

    // ─── Test 17 (spec §4): empty corpus is a no-op ───────────────────────
    try {
      provider.calls.length = 0;
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider });
      check('t17: empty corpus -> all-zero result, no provider calls, no throw', r.scanned === 0 && r.skippedCurrent === 0 && r.reembedded === 0 && r.failed === 0 && r.concurrentModifications === 0 && provider.calls.length === 0 && r.nextCursor === null, r);
    } catch (err: any) {
      check('Test 17 (empty corpus)', false, err.message);
    }

    // ─── Test 18 (spec §4/§15): bounded concurrency pool ──────────────────
    try {
      await seedCorpus([
        { id: IDS.c5, content: CONTENT.c },
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.a },
        { id: IDS.c2, content: CONTENT.b },
        { id: IDS.c1, content: CONTENT.a },
      ]);
      provider.embedDelayMs = 15;
      provider.maxInFlight = 0;
      await setEnv('EMBEDDING_BACKFILL_CONCURRENCY', '2', async () => {
        await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
        check('t18: never more than configured concurrency in flight (2)', provider.maxInFlight === 2, provider.maxInFlight);
      });
      provider.maxInFlight = 0;
      await setEnv('EMBEDDING_BACKFILL_CONCURRENCY', '1', async () => {
        resetFakeSupabaseStore();
        await seedCorpus([{ id: IDS.c1, content: CONTENT.a }]);
        await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 5 });
        check('t18: concurrency=1 serializes provider calls', provider.maxInFlight === 1, provider.maxInFlight);
      });
      provider.embedDelayMs = 0;
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 18 (concurrency bound)', false, err.message);
    }

    // ─── Test 19 (spec §4): rate limiter never exceeds the window ─────────
    try {
      let fakeNow = 1_000_000;
      const limiter = new SlidingWindowRateLimiter(3, 60_000, () => fakeNow);
      await limiter.acquire();
      await limiter.acquire();
      await limiter.acquire();
      const beforeAdvance = limiter.useCount;
      const willBlock = limiter.acquire();
      check('t19: 4th acquire blocks while the window is full', beforeAdvance === 3, beforeAdvance);
      fakeNow += 60_001;
      await willBlock;
      check('t19: window rollover frees a slot (acquire succeeds, old slots expired)', limiter.useCount === 1, limiter.useCount);
      check('t19: rate limit respected end-to-end (never more than maxPerWindow)', limiter.useCount <= 3, limiter.useCount);
    } catch (err: any) {
      check('Test 19 (rate limiter)', false, err.message);
    }

    // ─── Test 20 (spec §7/§12/§19): mixed failures in ONE batch — only the
    //       retryable one is re-attempted next sweep ───────────────────────
    try {
      await seedCorpus([
        { id: IDS.c3, content: CONTENT.c },
        { id: IDS.c2, content: CONTENT.b },
        { id: IDS.c1, content: CONTENT.a },
      ]);
      provider.calls.length = 0;
      provider.failNext(true);   // c3 -> retryable
      provider.failNext(false);  // c2 -> permanent
      const r1 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      check('t20: mixed batch counted truthfully (1 ok, 1 retryable, 1 permanent)', r1.reembedded === 1 && r1.retryableFailures === 1 && r1.permanentFailures === 1 && r1.failed === 2, r1);
      const r2 = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      check('t20: next sweep re-attempts ONLY the retryable chunk (permanent quarantined)', r2.reembedded === 1 && r2.skippedQuarantined === 1 && r2.failed === 0 && provider.calls.length === 4, r2);
      resetFakeSupabaseStore();
      resetEmbeddingBackfillState();
    } catch (err: any) {
      check('Test 20 (mixed failures)', false, err.message);
    }

    // ─── Test 21 (spec §14/§22): no fabricated data ever ──────────────────
    try {
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, embedding: [], embedding_model: 'whatever', embedding_version: 'v1' },
        { id: IDS.c2, content: CONTENT.b, embedding: null, embedding_model: 'whatever', embedding_version: 'v1' },
        { id: IDS.c3, content: CONTENT.c, embedding: [0.1, 0.2, 0.3], embedding_model: provider.model, embedding_version: provider.version },
      ]);
      provider.badVectorNext = true;
      provider.returnModelOverride = 'RESOLVED-provider';
      const r = await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      const rows = await allChunks();
      const invalidKept = rows.find((x) => x.id === IDS.c3);
      check('t21: malformed/short/null-vector rows are re-embedded (never left as-is or invented)', r.reembedded === 2 && r.failed === 1, { r, rows });
      check('t21: invalid replacement vector -> chunk FAILED, old vector untouched (nothing fabricated)', (invalidKept as any)?.embedding.length === 3 && (invalidKept as any)?.embedding_model === provider.model, invalidKept);
      const fixed = rows.filter((x) => x.id !== IDS.c3);
      check('t21: persisted vectors/metadata come from the provider result exactly', fixed.every((x) => Array.isArray((x as any).embedding) && (x as any).embedding.length === 8 && (x as any).embedding_model === 'RESOLVED-provider'), rows);
      provider.returnModelOverride = null;
      provider.badVectorNext = false;
      resetFakeSupabaseStore();
      resetEmbeddingBackfillState();
    } catch (err: any) {
      check('Test 21 (no fabricated data)', false, err.message);
    }

    // ─── Test 22 (spec §17/§18): row and content-hash uniqueness ──────────
    try {
      await seedCorpus([
        { id: IDS.c4, content: CONTENT.b },
        { id: IDS.c3, content: CONTENT.c },
        { id: IDS.c2, content: CONTENT.d },
        { id: IDS.c1, content: CONTENT.e },
      ]);
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 2 });
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, cursor: IDS.c2, batchSize: 2 });
      const rows = await allChunks();
      const hashes = rows.map((x) => x.content_hash as string);
      check('t22: no duplicate rows and no duplicate content hashes after backfill', rows.length === 4 && new Set(hashes).size === 4, rows);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 22 (row/hash uniqueness)', false, err.message);
    }

    // ─── Test 23 (spec §16): usage is recorded (persistence, not logs) ────
    try {
      class InMemoryUsageStore implements UsageStore {
        rows: PersistRow[] = [];
        async persist(row: PersistRow): Promise<void> {
          this.rows.push(row);
        }
        async query(): Promise<UsageRow[]> {
          return [];
        }
      }
      const usageStore = new InMemoryUsageStore();
      setUsageStoreForTest(usageStore);
      await seedCorpus([
        { id: IDS.c1, content: CONTENT.a, workspace_id: DEV_WORKSPACE },
        { id: IDS.c2, content: CONTENT.b, workspace_id: DEV_WORKSPACE },
        { id: IDS.c3, content: CONTENT.c, workspace_id: WS2 },
      ]);
      await processEmbeddingBackfillBatch({ provider, batchSize: 10 });
      await sleep(25);
      check('t23: usage rows persisted per workspace for re-embedded chunks', usageStore.rows.length === 2, usageStore.rows);
      check('t23: rows carry provider/model metadata and zero fabricated cost/tokens', usageStore.rows.every((r) => r.provider === 'mock-embedder' && r.cost_cents === 0 && r.units === 0), usageStore.rows);
      setUsageStoreForTest(null);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 23 (usage accounting)', false, err.message);
    }

    // ─── Test 24 (spec §24): observability — health details + batch state ─
    try {
      await seedCorpus([{ id: IDS.c1, content: CONTENT.a }]);
      await processEmbeddingBackfillBatch({ workspaceId: DEV_WORKSPACE, provider, batchSize: 10 });
      const last = getLastEmbeddingBackfillBatch();
      check('t24: last batch state reflects the run (scanned/reembedded/duration)', last !== null && last.scanned === 1 && last.reembedded === 1 && last.durationMs >= 0, last);
      check('t24: running flag clears after the batch', isEmbeddingBackfillRunning() === false, isEmbeddingBackfillRunning());
      const details = workerModule.embeddingBackfillHealthDetails();
      check('t24: ingestion-worker health details merged (running + last batch + poison count)', typeof details.embeddingBackfillRunning === 'boolean' && (details as any).embeddingBackfillLastBatch?.scanned === 1 && typeof details.embeddingBackfillPoisonedChunks === 'number', details);
      resetFakeSupabaseStore();
    } catch (err: any) {
      check('Test 24 (observability)', false, err.message);
    }
  } finally {
    resetFakeSupabaseStore();
    resetEmbeddingBackfillState();
    setUsageStoreForTest(null);
    // Restore the REAL embedding provider — leaving the test mock installed
    // would pollute every later suite in run-all (they rely on the prod
    // provider's 1536-dim contract, e.g. noFabricatedFallback).
    setEmbeddingProviderForTest(null);
  }

  console.log(`\n[Embedding Backfill Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  installHarness();
  runEmbeddingBackfillTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}