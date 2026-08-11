// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — Connector registry tests (test/connectors/registry.test.ts)
//
// Covers: deterministic registration, duplicate rejection, typed lookup
// errors (no silent fallback), capability discovery, the CRAWLER_V2 flag,
// workspaceId-required dispatch, the generic (non-phased) dispatch path
// (discovered/acknowledged semantics — never fake `indexed`), the
// authenticated GET /api/ingestion/connectors endpoint (workspace-aware,
// zero credential leakage), production bootstrap registration
// (registerBuiltinConnectors via startApiServer + startIngestionWorker), and
// pre-enqueue provider validation in POST /run. All hermetic: harness stubs
// + in-memory queue.
// ─────────────────────────────────────────────────────────────────────────────

import { installHarness } from '../harness/index.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { supabase } from '../../src/config/supabase.js';
import {
  registerConnector,
  getConnector,
  hasConnector,
  listConnectors,
  clearConnectorRegistry,
  dispatchConnectorSync,
  isCrawlerV2Enabled,
} from '../../src/connectors/registry.js';
import { registerBuiltinConnectors } from '../../src/connectors/register.js';
import { Connector, ConnectorError, SourceObject } from '../../src/connectors/types.js';
import { createGithubConnector } from '../../src/connectors/githubConnector.js';
import { GitHubAppAuth } from '../../src/connectors/github/auth.js';
import ingestionRouter from '../../src/routes/ingestion.js';
import { ingestionQueue } from '../../src/queue/ingestionQueue.js';
import { startIngestionWorker, stopIngestionWorker } from '../../src/workers/ingestionWorker.js';
import { stopHealthServer } from '../../src/services/health.js';

// ─── Minimal mock connector exercising the generic (non-phased) path ────────

function createMockConnector(overrides: { ackThrows?: boolean; provider?: string } = {}): Connector & { ackCalls: string[]; ackWorkspaces: string[]; listCalls: number } {
  const connector: Connector & { ackCalls: string[]; ackWorkspaces: string[]; listCalls: number } = {
    provider: overrides.provider ?? 'mock',
    displayName: 'Mock Connector',
    capabilities: {
      supportsIncremental: true,
      supportsPhasedSync: false,
      supportsAcl: true,
      supportsAttachments: false,
      webhookMode: 'durable_ledger',
      cursorStore: 'generic',
      configSources: ['env'],
    },
    ackCalls: [],
    ackWorkspaces: [],
    listCalls: 0,
    isConfigured: () => true,
    async *listObjects(workspaceId: string): AsyncGenerator<SourceObject[], void, unknown> {
      connector.listCalls++;
      const page: SourceObject[] = [
        { workspaceId, provider: 'mock', externalId: 'obj-1', type: 'doc', title: 'One', text: 'content one', metadata: {}, version: 'v1', attachments: [] },
        { workspaceId, provider: 'mock', externalId: 'obj-2', type: 'doc', title: 'Two', text: 'content two', metadata: {}, version: 'v2', attachments: [] },
      ];
      yield page;
      yield [
        { workspaceId, provider: 'mock', externalId: 'obj-3', type: 'doc', title: 'Three', text: 'content three', metadata: {}, version: 'v3', attachments: [] },
      ];
    },
    async fetchObject(workspaceId: string, externalId: string): Promise<SourceObject | null> {
      return externalId === 'obj-1' ? { workspaceId, provider: 'mock', externalId, type: 'doc', title: 'One', text: 'x', metadata: {}, attachments: [] } : null;
    },
    async fetchAcl() {
      return { viewers: [], teams: [], inherited: true, raw_acl: { mock: true }, imported_at: new Date().toISOString() };
    },
    async getDeltaCursor() {
      return { page: 2 };
    },
    async ack(workspaceId: string, externalId: string): Promise<void> {
      connector.ackCalls.push(externalId);
      connector.ackWorkspaces.push(workspaceId);
      if (overrides.ackThrows) throw new ConnectorError('mock', 'network', 'simulated ack failure', { retryable: true });
    },
  };
  return connector;
}

