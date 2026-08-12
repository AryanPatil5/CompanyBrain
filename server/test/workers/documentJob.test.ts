// Hermetic tests for the Phase 3 `parse_document` worker processor
// (ADR-T15): processDocumentIngestionJob stage checkpoints, MIME-dispatched
// parsing, the explicit ocr_required terminal state, and failure handling.
//
// The worker module is imported dynamically AFTER installHarness(): it pulls
// in src/queue/ingestionQueue.ts, which constructs BullMQ queues + a real
// ioredis connection at module-eval. Importing it statically would land the
// harness sendCommand stub mid-handshake of that connect (see the same note
// in test/routes/documents.test.ts). Storage is the in-memory provider via
// the test seam; the pipeline's LLM/embedding calls go through the harness
// fetch router.

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import type { Job } from 'bullmq';
import { supabase } from '../../src/config/supabase.js';
import {
  createInMemoryStorageProvider,
} from '../../src/services/storage/inMemoryStorageProvider.js';
import {
  setStorageProviderForTest,
  resetStorageProviderForTest,
  hashBytes,
  objectKeyFor,
} from '../../src/services/storage/storageProvider.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ DOCUMENT JOB TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ DOCUMENT JOB TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';

interface DocJobData {
  job_name: 'parse_document';
  document_id: string;
  workspace_id: string;
  storage_key: string;
  content_type: string;
  content_hash?: string;
}

function makeMockJob(data: DocJobData): Job<DocJobData> {
  return {
    id: `doc_job_${Math.random().toString(36).substring(2, 10)}`,
    name: data.job_name,
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async (): Promise<void> => undefined,
    toJSON: () => ({ id: 'test_job' }),
  } as unknown as Job<DocJobData>;
}

/** A minimal, VALID one-page PDF with an empty content stream (> 500 bytes,
 *  so the scanned/OCR detection in pdfExtractor engages on zero extracted
 *  text). Deterministic: pdf-parse parses it successfully, finds no text,
 *  and the pipeline reports ocr_required instead of fabricating text. */
function makeEmptyPdf(): Buffer {
  const header = [
    '%PDF-1.4',
    '% Company Brain hermetic test fixture — no text layer.',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    'endobj',
    '4 0 obj',
    '<< /Length 0 >>',
    'stream',
    '',
    'endstream',
    'endobj',
    'xref',
    '0 5',
    '0000000000 65535 f ',
  ].join('\n') + '\n';

  // Track byte offsets: each object's xref entry points at the first byte of
  // `N 0 obj`, which begins right after the previous object's `endobj\n`.
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ];
  let cursor = header.length;
  const xrefEntries: string[] = [];
  for (const obj of objects) {
    xrefEntries.push(`${String(cursor).padStart(10, '0')} 00000 n \n`);
    cursor += obj.length;
  }
  const trailer = `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;
  return Buffer.from(header + xrefEntries.join('') + trailer, 'utf-8');
}

const MARKDOWN = Buffer.from(
  '# Deployment Runbook\n\nAll production deployments require two-person approval before merging into the main branch. Rollbacks must be rehearsed quarterly.'
);

// Distinct content for Test 6: the content-hash short-circuit is keyed on
// content, and Test 1 already completed a row for MARKDOWN — reusing it here
// would skip the chunk write entirely (and would have masked the regression).
const MARKDOWN_CHUNK_FAIL = Buffer.from(
  '# Incident Response Playbook\n\nOn-call engineers must acknowledge pages within five minutes. Escalation to the platform lead happens after two missed acknowledgements.'
);

async function seedDocument(opts: {
  id: string;
  workspace?: string;
  externalId?: string;
  title?: string;
  stage?: string;
}): Promise<void> {
  const { error } = await supabase.from('source_documents').insert({
    id: opts.id,
    workspace_id: opts.workspace ?? DEV_WORKSPACE,
    source: 'upload',
    external_id: opts.externalId ?? 'seed-hash',
    title: opts.title ?? 'upload.txt',
    storage_uri: `memory://company-brain/raw/${opts.workspace ?? DEV_WORKSPACE}/seed`,
    extraction_stage: opts.stage ?? 'queued',
    metadata: {},
  });
  if (error) {
    throw new Error(`seedDocument failed: ${error.message}`);
  }
}

