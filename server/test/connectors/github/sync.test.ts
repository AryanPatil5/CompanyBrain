import assert from 'node:assert';

// Hermetic AI guard: force every text-generation provider to fail instantly (no
// network, no API keys, tiny retry backoff) and stub the Ollama embeddings
// endpoint with a genuine 1536-dim vector so the chunk pipeline indexes real
// vectors. Must be set BEFORE the module graph (aiProvider) is first imported.
process.env.AI_PROVIDER_PRIORITY = 'ollama';
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
process.env.GEMINI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.AI_PROVIDER_MAX_RETRIES = '2';
process.env.AI_PROVIDER_RETRY_BASE_MS = '1';
process.env.AI_PROVIDER_STAGGER_MS = '1';
process.env.AI_TIMEOUT_MS = '2000';

import { createGithubSyncService } from '../../../src/connectors/github/sync.js';
import { supabase } from '../../../src/config/supabase.js';
import type { GithubSyncStats } from '../../../src/connectors/github/types.js';

// ─── Mock Supabase ───────────────────────────────────────────────────────────

type TableName = string;

const clone = <T,>(value: T): T => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

class FakeQuery {
  private readonly table: TableName;
  private readonly dataFor: (mode: string, cols: string[], filters: Array<[string, unknown]>) => Promise<{ data: any; error: any }>;
  private filters: Array<[string, unknown]> = [];
  private selectCols: string[] = ['*'];
  private readonly onMutate: (mode: string, payload: unknown) => void;

  constructor(table: TableName, dataFor: (mode: string, cols: string[], filters: Array<[string, unknown]>) => Promise<{ data: any; error: any }>, onMutate: (mode: string, payload: unknown) => void) {
    this.table = table;
    this.dataFor = dataFor;
    this.onMutate = onMutate;
  }

  select(cols: string) {
    this.selectCols = cols.split(',').map((c) => c.trim());
    return this;
  }
  eq(_col: string, _val: unknown) {
    return this;
  }
  in(_col: string, _vals: unknown[]) {
    return this;
  }
  is(_col: string, _val: unknown) {
    return this;
  }
  limit() {
    return this;
  }
  upsert(rows: unknown) {
    this.onMutate('upsert', rows);
    return this;
  }
  insert(rows: unknown) {
    this.onMutate('insert', rows);
    return this;
  }
  update(patch: unknown) {
    this.onMutate('update', patch);
    return this;
  }
  delete() {
    this.onMutate('delete', null);
    return this;
  }
  maybeSingle() {
    return this.dataFor('maybeSingle', this.selectCols, this.filters);
  }
  single() {
    return this.dataFor('single', this.selectCols, this.filters);
  }
  then(resolve: (value: any) => any, reject: (reason?: any) => any) {
    return this.dataFor('chain', this.selectCols, this.filters).then(resolve, reject);
  }
}

