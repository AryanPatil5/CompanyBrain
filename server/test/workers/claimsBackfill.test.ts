// Hermetic tests for the Phase 3 knowledge-claims backfill worker
// (ADR-T15 backfill-worker step): candidate scanning by checkpoint, idempotent
// re-derivation of knowledge_claims from stored chunks, checkpoint stamping,
// poisoned-document quarantine and batch limits.
//
// The worker module is imported dynamically AFTER installHarness(): it pulls
// in src/queue/ingestionQueue.ts, which constructs BullMQ queues + a real
// ioredis connection at module-eval (see the note in
// test/routes/documents.test.ts — the ingest harness stub must land before
// that connect). The backfill core (src/ingestion/claimsBackfill.ts) is
// queue-free, so it can be imported statically.

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import type { Job } from 'bullmq';
import { supabase } from '../../src/config/supabase.js';
import {
  CLAIMS_BACKFILL_VERSION,
  CLAIMS_BACKFILL_MAX_FAILURES,
  findClaimsBackfillCandidates,
  deriveClaimsForDocument,
  processClaimsBackfillBatch,
} from '../../src/ingestion/claimsBackfill.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ CLAIMS BACKFILL TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ CLAIMS BACKFILL TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';

interface BackfillJobData {
  job_name: 'batch';
  limit?: number;
}

function makeMockJob(data: BackfillJobData): Job<BackfillJobData> {
  return {
    id: `backfill_${Math.random().toString(36).substring(2, 10)}`,
    name: 'batch',
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async (): Promise<void> => undefined,
    toJSON: () => ({ id: 'test_job' }),
  } as unknown as Job<BackfillJobData>;
}

const DOC_TEXTS = [
  '# Ops Runbook\n\nAll production deploys require a change ticket. Rollbacks are rehearsed every quarter.',
  '# Onboarding\n\nNew engineers get read access on day one. Production access requires manager approval.',
];

async function seedCompletedDocument(opts: {
  id: string;
  title?: string;
  stage?: string;
  claimsDerivedAt?: string | null;
  failures?: number;
  createdAt?: string;
}): Promise<void> {
  const { error } = await supabase.from('source_documents').insert({
    id: opts.id,
    workspace_id: DEV_WORKSPACE,
    source: 'upload',
    external_id: `${opts.id}-hash`,
    title: opts.title ?? `${opts.id}.md`,
    storage_uri: `memory://company-brain/raw/${DEV_WORKSPACE}/${opts.id}`,
    extraction_stage: opts.stage ?? 'completed',
    metadata: {},
    claims_derived_at: opts.claimsDerivedAt ?? null,
    claims_derived_version: null,
    claims_backfill_failures: opts.failures ?? 0,
    created_at: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
  });
  if (error) {
    throw new Error(`seedCompletedDocument failed: ${error.message}`);
  }
}

async function seedChunks(documentId: string, texts: string[]): Promise<void> {
  const rows = texts.map((content, i) => ({
    id: `${documentId}-chunk-${i}`,
    workspace_id: DEV_WORKSPACE,
    source_document_id: documentId,
    chunk_index: i,
    content,
    metadata: { title: `${documentId}.md` },
  }));
  const { error } = await supabase.from('document_chunks').insert(rows);
  if (error) {
    throw new Error(`seedChunks failed: ${error.message}`);
  }
}

async function claimRowsFor(documentId: string): Promise<number> {
  const { data } = await supabase
    .from('knowledge_claims')
    .select('id')
    .eq('workspace_id', DEV_WORKSPACE)
    .eq('source_document_id', documentId);
  return Array.isArray(data) ? data.length : -1;
}

async function rowCheckpoint(documentId: string): Promise<{
  claims_derived_at: string | null;
  claims_derived_version: string | null;
  claims_backfill_failures: number | null;
} | null> {
  const { data } = await supabase
    .from('source_documents')
    .select('claims_derived_at, claims_derived_version, claims_backfill_failures')
    .eq('id', documentId)
    .maybeSingle();
  return (data as any) ?? null;
}

