// Hermetic route tests for the Phase 3 document upload API (ADR-T6/T15):
// POST /api/documents/upload (multipart, MIME/size gated, content-addressed
// storage, queued) and GET /api/documents/:id/status (workspace-scoped).
// Storage is the in-memory provider injected via the test seam; the queue is
// the harness Redis stub; auth is the established mock-token pattern.

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { supabase } from '../../src/config/supabase.js';
import {
  createInMemoryStorageProvider,
} from '../../src/services/storage/inMemoryStorageProvider.js';
import {
  getStorageProvider,
  setStorageProviderForTest,
  resetStorageProviderForTest,
  hashBytes,
} from '../../src/services/storage/storageProvider.js';

// NOTE: src/routes/documents.ts must NOT be imported statically. It pulls in
// src/queue/ingestionQueue.ts, which constructs the BullMQ queue + real
// ioredis connection at module-eval. Importing it before installHarness()
// lands the harness's sendCommand stub mid-handshake of that connect, leaving
// the queue's `initializing` promise pending forever (every .add() hangs).
// Defer the import until after the harness is installed (same reason the
// harness docs require stubs before queue/worker module imports).

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ DOCUMENTS ROUTE TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ DOCUMENTS ROUTE TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';
const OTHER_WORKSPACE = '11111111-1111-1111-1111-111111111111';

const MARKDOWN_CONTENT = Buffer.from('# Deploy Runbook\n\nAll production deployments require two-person approval before merge into the main branch.');

async function uploadFile(base: string, name: string, buffer: Buffer, type: string): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  return fetch(`${base}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization: 'Bearer mock-admin-token' },
    body: form,
  });
}

export async function runDocumentsRouteTests(): Promise<boolean> {
  await installHarness();
  // Isolation: filter-less .single()/first-row resolution and shared tables
  // make prior suites' rows leak into this suite under run-all.ts.
  resetFakeSupabaseStore();
  const { default: documentsRouter } = await import('../../src/routes/documents.js');
  resetStorageProviderForTest();
  setStorageProviderForTest(createInMemoryStorageProvider());

  const app = express();
  app.use(express.json());
  app.use('/api/documents', documentsRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ─── 1. Happy path: upload -> 202, object stored, row queued ───────────
    const res = await uploadFile(base, 'runbook.md', MARKDOWN_CONTENT, 'text/markdown');
    const body: any = await res.json();
    check('upload returns 202 with document_id', res.status === 202 && !!body.document_id && body.status === 'queued', body);

    const { data: docRow } = await supabase
      .from('source_documents')
      .select('*')
      .eq('id', body.document_id)
      .maybeSingle();
    check('source_documents row persisted', !!docRow && docRow.source === 'upload');
    check('row carries content-addressed external id (sha256)', docRow?.external_id === hashBytes(MARKDOWN_CONTENT));
    check('row carries storage_uri', typeof docRow?.storage_uri === 'string' && docRow.storage_uri.includes(`raw/${DEV_WORKSPACE}/`));
    check('row starts at queued stage', docRow?.extraction_stage === 'queued');
    check('original filename recorded in metadata only', docRow?.title === 'runbook.md');

    const provider = getStorageProvider()!;
    const stored = await provider.headObject(`raw/${DEV_WORKSPACE}/${hashBytes(MARKDOWN_CONTENT)}.txt`);
    check('object stored content-addressed', stored?.size === MARKDOWN_CONTENT.length);

    // ─── 2. Status endpoint: own workspace ────────────────────────────────
    const statusRes = await fetch(`${base}/api/documents/${body.document_id}/status`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    const statusBody: any = await statusRes.json();
    check('status returns 200 with extraction_stage', statusRes.status === 200 && statusBody.extraction_stage === 'queued', statusBody);

    // ─── 3. Status endpoint: cross-workspace -> 404 (no existence leak) ────
    await supabase.from('source_documents').insert({
      id: 'doc-other-1',
      workspace_id: OTHER_WORKSPACE,
      source: 'upload',
      external_id: 'other-hash',
      title: 'other.txt',
      extraction_stage: 'queued',
    });
    const crossRes = await fetch(`${base}/api/documents/doc-other-1/status`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    check('cross-workspace document returns 404', crossRes.status === 404, crossRes.status);

    // ─── 4. Unknown document -> 404 ───────────────────────────────────────
    const missingRes = await fetch(`${base}/api/documents/00000000-0000-0000-0000-0000000000aa/status`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    check('unknown document returns 404', missingRes.status === 404, missingRes.status);

    // ─── 5. Unsupported MIME -> 415, nothing stored ───────────────────────
    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.from('#!/bin/sh\necho hi')], { type: 'application/x-shellscript' }), 'evil.sh');
    const badRes = await fetch(`${base}/api/documents/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer mock-admin-token' },
      body: badForm,
    });
    const badBody: any = await badRes.json();
    check('unsupported MIME returns 415', badRes.status === 415 && String(badBody.error).includes('Unsupported file type'), badBody);

    // ─── 6. Missing file field -> 400 ────────────────────────────────────
    const emptyForm = new FormData();
    emptyForm.append('note', 'no file here');
    const noFileRes = await fetch(`${base}/api/documents/upload`, {
      method: 'POST',
      headers: { authorization: 'Bearer mock-admin-token' },
      body: emptyForm,
    });
    check('missing file field returns 400', noFileRes.status === 400, noFileRes.status);

    // ─── 7. Unauthenticated -> 401 ───────────────────────────────────────
    const unauthForm = new FormData();
    unauthForm.append('file', new Blob([MARKDOWN_CONTENT], { type: 'text/markdown' }), 'x.md');
    const unauthRes = await fetch(`${base}/api/documents/upload`, { method: 'POST', body: unauthForm });
    check('unauthenticated upload returns 401', unauthRes.status === 401, unauthRes.status);
  } finally {
    server.close();
    resetStorageProviderForTest();
  }

  console.log(`\n[Documents Route Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDocumentsRouteTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
