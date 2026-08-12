// Hermetic unit tests for the Phase 3 entity resolver (ADR-T15): canonical
// corpus writes (deterministic slugs, alias rows, GREATEST confidence merge)
// plus the legacy graph_nodes/graph_edges projection. Uses a conflict-aware
// in-memory fake honoring the migration-036 unique keys so idempotency
// assertions are meaningful.

import { installHarness } from '../harness/index.js';
import { resolveEntitiesForDocument } from '../../src/knowledge/entityResolver.js';
import { canonicalizeEntity } from '../../src/services/graph/entityDisambiguator.js';
import { supabase } from '../../src/config/supabase.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ ENTITY-RESOLVER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ ENTITY-RESOLVER TEST FAILED: ${name}`, extra ?? '');
  }
}

const clone = <T,>(value: T): T => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

type Row = Record<string, any>;

/** Conflict-aware fake for the corpus + graph tables. */
function makeFakeDb() {
  const tables: Record<string, Row[]> = {
    entities: [],
    entity_aliases: [],
    entity_relationships: [],
    graph_nodes: [],
    graph_edges: [],
  };
  const uuid = (): string => crypto.randomUUID();

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
    else {
      if (row.id == null) row.id = uuid();
      rows.push({ ...row });
    }
  };

  const matches = (r: Row, filters: Array<[string, unknown]>): boolean => filters.every(([col, val]) => r[col] === val);

  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Row | null = null;
    const q: any = {};
    q.select = (c: string) => {
      void c; // column projection is a no-op in this suite's fake
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
    q.update = (patch: Row) => {
      pendingUpdate = patch;
      return q;
    };
    q.delete = () => q;
    q.maybeSingle = () => {
      const row = tables[table].find((r) => matches(r, filters)) ?? null;
      return Promise.resolve({ data: row ? clone(row) : null, error: null });
    };
    q.single = q.maybeSingle;
    q.then = (resolve: (v: any) => any) => {
      if (pendingUpdate) {
        for (const r of tables[table]) {
          if (matches(r, filters)) Object.assign(r, pendingUpdate);
        }
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    };
    return q;
  };

  return { client: { from }, state: tables };
}

async function testCanonicalSlugsFromAliasDictionary(): Promise<boolean> {
  const db = makeFakeDb();
  const summary = await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-1',
    sourceDocumentId: 'doc-1',
    entities: [
      { name: 'PostgreSQL', type: 'System' },
      { name: 'Stripe Payments', type: 'System' },
      { name: 'Slack', type: 'System' },
    ],
    relationships: [],
    client: db.client as any,
  });

  check('three entities resolved', summary.entitiesResolved === 3);
  const ids = new Set(db.state.entities.map((e: Row) => e.entity_id));
  check('PostgreSQL canonicalized to postgresql_db', ids.has('postgresql_db'));
  check('Stripe Payments canonicalized to stripe_api', ids.has('stripe_api'));
  check('Slack canonicalized to slack_workspace', ids.has('slack_workspace'));
  check('alias rows written for every raw mention', db.state.entity_aliases.length === 3);
  const aliasEntities = new Set(db.state.entity_aliases.map((a: Row) => a.entity_id));
  check('alias rows bound to canonical entities', aliasEntities.size === 3);
  return success;
}

async function testConfidenceGreatestMergeAndLastSeen(): Promise<boolean> {
  const db = makeFakeDb();
  const canonical = canonicalizeEntity('postgres', 'System');
  db.state.entities.push({
    workspace_id: 'ws-ent-1',
    entity_id: canonical,
    canonical_name: 'postgres',
    entity_type: 'System',
    confidence: 0.3,
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-01-01T00:00:00.000Z',
  });

  const summary = await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-1',
    sourceDocumentId: 'doc-1',
    entities: [{ name: 'postgres', type: 'System' }],
    relationships: [],
    client: db.client as any,
  });

  check('resolved one entity', summary.entitiesResolved === 1);
  // Phase 3 N5: confidence is derived from sighting volume, not hardcoded 1.0.
  // First sighting baseline 0.7; GREATEST(prev 0.3, derived 0.7) = 0.7.
  check('confidence merged upward (GREATEST, derived)', db.state.entities[0].confidence === 0.7, db.state.entities[0].confidence);
  check('times_seen bumped on re-sighting', db.state.entities[0].times_seen === 2, db.state.entities[0].times_seen);
  check('first_seen_at preserved', db.state.entities[0].first_seen_at === '2026-01-01T00:00:00.000Z');
  check('last_seen_at bumped to now', db.state.entities[0].last_seen_at.startsWith(new Date().toISOString().slice(0, 10)));
  check('no duplicate canonical row', db.state.entities.length === 1);
  return success;
}

