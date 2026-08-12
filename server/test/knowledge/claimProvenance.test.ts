// Hermetic unit tests for the Phase 3 SOP claim provenance (ADR-T15):
// linking a document's top-confidence claims to an SOP via sop_citations.
// Conflict-aware fake honors the (sop_id, claim_id) unique constraint from
// migration 036 so idempotency assertions are meaningful.

import { installHarness } from '../harness/index.js';
import { linkDocumentClaimsToSop } from '../../src/knowledge/claimProvenance.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ CLAIM-PROVENANCE TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ CLAIM-PROVENANCE TEST FAILED: ${name}`, extra ?? '');
  }
}

const clone = <T,>(value: T): T => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

type Row = Record<string, any>;

function makeFakeDb() {
  const claims: Row[] = [];
  const citations: Row[] = [];
  const tables: Record<string, Row[]> = { knowledge_claims: claims, sop_citations: citations };

  const upsertRow = (table: string, row: Row, onConflict?: string) => {
    const rows = tables[table];
    let existing: Row | undefined;
    if (onConflict) {
      const cols = onConflict.split(',').map((c) => c.trim());
      existing = rows.find((r) => cols.every((c) => r[c] === row[c]));
    } else {
      existing = rows.find((r) => r.id === row.id);
    }
    if (existing) Object.assign(existing, row);
    else rows.push({ ...row });
  };

  const matches = (r: Row, filters: Array<[string, unknown]>): boolean =>
    filters.every(([col, val]) => r[col] === val);

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let limit: number | null = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    const q: any = {};
    q.select = () => q;
    q.eq = (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    };
    q.in = () => q;
    q.is = () => q;
    q.order = (col: string, opts: { ascending?: boolean } = {}) => {
      orderCol = col;
      orderAsc = opts.ascending !== false;
      return q;
    };
    q.limit = (n: number) => {
      limit = n;
      return q;
    };
    q.upsert = (payload: unknown, opts?: { onConflict?: string }) => {
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const row of rows as Row[]) upsertRow(table, row, opts?.onConflict);
      return q;
    };
    q.then = (resolve: (v: any) => any) => {
      let rows = tables[table].filter((r) => matches(r, filters));
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderCol as string];
          const bv = b[orderCol as string];
          const cmp = av === bv ? 0 : av < bv ? -1 : 1;
          return orderAsc ? cmp : -cmp;
        });
      }
      if (limit != null) rows = rows.slice(0, limit);
      return Promise.resolve({ data: clone(rows), error: null }).then(resolve);
    };
    return q;
  };

  return { client: { from }, state: { claims, citations } };
}

async function testLinksTopConfidenceClaims(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.claims.push(
    { id: 'claim-low', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.4 },
    { id: 'claim-high', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.95 },
    { id: 'claim-mid', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.7 },
    { id: 'claim-other-doc', workspace_id: 'ws-1', source_document_id: 'doc-2', confidence: 0.99 }
  );

  const linked = await linkDocumentClaimsToSop({
    workspaceId: 'ws-1',
    sopId: 'sop-1',
    sourceDocumentId: 'doc-1',
    limit: 2,
    client: db.client as any,
  });

  check('linked exactly two claims (limit)', linked === 2);
  const linkedIds = db.state.citations.map((c: Row) => c.claim_id);
  check('linked the two HIGHEST-confidence claims', linkedIds.includes('claim-high') && linkedIds.includes('claim-mid'));
  check('did not link the low-confidence claim', !linkedIds.includes('claim-low'));
  check('did not link claims from another document', !linkedIds.includes('claim-other-doc'));
  check('citation rows bound to the sop', db.state.citations.every((c: Row) => c.sop_id === 'sop-1'));
  return success;
}

async function testNoClaimsIsNoOp(): Promise<boolean> {
  const db = makeFakeDb();
  const linked = await linkDocumentClaimsToSop({
    workspaceId: 'ws-1',
    sopId: 'sop-1',
    sourceDocumentId: 'doc-empty',
    client: db.client as any,
  });
  check('zero claims -> zero links', linked === 0);
  check('no citation rows written', db.state.citations.length === 0);
  return success;
}

async function testIdempotentRelink(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.claims.push(
    { id: 'claim-a', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.9 },
    { id: 'claim-b', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.8 }
  );

  await linkDocumentClaimsToSop({
    workspaceId: 'ws-1',
    sopId: 'sop-1',
    sourceDocumentId: 'doc-1',
    client: db.client as any,
  });
  const second = await linkDocumentClaimsToSop({
    workspaceId: 'ws-1',
    sopId: 'sop-1',
    sourceDocumentId: 'doc-1',
    client: db.client as any,
  });

  check('relink reports same count', second === 2);
  check('no duplicate citation rows', db.state.citations.length === 2);
  return success;
}

async function testWorkspaceScoping(): Promise<boolean> {
  const db = makeFakeDb();
  db.state.claims.push(
    { id: 'claim-own', workspace_id: 'ws-1', source_document_id: 'doc-1', confidence: 0.9 },
    { id: 'claim-foreign', workspace_id: 'ws-2', source_document_id: 'doc-1', confidence: 0.9 }
  );

  const linked = await linkDocumentClaimsToSop({
    workspaceId: 'ws-1',
    sopId: 'sop-1',
    sourceDocumentId: 'doc-1',
    client: db.client as any,
  });

  check('only own-workspace claims linked', linked === 1 && db.state.citations[0].claim_id === 'claim-own');
  return success;
}

async function testReadFailureThrows(): Promise<boolean> {
  // A client whose knowledge_claims reads always fail.
  const failingClient = {
    from: (table: string) => {
      const q: any = {};
      q.select = () => q;
      q.eq = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.upsert = () => q;
      q.then = (resolve: (v: any) => any) =>
        Promise.resolve({ data: null, error: { message: 'connection refused' } }).then(resolve);
      void table;
      return q;
    },
  };

  let threw = false;
  try {
    await linkDocumentClaimsToSop({
      workspaceId: 'ws-1',
      sopId: 'sop-1',
      sourceDocumentId: 'doc-1',
      client: failingClient as any,
    });
  } catch (err) {
    threw = String((err as Error).message).includes('Failed to read claims');
  }
  check('claim read failure throws', threw);
  return success;
}

export async function runClaimProvenanceTests(): Promise<boolean> {
  await installHarness();
  const suites: Array<() => Promise<boolean>> = [
    testLinksTopConfidenceClaims,
    testNoClaimsIsNoOp,
    testIdempotentRelink,
    testWorkspaceScoping,
    testReadFailureThrows,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[ClaimProvenance Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaimProvenanceTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