const WORKSPACE_A = '00000000-0000-4000-8000-00000000000a';
const WORKSPACE_B = '00000000-0000-4000-8000-00000000000b';

async function runRegistryTest(): Promise<boolean> {
  await installHarness();
  clearConnectorRegistry();
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
    if (ok) console.log(`✅ CONNECTOR REGISTRY: ${name}`);
    else console.error(`❌ CONNECTOR REGISTRY FAILED: ${name}`, detail ?? '');
  };

  // ─── Registry primitives ────────────────────────────────────────────────
  const mock = createMockConnector();
  registerConnector(mock);
  check('register then get returns the same instance', getConnector('mock') === mock);
  check('hasConnector true for registered provider', hasConnector('mock') === true);
  check('hasConnector false for unknown provider', hasConnector('nope') === false);

  let dupError: unknown = null;
  try {
    registerConnector(createMockConnector());
  } catch (err) {
    dupError = err;
  }
  check('duplicate registration throws', dupError instanceof ConnectorError);
  check(
    'duplicate registration error is typed unsupported',
    dupError instanceof ConnectorError && dupError.code === 'unsupported' && dupError.provider === 'mock'
  );

  let unknownError: unknown = null;
  try {
    getConnector('definitely-not-registered');
  } catch (err) {
    unknownError = err;
  }
  check('unknown provider lookup throws (no silent fallback)', unknownError instanceof ConnectorError);
  check(
    'unknown provider error is typed not_found',
    unknownError instanceof ConnectorError && unknownError.code === 'not_found' && unknownError.provider === 'definitely-not-registered'
  );

  const listed = listConnectors();
  check('listConnectors reports capabilities', listed.some((e) => e.provider === 'mock' && e.capabilities.supportsIncremental === true));
  check('listConnectors is sorted by provider', listed.every((e, i) => i === 0 || listed[i - 1].provider <= e.provider));

  let emptyProviderError: unknown = null;
  try {
    registerConnector({ ...createMockConnector(), provider: '' } as Connector);
  } catch (err) {
    emptyProviderError = err;
  }
  check('registration with empty provider throws typed internal error', emptyProviderError instanceof ConnectorError && (emptyProviderError as ConnectorError).code === 'internal');

  // ─── CRAWLER_V2 flag ────────────────────────────────────────────────────
  const origFlag = process.env.CRAWLER_V2;
  delete process.env.CRAWLER_V2;
  check('CRAWLER_V2 unset -> flag off', isCrawlerV2Enabled() === false);
  process.env.CRAWLER_V2 = 'true';
  check('CRAWLER_V2=true -> flag on', isCrawlerV2Enabled() === true);
  process.env.CRAWLER_V2 = 'false';
  check('CRAWLER_V2=false -> flag off', isCrawlerV2Enabled() === false);

  // ─── dispatchConnectorSync: workspace guard + typed errors ──────────────
  let guardError: unknown = null;
  try {
    await dispatchConnectorSync('mock', '');
  } catch (err) {
    guardError = err;
  }
  check('dispatch with empty workspaceId throws (refuses implicit workspace)', guardError instanceof ConnectorError && (guardError as ConnectorError).code === 'internal');

  let notFoundError: unknown = null;
  try {
    await dispatchConnectorSync('no-such-provider', WORKSPACE_A);
  } catch (err) {
    notFoundError = err;
  }
  check('dispatch to unknown provider throws not_found (no silent fallback)', notFoundError instanceof ConnectorError && (notFoundError as ConnectorError).code === 'not_found');

  // ─── dispatchConnectorSync: generic (non-phased) path ───────────────────
  // Honest semantics (architecture review BLOCKER 2): the generic path acks
  // objects but persists NOTHING, so it reports discovered (total) +
  // acknowledged and NEVER claims indexed.
  const result = await dispatchConnectorSync('mock', WORKSPACE_A);
  check('generic dispatch reports every object as discovered', result.total === 3, result);
  check('generic dispatch reports acknowledged, not indexed (nothing persisted)', result.indexed === 0 && result.acknowledged === 3, result);
  check('generic dispatch acks every object in order', mock.ackCalls.join(',') === 'obj-1,obj-2,obj-3', mock.ackCalls);
  check(
    'generic dispatch phases never claim indexed (no fabricated phase entries)',
    Object.keys(result.phases).length === 0 && !('doc' in result.phases),
    result.phases
  );

  // Ack failures are counted, not fatal.
  clearConnectorRegistry();
  const flaky = createMockConnector({ ackThrows: true });
  registerConnector(flaky);
  const flakyResult = await dispatchConnectorSync('mock', WORKSPACE_A);
  check(
    'ack failure counted as failed, dispatch does not throw',
    flakyResult.total === 3 && flakyResult.failed === 3 && flakyResult.indexed === 0 && (flakyResult.acknowledged ?? 0) === 0,
    flakyResult
  );
  check('ack failure is reflected in the phase counts', flakyResult.phases.doc?.failed === 3 && flakyResult.phases.doc?.indexed === 0, flakyResult.phases);

  // ─── registerBuiltinConnectors: idempotent builtin registration ─────────
  clearConnectorRegistry();
  const first = registerBuiltinConnectors();
  check('builtin registration registers github', first.some((r) => r.provider === 'github' && r.status === 'registered'), first);
  check('builtin registration populates the registry', hasConnector('github') && getConnector('github').provider === 'github');
  const second = registerBuiltinConnectors();
  check(
    'repeated builtin registration is idempotent (no duplicate-registration throw)',
    second.every((r) => r.status === 'already_registered') && second.length === first.length,
    second
  );

  // ─── GET /api/ingestion/connectors (authenticated, workspace-aware) ─────
  clearConnectorRegistry();
  // Pin GitHub credential env deterministically (auth.isConfigured reads env
  // at call time — see test/connectors/github/auth.test.ts pattern).
  const savedGithubAppId = process.env.GITHUB_APP_ID;
  const savedGithubKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const savedGithubKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = 'dummy-private-key-for-tests';
  delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;

  // Configured GitHub adapter (dummy credentials so auth is configured) plus a
  // registered installation for the authenticated workspace, so isConfigured
  // is TRUTHFULLY true per workspace.
  const configuredAuth = new GitHubAppAuth({ appId: '123456', privateKey: 'dummy-private-key' });
  registerConnector(createGithubConnector({ auth: configuredAuth }));
  await supabase.from('integration_installations').insert({
    workspace_id: '00000000-0000-0000-0000-000000000000',
    provider: 'github',
    external_org_id: '42',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/ingestion', ingestionRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const noAuthRes = await fetch(`${base}/api/ingestion/connectors`, { method: 'GET' });
  check('GET /connectors without auth is 401', noAuthRes.status === 401, noAuthRes.status);

  const authHeaders = { Authorization: 'Bearer mock-admin-token' };
  const res = await fetch(`${base}/api/ingestion/connectors`, { method: 'GET', headers: authHeaders });
  const body: any = await res.json();
  check('GET /connectors with auth is 200', res.status === 200, res.status);

  const githubEntry = (body.connectors || []).find((c: any) => c.provider === 'github');
  check(
    'github entry reports capabilities',
    githubEntry && githubEntry.capabilities?.webhookMode === 'provider_queue' && githubEntry.capabilities?.supportsPhasedSync === true,
    githubEntry
  );
  check('github entry reports configured=true for the workspace', githubEntry?.configured === true, githubEntry);
  check('response echoes the authenticated workspace', body.workspace_id === '00000000-0000-0000-0000-000000000000', body.workspace_id);

  // Truthful per-workspace semantics: a workspace WITHOUT a registered
  // installation is NOT configured, even though app credentials exist.
  const githubConnector = getConnector('github');
  const configuredForOther = await githubConnector.isConfigured(WORKSPACE_A);
  check('github isConfigured=false for a workspace without installations', configuredForOther === false, configuredForOther);
  const configuredForEmpty = await githubConnector.isConfigured('');
  check('github isConfigured=false for an empty workspaceId (never invents one)', configuredForEmpty === false, configuredForEmpty);

  // Zero credential leakage: scan every string key in the response for
  // credential-ish names (tokens, secrets, keys, passwords, authorization).
  const forbidden = /(token|secret|password|credential|authorization|private[_ ]?key|api[_ ]?key|access[_ ]?key|oauth)/i;
  const leaked: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (forbidden.test(k)) leaked.push(k);
        walk(v);
      }
    }
  };
  walk(body);
  check('GET /connectors response contains no credential-shaped keys', leaked.length === 0, leaked);
  const bodyText = JSON.stringify(body);
  check('GET /connectors response contains no raw secret-looking values', !/(dummy-private-key|Bearer |ghp_|sk-)/i.test(bodyText));

  // ─── POST /run: CRAWLER_V2 flag gating ──────────────────────────────────
  const realEnqueue = ingestionQueue.add.bind(ingestionQueue);
  const enqueued: Array<{ name: string; data: any }> = [];
  ingestionQueue.add = (async (name: string, data: any) => {
    enqueued.push({ name, data });
    return { id: `job_${Date.now()}` };
  }) as typeof ingestionQueue.add;

  const postRun = (payload: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/ingestion/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders, ...headers },
      body: JSON.stringify(payload),
    });

  process.env.CRAWLER_V2 = 'false';
  const flagOffRes = await postRun({ job_name: 'crawl_provider', provider: 'github' });
  check('crawl_provider rejected with flag OFF (legacy behavior preserved)', flagOffRes.status === 400, flagOffRes.status);
  const flagOffBody: any = await flagOffRes.json();
  check('flag-off rejection message matches legacy invalid-job message', /Invalid job_name/.test(flagOffBody.error || ''), flagOffBody.error);

  const legacyRes = await postRun({ job_name: 'crawl_slack' });
  check('legacy job names still accepted with flag OFF', legacyRes.status === 202, legacyRes.status);

  process.env.CRAWLER_V2 = 'true';
  const missingProviderRes = await postRun({ job_name: 'crawl_provider' });
  check('crawl_provider without provider field is 400', missingProviderRes.status === 400, missingProviderRes.status);

  // Unknown providers are rejected BEFORE enqueue (finding 4 of the review):
  // a job that can never resolve its connector must not be queued.
  const unknownProviderRes = await postRun({ job_name: 'crawl_provider', provider: 'nope' });
  check('unknown provider rejected with flag ON (400 before enqueue)', unknownProviderRes.status === 400, unknownProviderRes.status);
  const unknownProviderBody: any = await unknownProviderRes.json();
  check("unknown provider error names the provider and registered list", /Unknown connector provider 'nope'/.test(unknownProviderBody.error || '') && /github/.test(unknownProviderBody.error || ''), unknownProviderBody.error);
  check(
    'unknown provider is never enqueued',
    !enqueued.some((e) => e.name === 'crawl_provider' && e.data?.provider === 'nope'),
    enqueued
  );

  const flagOnRes = await postRun({ job_name: 'crawl_provider', provider: 'github', incremental: true });
  check('crawl_provider accepted with flag ON (202)', flagOnRes.status === 202, flagOnRes.status);
  const enqueuedProvider = enqueued.find((e) => e.name === 'crawl_provider');
  check(
    'crawl_provider job carries workspace + provider (never a default workspace)',
    enqueuedProvider?.data.workspace_id === '00000000-0000-0000-0000-000000000000' && enqueuedProvider?.data.provider === 'github' && enqueuedProvider?.data.incremental === true,
    enqueuedProvider?.data
  );

  const legacyOnRes = await postRun({ job_name: 'crawl_github' });
  check('legacy job names still accepted with flag ON (dispatch unchanged)', legacyOnRes.status === 202, legacyOnRes.status);

  // ─── Cross-workspace dispatch isolation (dispatch carries the caller's ws) ─
  clearConnectorRegistry();
  const scoped = createMockConnector();
  registerConnector(scoped);
  await dispatchConnectorSync('mock', WORKSPACE_B);
  check(
    'dispatch passes the explicit workspaceId through (no substitution)',
    scoped.ackCalls.length === 3 && scoped.ackWorkspaces.every((ws) => ws === WORKSPACE_B),
    scoped.ackWorkspaces
  );

  // ─── Production bootstrap populates the registry (review BLOCKER 1) ─────
  // The ingestion-worker process: startIngestionWorker() must register the
  // builtin GitHub connector so CRAWLER_V2=true crawl_provider jobs resolve.
  clearConnectorRegistry();
  startIngestionWorker();
  check('ingestion-worker bootstrap registers github', hasConnector('github') && getConnector('github').provider === 'github');
  // With no installations for this workspace the builtin connector resolves
  // and truthfully reports not configured — proving the production bootstrap
  // connector is the one dispatch sees.
  let bootstrapDispatchErr: unknown = null;
  try {
    await dispatchConnectorSync('github', WORKSPACE_A);
  } catch (err) {
    bootstrapDispatchErr = err;
  }
  check(
    'dispatch resolves the builtin connector and truthfully refuses an uninstalled workspace',
    bootstrapDispatchErr instanceof ConnectorError && (bootstrapDispatchErr as ConnectorError).code === 'not_configured',
    bootstrapDispatchErr
  );
  await stopIngestionWorker();
  stopHealthServer('ingestion-worker');

  // The API process: startApiServer() must register builtins so
  // GET /api/ingestion/connectors can actually report them.
  const savedPort = process.env.PORT;
  process.env.PORT = '0'; // ephemeral port — startApiServer must not collide
  const { startApiServer } = await import('../../src/index.js');
  const apiServer = startApiServer();
  check('api bootstrap registers github', hasConnector('github') && getConnector('github').provider === 'github');
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  if (savedPort === undefined) delete process.env.PORT;
  else process.env.PORT = savedPort;

  // restore
  ingestionQueue.add = realEnqueue;
  // An originally-unset CRAWLER_V2 must be DELETED again — assigning the saved
  // value would stringify `undefined` into the literal "undefined" and leak
  // into every later suite (regression: env restore must mirror the capture).
  if (origFlag === undefined) delete process.env.CRAWLER_V2;
  else process.env.CRAWLER_V2 = origFlag;
  if (origFlag === undefined) {
    check('CRAWLER_V2 restored: originally-unset stays unset (deleted, not the literal "undefined")', process.env.CRAWLER_V2 === undefined, process.env.CRAWLER_V2);
  } else {
    check('CRAWLER_V2 restored: originally-set value is restored verbatim', process.env.CRAWLER_V2 === origFlag, process.env.CRAWLER_V2);
  }
  if (savedGithubAppId === undefined) delete process.env.GITHUB_APP_ID;
  else process.env.GITHUB_APP_ID = savedGithubAppId;
  if (savedGithubKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = savedGithubKey;
  if (savedGithubKeyPath === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  else process.env.GITHUB_APP_PRIVATE_KEY_PATH = savedGithubKeyPath;
  clearConnectorRegistry();
  server.close();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nConnector registry suite: ${checks.length - failed.length} passed, ${failed.length} failed.`);
  return failed.length === 0;
}

export { runRegistryTest };

if (import.meta.url === `file://${process.argv[1]}`) {
  runRegistryTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