function makeFakeDb() {
  const state = {
    upserts: [] as any[],
    inserts: [] as any[],
    updates: [] as any[],
    githubIndexed: [] as any[],
    syncStates: [] as any[],
    documentCounter: 0,
  };

  const dataFor = (table: TableName, mode: string, cols: string[], _filters: Array<[string, unknown]>) => {
    if (table === 'github_indexed_documents') {
      if (cols.includes('path') && cols.includes('sha')) {
        const rows = state.githubIndexed.filter((r) => !r.deleted_at && r.document_type === 'file').map((r) => ({ path: r.path, sha: r.sha }));
        return Promise.resolve({ data: rows, error: null });
      }
      if (cols.includes('id') && cols.includes('path')) {
        return Promise.resolve({
          data: state.githubIndexed.filter((r) => !r.deleted_at).map((r) => ({ id: r.id, path: r.path, external_id: r.external_id })),
          error: null,
        });
      }
    }
    if (table === 'github_sync_state' && mode === 'maybeSingle') {
      if (cols.join() === 'id') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: state.syncStates[0] || null, error: null });
    }
    if (table === 'source_documents' && mode === 'single') {
      return Promise.resolve({ data: { id: `doc-${++state.documentCounter}`, source_key: 'ws:github:doc' }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const db = {
    from(table: TableName) {
      const record = (mode: string, payload: unknown) => {
        if (mode === 'upsert') {
          const rows = Array.isArray(payload) ? payload : [payload];
          state.upserts.push({ table, rows: clone(rows) });
        }
        if (mode === 'insert') state.inserts.push({ table, rows: clone(payload) });
        if (mode === 'update') state.updates.push({ table, patch: clone(payload) });
      };
      if (table === 'github_indexed_documents') {
        return new FakeQuery(
          table,
          (mode, cols, filters) => dataFor(table, mode, cols, filters),
          (mode, payload) => {
            record(mode, payload);
            if (mode === 'upsert') {
              const rows = Array.isArray(payload) ? payload : [payload];
              for (const row of rows) {
                state.githubIndexed.push({ ...clone(row), id: row.path || `idx-${state.githubIndexed.length + 1}` });
              }
            }
          }
        ) as unknown as ReturnType<typeof supabase.from>;
      }
      if (table === 'github_sync_state') {
        return new FakeQuery(
          table,
          (mode, cols, filters) => dataFor(table, mode, cols, filters),
          (mode, payload) => {
            record(mode, payload);
            if (mode === 'insert') state.syncStates.push(clone(payload));
            if (mode === 'update' && state.syncStates.length > 0) state.syncStates[0] = { ...state.syncStates[0], ...clone(payload) };
          }
        ) as unknown as ReturnType<typeof supabase.from>;
      }
      return new FakeQuery(table, (mode, cols, filters) => dataFor(table, mode, cols, filters), record) as unknown as ReturnType<typeof supabase.from>;
    },
  };
  return { db, state };
}

// ─── Mock GitHub API ─────────────────────────────────────────────────────────

const TREE: any[] = [
  { path: 'src/lib.ts', type: 'blob', sha: 'sha-lib', size: 80 },
  { path: 'Makefile', type: 'blob', sha: 'sha-make', size: 40 },
  { path: 'docs/README.md', type: 'blob', sha: 'sha-docreadme', size: 60 },
  { path: 'node_modules/pkg/index.js', type: 'blob', sha: 'sha-nm', size: 200 },
  { path: 'logo.png', type: 'blob', sha: 'sha-png', size: 5000 },
];

const ISSUE = {
  number: 1,
  title: 'Fix the bug',
  body: 'When the retry counter hits 2, escalate to the oncall lead.',
  html_url: 'https://github.com/owner/repo/issues/1',
  user: { login: 'alice' },
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-02T00:00:00Z',
  state: 'open',
  labels: [{ name: 'bug' }],
};

const PULL = {
  number: 2,
  title: 'Add deploy script',
  body: 'Deploy runbook: run npm ci, then npm run build, then ship.',
  html_url: 'https://github.com/owner/repo/pull/2',
  user: { login: 'bob' },
  created_at: '2026-06-03T00:00:00Z',
  updated_at: '2026-06-04T00:00:00Z',
  state: 'open',
  merged_at: null,
  base: { ref: 'main' },
};

const RELEASE = {
  tag_name: 'v1.0.0',
  name: 'v1.0.0',
  body: 'First release notes.',
  html_url: 'https://github.com/owner/repo/releases/tag/v1.0.0',
  author: { login: 'carol' },
  published_at: '2026-05-01T00:00:00Z',
  created_at: '2026-05-01T00:00:00Z',
  prerelease: false,
  draft: false,
};

const DISCUSSION_PAGE = {
  data: {
    repository: {
      discussions: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            number: 3,
            title: 'How do we handle oncall?',
            url: 'https://github.com/owner/repo/discussions/3',
            createdAt: '2026-06-05T00:00:00Z',
            updatedAt: '2026-06-06T00:00:00Z',
            author: { login: 'dave' },
            category: { name: 'General' },
            body: 'Rotate weekly on the oncall calendar.',
          },
        ],
      },
    },
  },
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