export async function runDocumentJobTests(): Promise<boolean> {
  await installHarness();
  // Isolation: the pipeline's upsert().select().single() resolves to the first
  // table row when other suites have seeded source_documents (run-all shares
  // one in-memory store). Reset so standalone == runner behavior.
  resetFakeSupabaseStore();
  const { processDocumentIngestionJob } = await import('../../src/workers/ingestionWorker.js');
  resetStorageProviderForTest();
  const provider = createInMemoryStorageProvider();
  setStorageProviderForTest(provider);

  try {
    // ─── Test 1: markdown success path -> completed, chunks + row state ───
    try {
      const contentHash = hashBytes(MARKDOWN);
      const objectKey = objectKeyFor(DEV_WORKSPACE, contentHash, 'text/markdown');
      await seedDocument({ id: 'doc-ok-1', externalId: contentHash, title: 'runbook.md' });
      await provider.putObject(objectKey, MARKDOWN, { contentType: 'text/markdown' });

      const result = await processDocumentIngestionJob(
        makeMockJob({
          job_name: 'parse_document',
          document_id: 'doc-ok-1',
          workspace_id: DEV_WORKSPACE,
          storage_key: objectKey,
          content_type: 'text/markdown',
          content_hash: contentHash,
        })
      );
      check('success: returns completed status with document id', result?.status === 'completed' && result?.document_id === 'doc-ok-1', result);
      check('success: at least one chunk persisted', typeof result?.chunks === 'number' && result.chunks >= 1, result);

      // The pipeline upserts on (workspace_id, source, external_id) — in real
      // Postgres this updates the seeded row in place; the fake store matches
      // on id, but its upsert().select().single() resolves to the seeded row
      // too, so 'doc-ok-1' is the document in both worlds.
      const { data: docRow } = await supabase
        .from('source_documents')
        .select('extraction_stage')
        .eq('id', 'doc-ok-1')
        .maybeSingle();
      check('success: row reaches extraction_stage=completed', docRow?.extraction_stage === 'completed', docRow);

      const { data: chunkRows } = await supabase
        .from('document_chunks')
        .select('id, chunk_index')
        .eq('workspace_id', DEV_WORKSPACE)
        .eq('source_document_id', 'doc-ok-1');
      check('success: document_chunks rows persisted', Array.isArray(chunkRows) && chunkRows.length >= 1, chunkRows);
    } catch (err: any) {
      check('Test 1 (markdown success)', false, err.message);
    }

    // ─── Test 2: scanned PDF -> explicit ocr_required terminal state ─────
    try {
      const pdf = makeEmptyPdf();
      const objectKey = `raw/${DEV_WORKSPACE}/${hashBytes(pdf)}.pdf`;
      await seedDocument({ id: 'doc-ocr-1', externalId: hashBytes(pdf), title: 'scan.pdf' });
      await provider.putObject(objectKey, pdf, { contentType: 'application/pdf' });

      const result = await processDocumentIngestionJob(
        makeMockJob({
          job_name: 'parse_document',
          document_id: 'doc-ocr-1',
          workspace_id: DEV_WORKSPACE,
          storage_key: objectKey,
          content_type: 'application/pdf',
          content_hash: hashBytes(pdf),
        })
      );
      check('ocr: returns explicit ocr_required status (no fabricated text)', result?.status === 'ocr_required', result);

      const { data: docRow } = await supabase
        .from('source_documents')
        .select('extraction_stage')
        .eq('id', 'doc-ocr-1')
        .maybeSingle();
      check('ocr: row reaches extraction_stage=ocr_required', docRow?.extraction_stage === 'ocr_required', docRow);

      const { data: chunkRows } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('workspace_id', DEV_WORKSPACE)
        .eq('source_document_id', 'doc-ocr-1');
      check('ocr: NO chunks persisted for ocr_required documents', Array.isArray(chunkRows) && chunkRows.length === 0, chunkRows);
    } catch (err: any) {
      check('Test 2 (scanned PDF -> ocr_required)', false, err.message);
    }

    // ─── Test 3: unknown document id -> throw, row failure marker ─────────
    try {
      let thrown: unknown = null;
      try {
        await processDocumentIngestionJob(
          makeMockJob({
            job_name: 'parse_document',
            document_id: '00000000-0000-0000-0000-0000000000aa',
            workspace_id: DEV_WORKSPACE,
            storage_key: 'raw/x/y.txt',
            content_type: 'text/markdown',
          })
        );
      } catch (err) {
        thrown = err;
      }
      check('missing row: processor throws (BullMQ retry/DLQ path)', thrown instanceof Error && /not found/.test((thrown as Error).message), thrown);
    } catch (err: any) {
      check('Test 3 (missing row)', false, err.message);
    }

    // ─── Test 4: storage provider not configured -> throw before fetch ────
    try {
      await seedDocument({ id: 'doc-noprov-1' });
      setStorageProviderForTest(null);
      let thrown: unknown = null;
      try {
        await processDocumentIngestionJob(
          makeMockJob({
            job_name: 'parse_document',
            document_id: 'doc-noprov-1',
            workspace_id: DEV_WORKSPACE,
            storage_key: 'raw/x/y.txt',
            content_type: 'text/markdown',
          })
        );
      } catch (err) {
        thrown = err;
      }
      check('no provider: throws "not configured"', thrown instanceof Error && /not configured/.test((thrown as Error).message), thrown);

      const { data: docRow } = await supabase
        .from('source_documents')
        .select('extraction_stage')
        .eq('id', 'doc-noprov-1')
        .maybeSingle();
      check('no provider: row marked failed (resumable retry marker)', docRow?.extraction_stage === 'failed', docRow);
    } catch (err: any) {
      check('Test 4 (provider not configured)', false, err.message);
    } finally {
      resetStorageProviderForTest();
      setStorageProviderForTest(createInMemoryStorageProvider());
    }

    // ─── Test 6: chunk persistence failure -> throw + failed row; ──────────
    // the retry (BullMQ retry / re-upload recovery) fully recovers to
    // completed with chunks. Regression: persistDocumentCore swallowed the
    // document_chunks upsert error and returned { chunksPersisted: 0 }; the
    // worker then marked the row 'completed', and the completed + content-hash
    // short-circuit made every later re-upload a deduplicated no-op — the
    // chunks were unrecoverable.
    try {
      setStorageProviderForTest(provider);
      const contentHash = hashBytes(MARKDOWN_CHUNK_FAIL);
      const objectKey = objectKeyFor(DEV_WORKSPACE, contentHash, 'text/markdown');
      await seedDocument({ id: 'doc-chunk-fail-1', externalId: contentHash, title: 'runbook.md' });
      await provider.putObject(objectKey, MARKDOWN_CHUNK_FAIL, { contentType: 'text/markdown' });

      // Fault injection: fail ONLY document_chunks writes (the surface the
      // regression swallowed). The store is reachable off the query builder
      // (private field, hermetic test seam only).
      const chunkQuery: any = supabase.from('document_chunks');
      const store: any = chunkQuery.store;
      const originalUpsert = store.upsert.bind(store);
      store.upsert = (table: string, rows: unknown, onConflict?: string) => {
        if (table === 'document_chunks') {
          throw new Error('simulated document_chunks upsert failure');
        }
        return originalUpsert(table, rows, onConflict);
      };

      let thrown: unknown = null;
      try {
        await processDocumentIngestionJob(
          makeMockJob({
            job_name: 'parse_document',
            document_id: 'doc-chunk-fail-1',
            workspace_id: DEV_WORKSPACE,
            storage_key: objectKey,
            content_type: 'text/markdown',
            content_hash: contentHash,
          })
        );
      } catch (err) {
        thrown = err;
      }
      check('chunk fail: processor throws (not a silent {chunksPersisted: 0} success)', thrown instanceof Error && /chunks/.test((thrown as Error).message), thrown);

      const { data: failRow } = await supabase
        .from('source_documents')
        .select('extraction_stage')
        .eq('id', 'doc-chunk-fail-1')
        .maybeSingle();
      check('chunk fail: row marked failed (never completed with zero chunks)', failRow?.extraction_stage === 'failed', failRow);

      const { data: failChunks } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', 'doc-chunk-fail-1');
      check('chunk fail: no chunk rows written on the failed run', Array.isArray(failChunks) && failChunks.length === 0, failChunks);

      // Clear the fault: the retry must fully recover the document.
      store.upsert = originalUpsert;

      const retried = await processDocumentIngestionJob(
        makeMockJob({
          job_name: 'parse_document',
          document_id: 'doc-chunk-fail-1',
          workspace_id: DEV_WORKSPACE,
          storage_key: objectKey,
          content_type: 'text/markdown',
          content_hash: contentHash,
        })
      );
      check('chunk fail: retry recovers to completed', retried?.status === 'completed', retried);

      const { data: okChunks } = await supabase
        .from('document_chunks')
        .select('id')
        .eq('source_document_id', 'doc-chunk-fail-1');
      check('chunk fail: retry persists chunks', Array.isArray(okChunks) && okChunks.length >= 1, okChunks);
    } catch (err: any) {
      check('Test 6 (chunk persistence failure)', false, err.message);
    }

    // ─── Test 5: object missing from storage -> throw, row failed ─────────
    try {
      await seedDocument({ id: 'doc-missing-obj-1' });
      let thrown: unknown = null;
      try {
        await processDocumentIngestionJob(
          makeMockJob({
            job_name: 'parse_document',
            document_id: 'doc-missing-obj-1',
            workspace_id: DEV_WORKSPACE,
            storage_key: 'raw/never-uploaded/object.txt',
            content_type: 'text/markdown',
          })
        );
      } catch (err) {
        thrown = err;
      }
      check('missing object: throws "missing from storage"', thrown instanceof Error && /missing from storage/.test((thrown as Error).message), thrown);

      const { data: docRow } = await supabase
        .from('source_documents')
        .select('extraction_stage')
        .eq('id', 'doc-missing-obj-1')
        .maybeSingle();
      check('missing object: row marked failed', docRow?.extraction_stage === 'failed', docRow);
    } catch (err: any) {
      check('Test 5 (missing object)', false, err.message);
    }
  } finally {
    resetStorageProviderForTest();
  }

  console.log(`\n[Document Job Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDocumentJobTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