export async function runClaimsBackfillTests(): Promise<boolean> {
  await installHarness();
  resetFakeSupabaseStore();
  const { processClaimsBackfillJob } = await import('../../src/workers/claimsBackfillWorker.js');

  try {
    // ─── Test 1: eligible document -> claims + evidence, checkpoint stamped ─
    try {
      await seedCompletedDocument({ id: 'doc-a', createdAt: '2026-01-01T00:00:00.000Z' });
      await seedChunks('doc-a', DOC_TEXTS);

      const result = await processClaimsBackfillBatch({ limit: 10 });
      check('batch: one candidate scanned and succeeded', result.scanned === 1 && result.succeeded === 1 && result.failed === 0, result);
      check('batch: claims persisted for every chunk', result.claimsPersisted >= 1, result);
      check('batch: knowledge_claims rows exist with evidence', (await claimRowsFor('doc-a')) === result.claimsPersisted, await claimRowsFor('doc-a'));

      const checkpoint = await rowCheckpoint('doc-a');
      check('batch: claims_derived_at stamped', typeof checkpoint?.claims_derived_at === 'string' && checkpoint.claims_derived_at !== null, checkpoint);
      check('batch: claims_derived_version stamped', checkpoint?.claims_derived_version === CLAIMS_BACKFILL_VERSION, checkpoint);

      const { data: evidence } = await supabase
        .from('claim_evidence')
        .select('id')
        .eq('workspace_id', DEV_WORKSPACE)
        .eq('source_document_id', 'doc-a');
      check('batch: claim_evidence rows persisted', Array.isArray(evidence) && evidence.length === result.claimsPersisted, evidence);
    } catch (err: any) {
      check('Test 1 (derive + stamp)', false, err.message);
    }

    // ─── Test 2: re-run is a no-op (idempotent by checkpoint + unique key) ─
    try {
      const beforeCount = await claimRowsFor('doc-a');
      const second = await processClaimsBackfillBatch({ limit: 10 });
      check('idempotent: stamped document is no longer a candidate', second.scanned === 0 && second.succeeded === 0, second);
      check('idempotent: claim count unchanged after re-run', (await claimRowsFor('doc-a')) === beforeCount, beforeCount);
    } catch (err: any) {
      check('Test 2 (idempotent re-run)', false, err.message);
    }

    // ─── Test 3: non-candidates are excluded from the scan ────────────────
    try {
      await seedCompletedDocument({ id: 'doc-failed', stage: 'failed' });
      await seedChunks('doc-failed', [DOC_TEXTS[0]]);
      await seedCompletedDocument({ id: 'doc-stamped', claimsDerivedAt: '2026-02-01T00:00:00.000Z' });
      await seedChunks('doc-stamped', [DOC_TEXTS[1]]);

      const candidates = await findClaimsBackfillCandidates({ limit: 20 });
      const ids = candidates.map((c) => c.id);
      check('scan: failed-stage document excluded', !ids.includes('doc-failed'), ids);
      check('scan: already-derived document excluded', !ids.includes('doc-stamped'), ids);
    } catch (err: any) {
      check('Test 3 (candidate exclusions)', false, err.message);
    }

    // ─── Test 4: batch limit bounds each sweep, oldest first ──────────────
    try {
      await seedCompletedDocument({ id: 'doc-old', createdAt: '2026-01-01T00:00:00.000Z' });
      await seedChunks('doc-old', [DOC_TEXTS[0]]);
      await seedCompletedDocument({ id: 'doc-new', createdAt: '2026-03-01T00:00:00.000Z' });
      await seedChunks('doc-new', [DOC_TEXTS[1]]);

      const limited = await processClaimsBackfillBatch({ limit: 1 });
      check('limit: only the oldest document processed', limited.scanned === 1 && limited.succeeded === 1, limited);
      check('limit: oldest processed, newest still pending', (await rowCheckpoint('doc-old'))?.claims_derived_at !== null && (await rowCheckpoint('doc-new'))?.claims_derived_at === null, limited);

      const rest = await processClaimsBackfillBatch({ limit: 1 });
      check('limit: next sweep picks up the remainder', rest.scanned === 1 && rest.succeeded === 1, rest);
    } catch (err: any) {
      check('Test 4 (batch limit)', false, err.message);
    }

    // ─── Test 5: failure increments quarantine counter; 3 strikes excludes ─
    try {
      await seedCompletedDocument({ id: 'doc-poison', createdAt: '2026-04-01T00:00:00.000Z' });
      await seedChunks('doc-poison', [DOC_TEXTS[0]]);

      // Fault injection at the same seam the documentJob suite uses: fail
      // ONLY knowledge_claims writes so the derivation throws deterministically.
      const claimQuery: any = supabase.from('knowledge_claims');
      const store: any = claimQuery.store;
      const originalUpsert = store.upsert.bind(store);
      store.upsert = (table: string, rows: unknown, onConflict?: string) => {
        if (table === 'knowledge_claims') {
          throw new Error('simulated knowledge_claims upsert failure');
        }
        return originalUpsert(table, rows, onConflict);
      };

      const first = await processClaimsBackfillBatch({ limit: 10 });
      const second = await processClaimsBackfillBatch({ limit: 10 });
      const third = await processClaimsBackfillBatch({ limit: 10 });
      check('quarantine: all three sweeps scanned the poisoned doc and it failed', first.failed === 1 && second.failed === 1 && third.failed === 1, { first, second, third });

      const quarantineCheckpoint = await rowCheckpoint('doc-poison');
      check(
        'quarantine: failure counter reached the threshold',
        quarantineCheckpoint?.claims_backfill_failures === CLAIMS_BACKFILL_MAX_FAILURES,
        quarantineCheckpoint
      );

      store.upsert = originalUpsert;

      const fourth = await processClaimsBackfillBatch({ limit: 10 });
      check('quarantine: doc excluded from the scan after threshold', fourth.scanned === 0, fourth);
      check('quarantine: doc never stamped as derived', (await rowCheckpoint('doc-poison'))?.claims_derived_at === null, await rowCheckpoint('doc-poison'));
    } catch (err: any) {
      check('Test 5 (quarantine)', false, err.message);
    }

    // ─── Test 6: zero-chunk completed document stamps without claims ──────
    try {
      await seedCompletedDocument({ id: 'doc-chunkless', createdAt: '2026-05-01T00:00:00.000Z' });
      const result = await processClaimsBackfillBatch({ limit: 10 });
      check('chunkless: processed with zero claims persisted', result.succeeded === 1 && result.claimsPersisted === 0, result);
      check('chunkless: checkpoint stamped (no repeated sweeps)', (await rowCheckpoint('doc-chunkless'))?.claims_derived_at !== null, await rowCheckpoint('doc-chunkless'));
    } catch (err: any) {
      check('Test 6 (zero chunks)', false, err.message);
    }

    // ─── Test 7: derive refuses non-completed documents ───────────────────
    try {
      await seedCompletedDocument({ id: 'doc-ocr', stage: 'ocr_required' });
      await seedChunks('doc-ocr', [DOC_TEXTS[0]]);
      let thrown: unknown = null;
      try {
        await deriveClaimsForDocument({ documentId: 'doc-ocr', workspaceId: DEV_WORKSPACE });
      } catch (err) {
        thrown = err;
      }
      check('derive: only completed documents are backfilleable', thrown instanceof Error && /only completed/.test((thrown as Error).message), thrown);
    } catch (err: any) {
      check('Test 7 (stage guard)', false, err.message);
    }

    // ─── Test 8: worker processor seam routes the job to the batch ────────
    try {
      await seedCompletedDocument({ id: 'doc-worker', createdAt: '2026-06-01T00:00:00.000Z' });
      await seedChunks('doc-worker', [DOC_TEXTS[1]]);
      const result = await processClaimsBackfillJob(makeMockJob({ job_name: 'batch', limit: 5 }));
      check('processor: job routes to batch and reports claims', result.scanned === 1 && result.succeeded === 1 && result.claimsPersisted >= 1, result);
    } catch (err: any) {
      check('Test 8 (worker processor)', false, err.message);
    }
  } finally {
    resetFakeSupabaseStore();
  }

  console.log(`\n[Claims Backfill Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaimsBackfillTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}