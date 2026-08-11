// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — Connector conformance suite (test/connectors/conformance.test.ts)
//
// The reusable contract-invariant suite that gates Phase 12 SDK authors
// (roadmap: "Connector contract tests as a conformance suite — the same suite
// gates Phase 12 SDK authors"). runConformance(connector, ctx) asserts the
// invariants ANY connector must satisfy; runConnectorConformanceTest() then
// runs it against the production GitHub adapter plus adapter-specific checks
// (capability reporting, registry dispatch, error taxonomy mapping,
// checkpoint snapshot, cross-workspace isolation).
//
// All hermetic: harness stubs; the GitHub adapter is driven with an injected
// auth (dummy credentials), a stubbed GithubSyncService, and a deterministic
// workspace resolver — no network, no live Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import { installHarness } from '../harness/index.js';
import { supabase } from '../../src/config/supabase.js';
import {
  Connector,
  ConnectorError,
  SourceAcl,
  SourceObject,
} from '../../src/connectors/types.js';
import { registerConnector, clearConnectorRegistry, dispatchConnectorSync } from '../../src/connectors/registry.js';
import { GithubConnector, createGithubConnector, mapGitHubError } from '../../src/connectors/githubConnector.js';
import { GithubSyncService } from '../../src/connectors/github/sync.js';
import { GitHubAppAuth, GitHubAuthError } from '../../src/connectors/github/auth.js';
import { GitHubApiError } from '../../src/connectors/github/client.js';

const WORKSPACE_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WORKSPACE_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

// ─── Shared helpers ──────────────────────────────────────────────────────────

function checkOk(name: string, ok: boolean, detail?: unknown): { name: string; ok: boolean; detail?: string } {
  return { name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) };
}

const CREDENTIAL_KEY_RE = /(token|secret|password|credential|authorization|private[_ ]?key|api[_ ]?key|access[_ ]?key|oauth|bearer)/i;

function scanForCredentialKeys(node: unknown, leaked: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((n) => scanForCredentialKeys(n, leaked));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (CREDENTIAL_KEY_RE.test(k)) leaked.push(k);
      scanForCredentialKeys(v, leaked);
    }
  }
}

function isValidPrincipalRef(p: unknown): boolean {
  if (!p || typeof p !== 'object') return false;
  const ref = p as { type?: unknown; id?: unknown };
  return typeof ref.type === 'string' && ['user', 'group', 'team', 'role', 'email'].includes(ref.type) && typeof ref.id === 'string' && ref.id.length > 0;
}

function isValidSourceAcl(acl: SourceAcl): boolean {
  if (typeof acl.inherited !== 'boolean') return false;
  if (!Array.isArray(acl.viewers) || !acl.viewers.every(isValidPrincipalRef)) return false;
  if (!Array.isArray(acl.teams) || !acl.teams.every(isValidPrincipalRef)) return false;
  if (acl.owner !== undefined && !isValidPrincipalRef(acl.owner)) return false;
  return 'raw_acl' in acl;
}

// ─── The reusable conformance runner (Phase 12 gate) ─────────────────────────

export interface ConformanceContext {
  workspaceId: string;
  otherWorkspaceId: string;
  /** External ids the connector is expected to list (subset is fine). */
  expectedExternalIds?: string[];
}

/**
 * Asserts the contract invariants ANY connector must satisfy. Returns a
 * boolean; prints one line per check. Safe to reuse from the Phase 12 SDK
 * conformance package.
 */