async function testIdempotentReprocessing(): Promise<boolean> {
  const db = makeFakeDb();
  const input = {
    workspaceId: 'ws-ent-1',
    sourceDocumentId: 'doc-1',
    entities: [
      { name: 'PostgreSQL', type: 'System' },
      { name: 'Deploy Runbook', type: 'SOP' },
    ],
    relationships: [
      { source: 'Deploy Runbook', target: 'PostgreSQL', relationship_type: 'REQUIRES' },
    ],
    client: db.client as any,
  };

  const first = await resolveEntitiesForDocument(input);
  const second = await resolveEntitiesForDocument(input);

  check('first pass resolved 2 entities', first.entitiesResolved === 2);
  check('second pass resolved 2 entities', second.entitiesResolved === 2);
  check('canonical rows not duplicated', db.state.entities.length === 2);
  check('alias rows not duplicated', db.state.entity_aliases.length === 2);
  check('relationship rows not duplicated', db.state.entity_relationships.length === 1);
  check('relationship idempotent re-merge keeps single row', db.state.entity_relationships[0].source_entity_id !== undefined);
  return success;
}

async function testProjectionForEnumRelationship(): Promise<boolean> {
  const db = makeFakeDb();
  const summary = await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-proj',
    sourceDocumentId: 'doc-1',
    entities: [
      { name: 'Deploy Runbook', type: 'SOP' },
      { name: 'PostgreSQL', type: 'System' },
    ],
    relationships: [{ source: 'Deploy Runbook', target: 'PostgreSQL', relationship_type: 'requires' }],
    client: db.client as any,
  });

  check('relationship resolved (case-insensitive)', summary.relationshipsResolved === 1);
  check('edge projected', summary.projectedEdges === 1);
  check('projectionSkipped zero', summary.projectionSkipped === 0);

  // Graph writes go through graphService's module-level supabase (harness
  // fake): assert via the same client the projection uses.
  const { data: nodes } = await supabase.from('graph_nodes').select('*').eq('workspace_id', 'ws-ent-proj');
  const { data: edges } = await supabase.from('graph_edges').select('*').eq('workspace_id', 'ws-ent-proj');
  const nodeIds = new Set((nodes ?? []).map((n: Row) => n.id));
  const runbookId = canonicalizeEntity('Deploy Runbook', 'SOP');
  const postgresId = canonicalizeEntity('PostgreSQL', 'System');
  check(
    'both endpoint nodes projected with workspace-namespaced ids',
    nodeIds.has(`ws-ent-proj:${runbookId}`) && nodeIds.has(`ws-ent-proj:${postgresId}`)
  );
  check('no bare canonical slug used as a node id', !nodeIds.has(runbookId) && !nodeIds.has(postgresId));
  check('edge row written', (edges ?? []).length === 1);
  const edge = (edges ?? [])[0];
  check('edge_type normalized uppercase', edge?.edge_type === 'REQUIRES');
  check('edge scoped to workspace', edge?.workspace_id === 'ws-ent-proj');
  check('edge endpoints use the namespaced node ids', edge?.source_id === `ws-ent-proj:${runbookId}` && edge?.target_id === `ws-ent-proj:${postgresId}`);
  check('projected_at marked on canonical relationship', db.state.entity_relationships[0].projected_at != null);
  return success;
}

async function testNonEnumRelationshipStoredButNotProjected(): Promise<boolean> {
  const db = makeFakeDb();
  const summary = await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-nonenum',
    sourceDocumentId: 'doc-1',
    entities: [
      { name: 'Slack', type: 'System' },
      { name: 'Linear', type: 'System' },
    ],
    relationships: [{ source: 'Slack', target: 'Linear', relationship_type: 'SYNCS_WITH' }],
    client: db.client as any,
  });

  check('non-enum relationship stored canonically', summary.relationshipsResolved === 1);
  check('projection skipped', summary.projectionSkipped === 1);
  check('canonical relationship row exists', db.state.entity_relationships.length === 1);
  const { data: nodes } = await supabase.from('graph_nodes').select('*').eq('workspace_id', 'ws-ent-nonenum');
  const { data: edges } = await supabase.from('graph_edges').select('*').eq('workspace_id', 'ws-ent-nonenum');
  check('no graph edge written', (edges ?? []).length === 0);
  check('no graph nodes written', (nodes ?? []).length === 0);
  check('projected_at NOT marked', db.state.entity_relationships[0].projected_at == null);
  return success;
}

async function testUnnameableAndSelfRelationshipsSkipped(): Promise<boolean> {
  const db = makeFakeDb();
  const summary = await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-skip',
    sourceDocumentId: 'doc-1',
    entities: [{ name: '   ', type: 'System' }],
    relationships: [{ source: 'PostgreSQL', target: 'postgresql', relationship_type: 'DEPENDS_ON' }],
    client: db.client as any,
  });

  check('unnameable entity skipped', summary.skipped >= 1);
  check('no canonical entity row for empty name', db.state.entities.length === 0);
  check('self-relationship skipped', summary.skipped >= 2);
  check('no relationship row for self-edge', db.state.entity_relationships.length === 0);
  const { data: nodes } = await supabase.from('graph_nodes').select('*').eq('workspace_id', 'ws-ent-skip');
  const { data: edges } = await supabase.from('graph_edges').select('*').eq('workspace_id', 'ws-ent-skip');
  check('no graph writes at all', (nodes ?? []).length === 0 && (edges ?? []).length === 0);
  return success;
}

