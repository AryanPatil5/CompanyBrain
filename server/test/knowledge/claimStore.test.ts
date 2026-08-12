// Hermetic unit tests for the Phase 3 claim store (ADR-T15): idempotent
// claim + evidence persistence. Uses a conflict-aware in-memory fake that
// honors the UNIQUE keys the real migration 036 defines —
//   knowledge_claims UNIQUE (workspace_id, source_document_id, chunk_id, claim_text_hash)
//   claim_evidence UNIQUE (claim_id, chunk_id)
// so reprocessing guarantees single rows.

import crypto from 'node:crypto';
import { installHarness } from '../harness/index.js';
import { persistClaims } from '../../src/knowledge/claimStore.js';
import { hashContent } from '../../src/ingestion/chunker.js';
import type { ExtractedClaim } from '../../src/knowledge/claimExtractor.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ CLAIM-STORE TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ CLAIM-STORE TEST FAILED: ${name}`, extra ?? '');
  }
}

type Row = Record<string, any>;

/**
 * Minimal conflict-aware fake for the claim tables. Mirrors Postgres upsert
 * semantics for the migration-036 unique keys: onConflict names the columns
 * that must match an existing row for the upsert to reuse it.
 */
function makeFakeDb() {
  const claims: Row[] = [];
  const evidence: Row[] = [];
  const chunks: Row[] = [];

  const rowsFor = (table: string): Row[] => {
    if (table === 'knowledge_claims') return claims;
    if (table === 'claim_evidence') return evidence;
    return chunks;
  };

  const upsertRow = (table: string, row: Row, onConflict?: string) => {
    const rows = rowsFor(table);
    let existing: Row | undefined;
    if (onConflict) {
      const cols = onConflict.split(',').map((c) => c.trim());
      existing = rows.find((r) => cols.every((c) => r[c] === row[c]));
    } else {
      existing = rows.find((r) => r.id === row.id);
    }
    if (existing) {
      Object.assign(existing, row);
    } else {
      if (row.id == null) row.id = crypto.randomUUID();
      rows.push({ ...row });
    }
  };

  const matches = (r: Row, filters: Array<[string, unknown]>): boolean => filters.every(([col, val]) => r[col] === val);

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let cols: string[] = ['*'];
    const q: any = {};
    q.select = (c: string) => {
      cols = c.split(',').map((s) => s.trim());
      return q;
    };
    q.eq = (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    };
    q.in = () => q;
    q.is = () => q;
    q.limit = () => q;
    q.order = () => q;
    q.upsert = (payload: unknown, opts?: { onConflict?: string }) => {
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const row of rows as Row[]) upsertRow(table, row, opts?.onConflict);
      return q;
    };
    q.insert = (payload: unknown) => {
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const row of rows as Row[]) upsertRow(table, row);
      return q;
    };
    q.update = () => q;
    q.delete = () => q;
    q.maybeSingle = () => {
      const row = rowsFor(table).find((r) => matches(r, filters)) ?? null;
      if (!row) return Promise.resolve({ data: null, error: null });
      const out: Row = {};
      for (const c of cols) out[c] = row[c];
      return Promise.resolve({ data: cols.length === 1 && cols[0] === '*' ? row : out, error: null });
    };
    q.single = q.maybeSingle;
    q.then = (resolve: (v: any) => any) => {
      const row = rowsFor(table).find((r) => matches(r, filters)) ?? null;
      return Promise.resolve({ data: cols.length === 1 && cols[0] === '*' ? row : row ? { [cols[0]]: row[cols[0]] } : null, error: null }).then(resolve);
    };
    return q;
  };

  return {
    client: { from },
    state: { claims, evidence, chunks },
  };
}

const CLAIM_A: ExtractedClaim = {
  claim_text: 'Production deploys require two-person approval before merge.',
  claim_type: 'process',
  confidence: 0.9,
  char_start: 0,
  char_end: 60,
};

const CLAIM_B: ExtractedClaim = {
  claim_text: 'All database migrations must be additive and runner-owned.',
  claim_type: 'policy',
  confidence: 0.8,
  char_start: 12,
  char_end: 66,
};