export async function runConformance(connector: Connector, ctx: ConformanceContext): Promise<boolean> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push(checkOk(name, ok, detail));
    if (ok) console.log(`  ✅ CONFORMANCE: ${name}`);
    else console.error(`  ❌ CONFORMANCE FAILED: ${name}`, detail ?? '');
  };

  // 1. Identity + capability surface
  check('provider is non-empty', typeof connector.provider === 'string' && connector.provider.length > 0, connector.provider);
  check('displayName is non-empty', typeof connector.displayName === 'string' && connector.displayName.length > 0, connector.displayName);
  const caps = connector.capabilities;
  check(
    'capabilities surface is complete and typed',
    caps &&
      typeof caps.supportsIncremental === 'boolean' &&
      typeof caps.supportsPhasedSync === 'boolean' &&
      typeof caps.supportsAcl === 'boolean' &&
      typeof caps.supportsAttachments === 'boolean' &&
      (caps.webhookMode === 'provider_queue' || caps.webhookMode === 'durable_ledger') &&
      (caps.cursorStore === 'generic' || caps.cursorStore === 'github_sync_state') &&
      Array.isArray(caps.configSources),
    caps
  );

  // 2. isConfigured never throws and returns a boolean
  let configured: boolean | null = null;
  try {
    configured = await connector.isConfigured(ctx.workspaceId);
  } catch {
    configured = null;
  }
  check('isConfigured returns a boolean (never throws)', typeof configured === 'boolean', configured);

  // 3. listObjects: async-generator of pages; every object workspace-scoped
  const all: SourceObject[] = [];
  try {
    const gen = connector.listObjects(ctx.workspaceId);
    check('listObjects returns an async iterable', gen !== null && typeof gen === 'object' && Symbol.asyncIterator in gen);
    for await (const page of gen) {
      if (!Array.isArray(page)) {
        check('listObjects yields arrays (pages)', false, page);
        break;
      }
      all.push(...page);
    }
  } catch (err) {
    check('listObjects does not throw for a configured workspace', false, err instanceof Error ? err.message : String(err));
  }

  const wellFormed = all.every(
    (o) =>
      o &&
      typeof o.externalId === 'string' &&
      o.externalId.length > 0 &&
      typeof o.type === 'string' &&
      typeof o.title === 'string' &&
      typeof o.text === 'string' &&
      o.metadata !== undefined &&
      Array.isArray(o.attachments)
  );
  check(`listObjects yields ${all.length} well-formed SourceObjects`, wellFormed, all.length);
  check('every listed object carries the requested workspaceId', all.every((o) => o.workspaceId === ctx.workspaceId), all.map((o) => o.workspaceId));

  const leaked: string[] = [];
  all.forEach((o) => scanForCredentialKeys(o.metadata, leaked));
  check('object metadata contains no credential-shaped keys', leaked.length === 0, leaked);

  if (ctx.expectedExternalIds) {
    check(
      'expected external ids are listed',
      ctx.expectedExternalIds.every((id) => all.some((o) => o.externalId === id)),
      all.map((o) => o.externalId)
    );
  }

  // 4. fetchObject
  let fetchResult: SourceObject | null | undefined;
  try {
    const first = all[0];
    if (first) {
      fetchResult = await connector.fetchObject(ctx.workspaceId, first.externalId);
    }
  } catch {
    fetchResult = undefined;
  }
  check('fetchObject returns the object or null (never throws)', fetchResult === null || (fetchResult !== undefined && fetchResult.externalId === all[0]?.externalId), fetchResult);

  // 5. fetchAcl: null when unsupported, valid SourceAcl shape when supported
  let acl: SourceAcl | null | undefined;
  try {
    const first = all[0];
    if (first) acl = await connector.fetchAcl(ctx.workspaceId, first.externalId);
  } catch {
    acl = undefined;
  }
  if (caps.supportsAcl) {
    check('fetchAcl returns a valid SourceAcl shape when supported', acl !== null && acl !== undefined && isValidSourceAcl(acl), acl);
  } else {
    check('fetchAcl returns null when the capability is off', acl === null, acl);
  }

  // 6. getDeltaCursor never throws
  let cursorOk = false;
  try {
    const cursor = await connector.getDeltaCursor(ctx.workspaceId);
    cursorOk = true;
    void cursor;
  } catch {
    cursorOk = false;
  }
  check('getDeltaCursor does not throw', cursorOk);

  // 7. ack is idempotent and never throws
  let ackOk = true;
  try {
    if (all[0]) {
      await connector.ack(ctx.workspaceId, all[0].externalId);
      await connector.ack(ctx.workspaceId, all[0].externalId);
    }
  } catch {
    ackOk = false;
  }
  check('ack is callable twice (idempotent), never throws', ackOk);

  // 8. Cross-workspace isolation: listing another workspace must not leak
  //    this workspace's objects (and vice versa).
  const other: SourceObject[] = [];
  try {
    for await (const page of connector.listObjects(ctx.otherWorkspaceId)) other.push(...page);
  } catch {
    /* connectors may legitimately fail to list an unrelated workspace */
  }
  check(
    'listing another workspace leaks none of this workspace\'s objects',
    other.every((o) => o.workspaceId !== ctx.workspaceId) && all.every((o) => o.workspaceId === ctx.workspaceId),
    { other: other.map((o) => o.workspaceId), all: all.map((o) => o.workspaceId) }
  );

  return checks.every((c) => c.ok);
}