async function testWorkspaceIsolation(): Promise<boolean> {
  const db = makeFakeDb();
  const ws1 = canonicalizeEntity('PostgreSQL', 'System');
  db.state.entities.push({
    workspace_id: 'ws-ent-1',
    entity_id: ws1,
    canonical_name: 'PostgreSQL',
    entity_type: 'System',
    confidence: 1.0,
    last_seen_at: '2026-01-01T00:00:00.000Z',
  });

  await resolveEntitiesForDocument({
    workspaceId: 'ws-ent-2',
    sourceDocumentId: 'doc-2',
    entities: [{ name: 'PostgreSQL', type: 'System' }],
    relationships: [],
    client: db.client as any,
  });

  const ws1Row = db.state.entities.find((e: Row) => e.workspace_id === 'ws-ent-1');
  const ws2Row = db.state.entities.find((e: Row) => e.workspace_id === 'ws-ent-2');
  check('ws-1 canonical row untouched', ws1Row?.last_seen_at === '2026-01-01T00:00:00.000Z');
  check('ws-2 gets its own canonical row', ws2Row?.workspace_id === 'ws-ent-2' && ws2Row?.entity_id === ws1);
  return success;
}

async function testCrossWorkspaceProjectionIsolation(): Promise<boolean> {
  // Regression (Phase 3 audit B4): two workspaces resolving the SAME entity
  // must never clobber each other's projected graph_nodes row. graph_nodes.id
  // is a global PK; namespaced projection ids keep the upsert collision-free.
  const db = makeFakeDb();
  const input = (workspaceId: string, docId: string) => ({
    workspaceId,
    sourceDocumentId: docId,
    entities: [
      { name: 'Deploy Runbook', type: 'SOP' },
      { name: 'PostgreSQL', type: 'System' },
    ],
    relationships: [{ source: 'Deploy Runbook', target: 'PostgreSQL', relationship_type: 'REQUIRES' }],
    client: db.client as any,
  });

  await resolveEntitiesForDocument(input('ws-a', 'doc-a'));
  await resolveEntitiesForDocument(input('ws-b', 'doc-b'));

  const { data: nodesA } = await supabase.from('graph_nodes').select('*').eq('workspace_id', 'ws-a');
  const { data: nodesB } = await supabase.from('graph_nodes').select('*').eq('workspace_id', 'ws-b');
  const { data: edgesA } = await supabase.from('graph_edges').select('*').eq('workspace_id', 'ws-a');
  const { data: edgesB } = await supabase.from('graph_edges').select('*').eq('workspace_id', 'ws-b');

  const runbookId = canonicalizeEntity('Deploy Runbook', 'SOP');
  const postgresId = canonicalizeEntity('PostgreSQL', 'System');
  check('workspace A projects its own namespaced nodes', ((nodesA ?? []) as Row[]).some((n) => n.id === `ws-a:${runbookId}`) && ((nodesA ?? []) as Row[]).some((n) => n.id === `ws-a:${postgresId}`));
  check('workspace B projects its own namespaced nodes', ((nodesB ?? []) as Row[]).some((n) => n.id === `ws-b:${runbookId}`) && ((nodesB ?? []) as Row[]).some((n) => n.id === `ws-b:${postgresId}`));
  check('no cross-workspace node clobbering (2+2 distinct rows)', (nodesA ?? []).length === 2 && (nodesB ?? []).length === 2 && ((nodesA ?? []) as Row[]).every((n) => !((nodesB ?? []) as Row[]).some((m) => m.id === n.id)));
  check('workspace A edge references only A nodes', ((edgesA ?? []) as Row[]).length === 1 && ((edgesA ?? []) as Row[])[0].source_id.startsWith('ws-a:') && ((edgesA ?? []) as Row[])[0].target_id.startsWith('ws-a:'));
  check('workspace B edge references only B nodes', ((edgesB ?? []) as Row[]).length === 1 && ((edgesB ?? []) as Row[])[0].source_id.startsWith('ws-b:') && ((edgesB ?? []) as Row[])[0].target_id.startsWith('ws-b:'));
  check('canonical corpus stays workspace-scoped (4 canonical rows)', db.state.entities.length === 4);
  return success;
}

export async function runEntityResolverTests(): Promise<boolean> {
  await installHarness();
  const suites: Array<() => Promise<boolean>> = [
    testCanonicalSlugsFromAliasDictionary,
    testConfidenceGreatestMergeAndLastSeen,
    testIdempotentReprocessing,
    testProjectionForEnumRelationship,
    testNonEnumRelationshipStoredButNotProjected,
    testUnnameableAndSelfRelationshipsSkipped,
    testWorkspaceIsolation,
    testCrossWorkspaceProjectionIsolation,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[EntityResolver Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEntityResolverTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