async function testPersistsClaimAndEvidence(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });

  const persisted = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [{ chunkId: 'chunk-1', claims: [CLAIM_A] }],
    client: db.client as any,
  });

  check('returns one persisted claim', persisted.length === 1);
  check('claim row persisted', db.state.claims.length === 1);
  check('claim text stored verbatim', db.state.claims[0].claim_text === CLAIM_A.claim_text);
  check('claim_text_hash matches deterministic hash', db.state.claims[0].claim_text_hash === hashContent(CLAIM_A.claim_text));
  check('claim_type stored', db.state.claims[0].claim_type === 'process');
  check('confidence stored', db.state.claims[0].confidence === 0.9);
  check('status defaults to draft', db.state.claims[0].status === 'draft');
  check('ai_generated true', db.state.claims[0].ai_generated === true);
  check('evidence row persisted', db.state.evidence.length === 1);
  check('evidence bound to claim id', db.state.evidence[0].claim_id === db.state.claims[0].id);
  check('evidence bound to chunk', db.state.evidence[0].chunk_id === 'chunk-1');
  check('evidence offsets stored', db.state.evidence[0].char_start === 0 && db.state.evidence[0].char_end === 60);
  check('evidence provenance persisted', db.state.evidence[0].provenance_json?.evidence_span === '0:60');
  return success;
}

async function testReprocessingIsIdempotent(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });

  const first = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [{ chunkId: 'chunk-1', claims: [CLAIM_A] }],
    client: db.client as any,
  });
  const second = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [{ chunkId: 'chunk-1', claims: [CLAIM_A] }],
    client: db.client as any,
  });

  check('claim row not duplicated across reprocessing', db.state.claims.length === 1);
  check('evidence not duplicated across reprocessing', db.state.evidence.length === 1);
  check('reprocessing returns the SAME claim id', first[0].id === second[0].id);
  return success;
}

async function testUngroundedChunkRejected(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });

  let threw = false;
  try {
    await persistClaims({
      workspaceId: 'ws-1',
      sourceDocumentId: 'doc-1',
      groupedClaims: [{ chunkId: 'chunk-does-not-exist', claims: [CLAIM_A] }],
      client: db.client as any,
    });
  } catch (err) {
    threw = String((err as Error).message).includes('Refusing to persist claim for unknown chunk');
  }
  check('unknown chunk id rejected before any write', threw);
  check('no claim rows written', db.state.claims.length === 0);
  check('no evidence rows written', db.state.evidence.length === 0);
  return success;
}

async function testCrossWorkspaceChunkRejected(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });

  let threw = false;
  try {
    await persistClaims({
      workspaceId: 'ws-2',
      sourceDocumentId: 'doc-1',
      groupedClaims: [{ chunkId: 'chunk-1', claims: [CLAIM_A] }],
      client: db.client as any,
    });
  } catch (err) {
    threw = String((err as Error).message).includes('Refusing to persist claim');
  }
  check('foreign workspace chunk rejected (workspace-scoped grounding)', threw);
  return success;
}

async function testEmptyGroupsNoOp(): Promise<boolean> {
  const db = makeFakeDb();
  const persisted = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [],
    client: db.client as any,
  });
  check('no groups -> no claims', persisted.length === 0);
  check('no writes happened', db.state.claims.length === 0 && db.state.evidence.length === 0);
  return success;
}

async function testMultipleChunksEachGrounded(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });
  db.state.chunks.push({ id: 'chunk-2', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 1 });

  const persisted = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [
      { chunkId: 'chunk-1', claims: [CLAIM_A] },
      { chunkId: 'chunk-2', claims: [CLAIM_B] },
    ],
    client: db.client as any,
  });

  check('two claims persisted', persisted.length === 2);
  check('two claim rows', db.state.claims.length === 2);
  check('two evidence rows', db.state.evidence.length === 2);
  const chunkBindings = new Set(db.state.evidence.map((e: Row) => e.chunk_id));
  check('each evidence bound to its own chunk', chunkBindings.size === 2 && chunkBindings.has('chunk-1') && chunkBindings.has('chunk-2'));
  return success;
}

async function testClaimWithoutChunkGroupSkipped(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.chunks.push({ id: 'chunk-1', workspace_id: 'ws-1', source_document_id: 'doc-1', chunk_index: 0 });

  const persisted = await persistClaims({
    workspaceId: 'ws-1',
    sourceDocumentId: 'doc-1',
    groupedClaims: [{ chunkId: '', claims: [CLAIM_A] }],
    client: db.client as any,
  });
  check('ungrounded group skipped', persisted.length === 0);
  check('no rows written', db.state.claims.length === 0 && db.state.evidence.length === 0);
  return success;
}

export async function runClaimStoreTests(): Promise<boolean> {
  await installHarness();
  const suites: Array<() => Promise<boolean>> = [
    testPersistsClaimAndEvidence,
    testReprocessingIsIdempotent,
    testUngroundedChunkRejected,
    testCrossWorkspaceChunkRejected,
    testEmptyGroupsNoOp,
    testMultipleChunksEachGrounded,
    testClaimWithoutChunkGroupSkipped,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[ClaimStore Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaimStoreTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