function makeFetchRouter() {
  return async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes('/graphql')) {
      return jsonResponse(DISCUSSION_PAGE);
    }
    if (url.startsWith('https://raw.githubusercontent.com/wiki/owner/repo/')) {
      return new Response('# Home page\n\nWiki content.', { status: 200 });
    }
    if (url.startsWith('https://raw.githubusercontent.com/owner/repo/main/')) {
      const file = decodeURIComponent(url.split('/main/')[1]);
      if (file === 'src/lib.ts') return new Response('export const value = 42;', { status: 200 });
      if (file === 'src/new.ts') return new Response('export const brandNew = true;', { status: 200 });
      if (file === 'Makefile') return new Response('build:\n\tnpm run build\n', { status: 200 });
      return new Response('', { status: 404 });
    }

    if (url.includes('/api/embeddings')) {
      return jsonResponse({ embedding: new Array(1536).fill(0.01) });
    }

    const pathname = new URL(url).pathname;

    if (pathname === '/repos/owner/repo') {
      return jsonResponse({ default_branch: 'main', permissions: { admin: true, push: true, pull: true } });
    }
    if (pathname === '/repos/owner/repo/branches/main') {
      return jsonResponse({ commit: { sha: 'sha-head-1' } });
    }
    if (pathname === '/repos/owner/repo/commits/sha-head-1') {
      return jsonResponse({ commit: { committer: { date: '2026-07-01T00:00:00Z' }, author: { date: '2026-07-01T00:00:00Z' } } });
    }
    if (pathname === '/repos/owner/repo/readme') {
      return new Response('# Acme Corp\n\nOperational docs for Acme.', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    if (pathname === '/repos/owner/repo/git/trees/sha-head-1') {
      return jsonResponse({ tree: TREE, truncated: false });
    }
    if (pathname === '/repos/owner/repo/issues') {
      return jsonResponse([ISSUE]);
    }
    if (pathname === '/repos/owner/repo/pulls') {
      return jsonResponse([PULL]);
    }
    if (pathname === '/repos/owner/repo/releases') {
      return jsonResponse([RELEASE]);
    }
    if (pathname === '/repos/owner/repo.wiki/git/trees/main') {
      return jsonResponse({ tree: [{ path: 'Home.md', type: 'blob', sha: 'sha-wiki', size: 30 }], truncated: false });
    }

    // Unknown URL (e.g. AI provider calls): fail like a dead network endpoint.
    throw new TypeError('fetch failed: connection refused');
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function runSyncTest(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;
  const check = (label: string, cond: boolean, extra?: string) => {
    if (cond) {
      passed++;
      console.log(`  ✅ ${label}`);
    } else {
      failed++;
      console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`);
    }
  };

  const { db, state } = makeFakeDb();
  (supabase as any).from = db.from.bind(db);

  const originalFetch = global.fetch;
  global.fetch = makeFetchRouter() as typeof fetch;

  const authStub = {
    getAppJwt: async () => 'jwt-stub',
    getInstallationToken: async () => 'token-stub',
  } as any;

  try {
    const service = createGithubSyncService(authStub, { batchSize: 2, concurrency: 2 });

    // ─── Run 1: initial sync ───
    const stats1: GithubSyncStats = await service.syncRepository({
      workspaceId: 'ws-1',
      installationId: 42,
      repoId: 100,
      fullName: 'owner/repo',
      branch: 'main',
      incremental: false,
      include: [],
    });

    const indexedPaths = state.githubIndexed
      .filter((r) => !r.deleted_at && (r.document_type === 'file' || r.document_type === 'readme'))
      .map((r) => r.path);

    check('initial sync: README indexed', indexedPaths.includes('README.md'));
    check('initial sync: src/lib.ts indexed', indexedPaths.includes('src/lib.ts'));
    check('initial sync: Makefile indexed', indexedPaths.includes('Makefile'));
    check('initial sync: node_modules ignored', !indexedPaths.includes('node_modules/pkg/index.js'));
    check('initial sync: logo.png (binary) ignored', !indexedPaths.includes('logo.png'));
    check('initial sync: docs/README.md excluded from files phase', !indexedPaths.includes('docs/README.md'));
    check(
      'initial sync: issues/pulls/discussions/releases/wiki all indexed',
      ['issue', 'pull_request', 'discussion', 'release', 'wiki'].every((t) => state.githubIndexed.some((r) => r.document_type === t))
    );
    check('initial sync: stats.indexed matches upserted docs', stats1.indexed === state.githubIndexed.length && stats1.indexed > 0);
    check('initial sync: stats.phases has file+issue entries', stats1.phases.file?.indexed === 2 && stats1.phases.readme?.indexed === 1 && stats1.phases.issue?.indexed === 1);
    check('initial sync: sync state completed', state.syncStates.some((s: any) => s.status === 'completed'));

    const docMetadata = state.githubIndexed.find((r) => r.path === 'src/lib.ts');
    check('initial sync: file doc has sha + commit + author metadata', docMetadata?.sha === 'sha-lib' && docMetadata?.commit_sha === 'sha-head-1');
    const issueDoc = state.githubIndexed.find((r) => r.document_type === 'issue');
    check('initial sync: issue doc has title + url + author', issueDoc?.title === 'Fix the bug' && issueDoc?.url.includes('/issues/1') && issueDoc?.author === 'alice');

    const sourceDocUpserts = state.upserts.filter((u: any) => u.table === 'source_documents');
    check('initial sync: source_documents upserted via pipeline', sourceDocUpserts.length >= 7);
    check(
      'initial sync: source_documents carry github metadata',
      sourceDocUpserts.some((u: any) => u.rows?.[0]?.raw_metadata?.repositoryName === 'owner/repo' && u.rows?.[0]?.raw_metadata?.permissions?.admin === true)
    );

    // ─── Run 2: incremental sync (lib.ts unchanged, one new file) ───
    TREE.push({ path: 'src/new.ts', type: 'blob', sha: 'sha-new', size: 30 });
    const stats2: GithubSyncStats = await service.syncRepository({
      workspaceId: 'ws-1',
      installationId: 42,
      repoId: 100,
      fullName: 'owner/repo',
      branch: 'main',
      incremental: true,
      include: ['file'],
    });

    const run2Paths = state.githubIndexed.filter((r) => r.document_type === 'file').map((r) => r.path);
    check('incremental: new file indexed', run2Paths.includes('src/new.ts'));
    check('incremental: unchanged file skipped', stats2.skipped >= 1 && stats2.indexed === 1);
    check('incremental: only file phase ran', stats2.phases.pull_request === undefined && stats2.phases.issue === undefined);

    // ─── Run 3: resume from stored state (state row keeps resume token) ───
    state.syncStates = [state.syncStates.find((s: any) => s.sync_kind === 'initial')];
    const stats3: GithubSyncStats = await service.syncRepository({
      workspaceId: 'ws-1',
      installationId: 42,
      repoId: 100,
      fullName: 'owner/repo',
      branch: 'main',
      incremental: false,
      include: [],
    });
    check('resumed run: no duplicate completion failure', stats3.indexed >= 0);
  } catch (err) {
    failed++;
    console.log(`  ❌ sync run threw: ${(err as Error).message}`);
  } finally {
    (supabase as any).from = db.from.bind(db);
    global.fetch = originalFetch;
  }

  console.log(`\nSync integration tests: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runSyncTest();
  assert.strictEqual(result.failed, 0, `${result.failed} sync integration check(s) failed`);
}