// ─── GitHub adapter fixtures ─────────────────────────────────────────────────

// isConfigured() reads env at call time (constructor config is env-resolved by
// the production auth). Follow the existing test/connectors/github/auth.test.ts
// pattern: pin env vars explicitly so the suite is deterministic regardless of
// what server/.env (or the shell) sets.
const GITHUB_ENV_KEYS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_PATH'] as const;

function saveGithubEnv(): Partial<Record<(typeof GITHUB_ENV_KEYS)[number], string | undefined>> {
  const saved: Partial<Record<(typeof GITHUB_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of GITHUB_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreGithubEnv(saved: Partial<Record<(typeof GITHUB_ENV_KEYS)[number], string | undefined>>): void {
  for (const key of GITHUB_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setGithubEnv(appId: string, privateKey: string, keyPath?: string): void {
  process.env.GITHUB_APP_ID = appId;
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  if (keyPath === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  else process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
}

function configuredGithubAuth(): GitHubAppAuth {
  return new GitHubAppAuth({ appId: '123456', privateKey: 'dummy-private-key-for-tests' });
}

function stubGithubService(auth: GitHubAppAuth, overrides: Partial<GithubSyncService>): GithubSyncService {
  const svc = new GithubSyncService(auth);
  return Object.assign(svc, overrides);
}

function buildGithubAdapter(opts?: {
  syncThrows?: unknown;
  /** Repos that should fail; when set, ONLY these fail (per-repo resilience). */
  failRepos?: string[];
  auth?: GitHubAppAuth;
  repoCount?: number;
}): { connector: GithubConnector; lastRequests: Array<{ workspaceId: string; incremental?: boolean; fullName: string }> } {
  const auth = opts?.auth ?? configuredGithubAuth();
  const lastRequests: Array<{ workspaceId: string; incremental?: boolean; fullName: string }> = [];

  const service = stubGithubService(auth, {
    listInstallations: async () => [{ id: 7, accountLogin: 'acme', accountType: 'Organization', targetType: '', createdAt: '', updatedAt: '' }],
    listRepositories: async () =>
      Array.from({ length: opts?.repoCount ?? 2 }, (_, i) => ({
        id: 100 + i,
        name: `repo${i}`,
        owner: 'acme',
        fullName: `acme/repo${i}`,
        defaultBranch: 'main',
        private: false,
        permissions: { pull: true, push: false },
        updatedAt: '2024-01-01T00:00:00.000Z',
      })),
    syncRepository: async (request: any) => {
      lastRequests.push({ workspaceId: request.workspaceId, incremental: request.incremental, fullName: request.fullName });
      const shouldThrow = opts?.failRepos ? opts.failRepos.includes(request.fullName) : opts?.syncThrows !== undefined;
      if (shouldThrow) throw opts?.syncThrows ?? new GitHubApiError(`simulated sync failure for ${request.fullName}`, { status: 500 });
      return { total: 5, indexed: 5, skipped: 0, failed: 0, deleted: 0, durationMs: 10, phases: { file: { indexed: 5, skipped: 0, failed: 0 } } };
    },
  } as unknown as Partial<GithubSyncService>);

  const connector = createGithubConnector({
    auth,
    service,
    workspaceResolver: async (workspaceId: string) => (workspaceId === WORKSPACE_A ? [{ installationId: 7 }] : []),
  });
  return { connector, lastRequests };
}

// ─── Suite entrypoint ────────────────────────────────────────────────────────

async function runConnectorConformanceTest(): Promise<boolean> {
  await installHarness();
  clearConnectorRegistry();
  // Deterministic GitHub credential env for the whole suite (see fixtures above).
  const savedEnv = saveGithubEnv();
  setGithubEnv('123456', 'dummy-private-key-for-tests');
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push(checkOk(name, ok, detail));
    if (ok) console.log(`✅ CONNECTOR CONFORMANCE: ${name}`);
    else console.error(`❌ CONNECTOR CONFORMANCE FAILED: ${name}`, detail ?? '');
  };

  try {
    // ─── 1. Reusable conformance runner against the GitHub adapter ──────────
    const { connector } = buildGithubAdapter();
    const conformant = await runConformance(connector, {
      workspaceId: WORKSPACE_A,
      otherWorkspaceId: WORKSPACE_B,
      expectedExternalIds: ['acme/repo0', 'acme/repo1'],
    });
    check('GitHub adapter passes the reusable conformance runner', conformant);

    // ─── 2. Capability reporting (M1 webhookMode etc.) ──────────────────────
    check(
      'github adapter reports incremental + phased sync',
      connector.capabilities.supportsIncremental === true && connector.capabilities.supportsPhasedSync === true
    );
    check('github adapter reports webhookMode=provider_queue (M1)', connector.capabilities.webhookMode === 'provider_queue');
    check('github adapter reports cursorStore=github_sync_state', connector.capabilities.cursorStore === 'github_sync_state');
    check('github adapter does not claim ACL support yet', connector.capabilities.supportsAcl === false);
    check('github adapter isConfigured true with credentials + installations', (await connector.isConfigured(WORKSPACE_A)) === true);

    // Unconfigured adapter: no env credentials → isConfigured false for every
    // workspace (truthful per-workspace semantics).
    setGithubEnv('', '', '');
    const unconfiguredConnector = createGithubConnector({ auth: new GitHubAppAuth({ appId: '', privateKey: '' }) });
    check('unconfigured adapter reports isConfigured false', (await unconfiguredConnector.isConfigured(WORKSPACE_A)) === false);
    setGithubEnv('123456', 'dummy-private-key-for-tests');

  // ─── 3. Registry dispatch through the adapter (flag-independent core) ───
  registerConnector(connector);

  const dispatched = await dispatchConnectorSync('github', WORKSPACE_A, { incremental: true });
  check('dispatch aggregates per-repo stats', dispatched.indexed === 10 && dispatched.total === 10, dispatched);

  // verify the workspace passthrough with a fresh adapter capturing requests
  const { connector: c2, lastRequests: req2 } = buildGithubAdapter();
  clearConnectorRegistry();
  registerConnector(c2);
  await dispatchConnectorSync('github', WORKSPACE_A, { incremental: true });
  check(
    'sync receives the explicit workspaceId and incremental flag',
    req2.length === 2 && req2.every((r) => r.workspaceId === WORKSPACE_A && r.incremental === true),
    req2
  );

  // Workspace with no installations is truthfully NOT configured: dispatch
  // refuses with a typed not_configured error instead of an invented empty run.
  clearConnectorRegistry();
  const { connector: c3 } = buildGithubAdapter();
  registerConnector(c3);
  let uninstalledErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_B, {});
  } catch (err) {
    uninstalledErr = err;
  }
  check(
    'dispatch to a workspace without installations throws not_configured (truthful per-workspace isConfigured)',
    uninstalledErr instanceof ConnectorError && (uninstalledErr as ConnectorError).code === 'not_configured',
    uninstalledErr
  );

  // ─── 4. Error taxonomy mapping ───────────────────────────────────────────
  clearConnectorRegistry();
  const rateLimited = buildGithubAdapter({ syncThrows: new GitHubApiError('rate limited', { status: 429, retryable: true }) });
  registerConnector(rateLimited.connector);
  let rateErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_A, {});
  } catch (err) {
    rateErr = err;
  }
  check('429 maps to typed ConnectorError rate_limited', rateErr instanceof ConnectorError && (rateErr as ConnectorError).code === 'rate_limited' && (rateErr as ConnectorError).retryable === true, (rateErr as ConnectorError)?.code);

  clearConnectorRegistry();
  const notFound = buildGithubAdapter({ syncThrows: new GitHubApiError('missing', { status: 404, retryable: false }) });
  registerConnector(notFound.connector);
  let nfErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_A, {});
  } catch (err) {
    nfErr = err;
  }
  check('404 maps to typed ConnectorError not_found', nfErr instanceof ConnectorError && (nfErr as ConnectorError).code === 'not_found', (nfErr as ConnectorError)?.code);

  clearConnectorRegistry();
  const authFailed = buildGithubAdapter({ syncThrows: new GitHubAuthError('credentials not configured') });
  registerConnector(authFailed.connector);
  let authErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_A, {});
  } catch (err) {
    authErr = err;
  }
  check('GitHubAuthError maps to typed ConnectorError not_configured', authErr instanceof ConnectorError && (authErr as ConnectorError).code === 'not_configured', (authErr as ConnectorError)?.code);

  check(
    'raw network errors map to retryable network',
    mapGitHubError(new TypeError('fetch failed')).code === 'network' && mapGitHubError(new TypeError('fetch failed')).retryable === true
  );

  // Auth failures: 401/403 at token exchange AND at API level map consistently
  // to auth_revoked (previously-valid credentials rejected).
  check('API 401 maps to auth_revoked', mapGitHubError(new GitHubApiError('bad creds', { status: 401 })).code === 'auth_revoked');
  check('API 403 maps to auth_revoked', mapGitHubError(new GitHubApiError('forbidden', { status: 403 })).code === 'auth_revoked');
  check(
    'token-exchange 401 maps to auth_revoked (status carried on GitHubAuthError)',
    mapGitHubError(new GitHubAuthError('installation token request failed with HTTP 401', { status: 401 })).code === 'auth_revoked'
  );
  check(
    'token-exchange 403 maps to auth_revoked',
    mapGitHubError(new GitHubAuthError('installation token request failed with HTTP 403', { status: 403 })).code === 'auth_revoked'
  );
  check(
    'token-exchange non-401/403 statuses stay not_configured',
    mapGitHubError(new GitHubAuthError('installation token request failed with HTTP 404', { status: 404 })).code === 'not_configured'
  );
  check(
    'auth_revoked is not retryable',
    mapGitHubError(new GitHubApiError('forbidden', { status: 403 })).retryable === false
  );

  // Timeout / retryability consistency: a timeout is transient by definition,
  // regardless of the client's retryable flag, and never falls through to
  // 'internal'.
  const clientTimeout = mapGitHubError(new GitHubApiError('GitHub request timed out after 30000ms for /x', { retryable: false }));
  check('client timeout maps to timeout with retryable=true', clientTimeout.code === 'timeout' && clientTimeout.retryable === true, clientTimeout);

  // Status-less GitHubApiError = transport-level failure (the client wraps
  // fetch rejections that way) → retryable network.
  const statusLess = mapGitHubError(new GitHubApiError('fetch failed', { retryable: true }));
  check('status-less GitHubApiError maps to retryable network', statusLess.code === 'network' && statusLess.retryable === true, statusLess);

  // 400 (bad request) is a malformed interaction, not an internal error.
  check('API 400 maps to malformed_response', mapGitHubError(new GitHubApiError('bad request', { status: 400 })).code === 'malformed_response');

  // ─── 5. getDeltaCursor cross-workspace isolation ────────────────────────
  clearConnectorRegistry();
  const { connector: c4 } = buildGithubAdapter();
  await supabase.from('github_sync_state').insert([
    { workspace_id: WORKSPACE_A, repository_id: 'acme/repo0', sync_kind: 'initial', status: 'running', resume_token: { phase: 'tree', completedPhases: [] }, updated_at: '2024-05-01T00:00:00.000Z' },
    { workspace_id: WORKSPACE_A, repository_id: 'acme/repo1', sync_kind: 'incremental', status: 'completed', resume_token: { phase: 'releases', completedPhases: ['tree', 'issues'] }, updated_at: '2024-06-01T00:00:00.000Z' },
  ]);
  const cursorA = (await c4.getDeltaCursor(WORKSPACE_A)) as any;
  check('getDeltaCursor returns the latest workspace resume token', cursorA?.resume_token?.completedPhases?.length === 2 && cursorA?.updated_at === '2024-06-01T00:00:00.000Z', cursorA);
  const cursorB = await c4.getDeltaCursor(WORKSPACE_B);
  check('getDeltaCursor for another workspace returns null (isolation)', cursorB === null, cursorB);

  // ─── 6. sync() checkpoint snapshot reflects persisted state ─────────────
  clearConnectorRegistry();
  const { connector: c5 } = buildGithubAdapter();
  const syncOut = await c5.sync({ workspaceId: WORKSPACE_A, incremental: true });
  check('sync returns aggregated stats', syncOut.result.indexed === 10, syncOut.result);
  check(
    'sync returns a checkpoint with a repo snapshot',
    Array.isArray(syncOut.checkpoint.completedPhases) && typeof syncOut.checkpoint.extra?.repositories === 'object',
    syncOut.checkpoint
  );

  // workspaceId guard on every contract method
  let guardError: unknown = null;
  try {
    await c5.sync({ workspaceId: '', incremental: true });
  } catch (err) {
    guardError = err;
  }
  check('sync refuses an empty workspaceId', guardError instanceof ConnectorError && (guardError as ConnectorError).code === 'internal');

  let listGuardError: unknown = null;
  try {
    for await (const _page of c5.listObjects('')) {
      /* noop */
    }
  } catch (err) {
    listGuardError = err;
  }
  check('listObjects refuses an empty workspaceId', listGuardError instanceof ConnectorError && (listGuardError as ConnectorError).code === 'internal');

  // ─── 7. Per-repository resilience (review finding 2) ─────────────────────
  // One failing repository must not abort the others; counts must reflect
  // what actually happened; failed repos must not appear as synced.
  clearConnectorRegistry();
  const { connector: c6, lastRequests: req6 } = buildGithubAdapter({ failRepos: ['acme/repo1'] });
  registerConnector(c6);
  const partial = await dispatchConnectorSync('github', WORKSPACE_A, {});
  check(
    'a failing repo does not abort the others (partial success returned, no throw)',
    partial.indexed === 5 && partial.failed === 1 && partial.acknowledged === undefined,
    partial
  );
  check('both repositories were still attempted', req6.length === 2 && req6.map((r) => r.fullName).join(',') === 'acme/repo0,acme/repo1', req6);
  check(
    'per-repository outcome counts are reported',
    partial.phases.repository?.indexed === 1 && partial.phases.repository?.failed === 1,
    partial.phases
  );

  // Checkpoint correctness: only 'running' repos appear in the snapshot; a
  // failed repo (service marks it 'error') is absent — never "synced".
  await supabase.from('github_sync_state').insert([
    { workspace_id: WORKSPACE_A, repository_id: 'acme/repo0', sync_kind: 'incremental', status: 'running', resume_token: { phase: 'tree', completedPhases: [] }, updated_at: '2024-07-01T00:00:00.000Z' },
    { workspace_id: WORKSPACE_A, repository_id: 'acme/repo1', sync_kind: 'incremental', status: 'error', resume_token: { phase: 'tree', completedPhases: [] }, updated_at: '2024-07-01T00:00:00.000Z' },
  ]);
  const snap = (await c6.sync({ workspaceId: WORKSPACE_A, incremental: true })).checkpoint.extra?.repositories as Record<string, unknown>;
  check('checkpoint snapshot contains the running repo', snap && 'acme/repo0' in snap, snap);
  check('checkpoint snapshot excludes the failed (error) repo', snap && !('acme/repo1' in snap), snap);

  // When EVERY repo fails and nothing was produced, the run fails loudly
  // (retryable by the queue) instead of reporting an empty "success".
  clearConnectorRegistry();
  const { connector: c7 } = buildGithubAdapter({ failRepos: ['acme/repo0', 'acme/repo1'] });
  registerConnector(c7);
  let allFailedErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_A, {});
  } catch (err) {
    allFailedErr = err;
  }
  check(
    'all repos failing with zero output throws (typed ConnectorError, not empty success)',
    allFailedErr instanceof ConnectorError && (allFailedErr as ConnectorError).code === 'network',
    allFailedErr
  );

  clearConnectorRegistry();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\nConnector conformance suite: ${checks.length - failed.length} passed, ${failed.length} failed.`);
  return failed.length === 0;
  } finally {
    restoreGithubEnv(savedEnv);
  }
}

export { runConnectorConformanceTest };

if (import.meta.url === `file://${process.argv[1]}`) {
  runConnectorConformanceTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
