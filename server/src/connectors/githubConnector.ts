// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — GitHub connector adapter (connectors/githubConnector.ts)
//
// Expresses the EXISTING production GitHub connector
// (connectors/github/: auth, client, sync, webhook) through the Phase 2
// connector contract WITHOUT modifying its internals. The adapter wraps
// GitHubAppAuth + GithubSyncService:
//   - sync()       → the real production path: workspace GitHub installations
//                    (integration_installations) → per-repository
//                    GithubSyncService.syncRepository() → persisted
//                    source_documents/chunks + github_sync_state checkpoints.
//   - listObjects/ → repository-level descriptors (GitHub's content objects
//   fetchObject     are persisted directly by sync(); this adapter does not
//                    re-stream file contents).
//   - getDeltaCursor → latest github_sync_state resume token for the workspace.
//   - ack()        → no-op: GitHub is checkpointed (github_sync_state), not
//                    ack-based (documented in the contract).
//   - fetchAcl()   → null: ACL capture is a later Phase 2 task (capability
//                    supportsAcl=false until ADR-T3 locks the SourceAcl shape).
//
// Webhook mode: 'provider_queue' — GitHub App webhooks today turn into
// `github-sync` queue jobs (routes/webhooks.ts), so the PROVIDER owns
// delivery (GitHub retries failed deliveries) and there is no raw-event
// ledger in our system. durable_ledger is a different topology used by other
// providers (raw_source_events + exactly-once consumer); aligning GitHub with
// it would be a separate, deliberate decision and is NOT part of this task.
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { GitHubAppAuth, createGitHubAppAuth, GitHubAuthError } from './github/auth.js';
import { GitHubApiError } from './github/client.js';
import { GithubSyncService, createGithubSyncService } from './github/sync.js';
import { GITHUB_DOCUMENT_TYPES, type GitHubDocumentType, type GithubSyncRequest, type GithubSyncStats, type GithubResumeToken } from './github/types.js';
import {
  Connector,
  ConnectorCapabilities,
  ConnectorError,
  ConnectorErrorCode,
  ConnectorSyncCheckpoint,
  ConnectorSyncOptions,
  ConnectorSyncResult,
  SourceAcl,
  SourceObject,
} from './types.js';

const GITHUB_CAPABILITIES: ConnectorCapabilities = {
  supportsIncremental: true,
  supportsPhasedSync: true,
  supportsAcl: false, // ACL capture is a later Phase 2 task (ADR-T3 pending)
  supportsAttachments: false,
  webhookMode: 'provider_queue',
  cursorStore: 'github_sync_state',
  configSources: ['env'],
};

export interface GithubWorkspaceInstallation {
  installationId: number;
}

export type GithubWorkspaceResolver = (workspaceId: string) => Promise<GithubWorkspaceInstallation[]>;

/**
 * Default resolver: workspace → GitHub App installations via
 * integration_installations (workspace-scoped, never zero-workspace).
 * Falls back to NO installations when the workspace has none registered.
 */
async function resolveInstallationsForWorkspace(workspaceId: string): Promise<GithubWorkspaceInstallation[]> {
  const { data, error } = await supabase
    .from('integration_installations')
    .select('external_org_id')
    .eq('provider', 'github')
    .eq('workspace_id', workspaceId);

  if (error) {
    throw new ConnectorError('github', 'internal', `Failed to resolve GitHub installations for workspace ${workspaceId}: ${error.message}`);
  }

  return (data || [])
    .map((row) => ({ installationId: Number(row.external_org_id) }))
    .filter((entry) => Number.isFinite(entry.installationId));
}

interface GithubConnectorOptions {
  auth?: GitHubAppAuth;
  service?: GithubSyncService;
  /** Injectable for hermetic tests; defaults to integration_installations. */
  workspaceResolver?: GithubWorkspaceResolver;
}

/** Maps the provider's native errors onto the shared ConnectorError taxonomy. */
export function mapGitHubError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof GitHubAuthError) {
    // Token exchange rejected with 401/403: previously-valid credentials are
    // no longer accepted (app uninstalled/suspended, key rotated) → revoked.
    if (err.status === 401 || err.status === 403) {
      return new ConnectorError('github', 'auth_revoked', err.message, { status: err.status, retryable: false });
    }
    // Local configuration failure (missing/undecodable credentials).
    return new ConnectorError('github', 'not_configured', err.message, { retryable: false });
  }
  if (err instanceof GitHubApiError) {
    // Timeouts are transient by definition; the client already retried them,
    // but the connector-level verdict must stay internally consistent
    // (code 'timeout' ⇒ retryable true). Checked before status so a
    // status-less timeout can't fall through to 'internal'.
    if (/timed out|timeout/i.test(err.message)) {
      return new ConnectorError('github', 'timeout', err.message, { status: err.status, retryable: true });
    }
    let code: ConnectorErrorCode = 'internal';
    let retryable: boolean | undefined;
    if (err.status === 429) {
      code = 'rate_limited';
    } else if (err.status === 401 || err.status === 403) {
      // Consistent with token exchange: credentials no longer accepted.
      code = 'auth_revoked';
      retryable = false;
    } else if (err.status === 404) {
      code = 'not_found';
      retryable = false;
    } else if (err.status === 400) {
      code = 'malformed_response';
      retryable = false;
    } else if (err.status !== undefined && err.status >= 500) {
      code = 'network';
      retryable = true;
    } else if (err.status === undefined) {
      // The client wraps transport failures (fetch rejection, DNS, ...) as
      // status-less GitHubApiErrors → transient network.
      code = 'network';
      retryable = true;
    }
    return new ConnectorError('github', code, err.message, { status: err.status, retryable });
  }
  if (err instanceof Error) {
    if (/timed out|aborted/i.test(err.message)) {
      return new ConnectorError('github', 'timeout', err.message, { retryable: true });
    }
    return new ConnectorError('github', 'network', err.message, { retryable: true });
  }
  return new ConnectorError('github', 'internal', String(err), { retryable: false });
}

export class GithubConnector implements Connector {
  readonly provider = 'github';
  readonly displayName = 'GitHub';
  readonly capabilities: ConnectorCapabilities = GITHUB_CAPABILITIES;

  private readonly auth: GitHubAppAuth;
  private readonly service: GithubSyncService;
  private readonly workspaceResolver: GithubWorkspaceResolver;
  /**
   * App credentials are process-global (env-configured) and immutable while
   * the process runs, so the auth part is cached. The workspace part
   * (installations) is resolved per call — it can change at any time.
   */
  private authConfiguredCache: boolean | null = null;

  constructor(options: GithubConnectorOptions = {}) {
    this.auth = options.auth ?? createGitHubAppAuth();
    this.service = options.service ?? createGithubSyncService(this.auth);
    this.workspaceResolver = options.workspaceResolver ?? resolveInstallationsForWorkspace;
  }

  /**
   * Truthful per-workspace configuration: the app credentials exist AND the
   * workspace has at least one registered GitHub installation. Never throws
   * (resolver failures are treated as "not configured" for the workspace).
   */
  async isConfigured(workspaceId: string): Promise<boolean> {
    if (!workspaceId || !workspaceId.trim()) return false;
    if (this.authConfiguredCache === null) {
      this.authConfiguredCache = this.auth.isConfigured();
    }
    if (!this.authConfiguredCache) return false;
    try {
      const installations = await this.workspaceResolver(workspaceId);
      return installations.length > 0;
    } catch {
      return false;
    }
  }

  /** Repositories accessible to the workspace's installations. */
  async listRepositories(workspaceId: string): Promise<Array<{ installationId: number; repoId: number; fullName: string; defaultBranch: string }>> {
    const installations = await this.workspaceResolver(workspaceId);
    const repos: Array<{ installationId: number; repoId: number; fullName: string; defaultBranch: string }> = [];
    for (const { installationId } of installations) {
      try {
        const items = await this.service.listRepositories(installationId);
        for (const repo of items) {
          repos.push({ installationId, repoId: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch });
        }
      } catch (err) {
        throw mapGitHubError(err);
      }
    }
    return repos;
  }

  private repoDescriptor(workspaceId: string, repo: { installationId: number; repoId: number; fullName: string; defaultBranch: string }): SourceObject {
    return {
      workspaceId,
      provider: this.provider,
      externalId: repo.fullName,
      type: 'repository',
      title: repo.fullName,
      text: '',
      uri: `https://github.com/${repo.fullName}`,
      metadata: {
        installationId: repo.installationId,
        repositoryId: repo.repoId,
        defaultBranch: repo.defaultBranch,
        source: this.provider,
        type: 'repository',
      },
      version: repo.fullName,
      attachments: [],
    };
  }

  async *listObjects(
    workspaceId: string,
    _opts?: { incremental?: boolean; include?: string[]; maxObjects?: number; signal?: AbortSignal }
  ): AsyncGenerator<SourceObject[], void, unknown> {
    if (!workspaceId || !workspaceId.trim()) {
      throw new ConnectorError(this.provider, 'internal', 'workspaceId is required for listObjects — refusing implicit workspace resolution.');
    }
    const repos = await this.listRepositories(workspaceId);
    const page: SourceObject[] = repos.map((repo) => this.repoDescriptor(workspaceId, repo));
    if (page.length > 0) yield page;
  }

  async fetchObject(workspaceId: string, externalId: string): Promise<SourceObject | null> {
    const repos = await this.listRepositories(workspaceId);
    const repo = repos.find((r) => r.fullName === externalId);
    return repo ? this.repoDescriptor(workspaceId, repo) : null;
  }

  /** ACL capture is a later Phase 2 task; capability supportsAcl=false. */
  async fetchAcl(_workspaceId: string, _objectId: string): Promise<SourceAcl | null> {
    return null;
  }

  /** Latest github_sync_state resume token for the workspace (cross-workspace safe). */
  async getDeltaCursor(workspaceId: string): Promise<unknown | null> {
    const { data, error } = await supabase
      .from('github_sync_state')
      .select('resume_token, sync_kind, status, updated_at')
      .eq('workspace_id', workspaceId);

    if (error) {
      throw new ConnectorError(this.provider, 'internal', `Failed to read github_sync_state for workspace ${workspaceId}: ${error.message}`);
    }

    const rows = data || [];
    if (rows.length === 0) return null;

    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const latest = rows[0];
    return {
      resume_token: latest.resume_token ?? null,
      sync_kind: latest.sync_kind ?? null,
      status: latest.status ?? null,
      updated_at: latest.updated_at ?? null,
    };
  }

  /**
   * No-op ack: GitHub sync is checkpointed via github_sync_state (and
   * deduplicated via github_indexed_documents sha tracking), not ack-based.
   * Idempotent by construction.
   */
  async ack(_workspaceId: string, _externalId: string): Promise<void> {
    return;
  }

  /** Phased sync — the real production path (per-repo syncRepository). */
  async sync(opts: ConnectorSyncOptions & { checkpoint?: ConnectorSyncCheckpoint }): Promise<{
    result: ConnectorSyncResult;
    checkpoint: ConnectorSyncCheckpoint;
  }> {
    const { workspaceId, incremental, include, maxObjects, signal } = opts;
    if (!workspaceId || !workspaceId.trim()) {
      throw new ConnectorError(this.provider, 'internal', 'workspaceId is required for sync — refusing implicit workspace resolution.');
    }

    // Validate include against known document types; unknown types are ignored.
    const includeTypes: GitHubDocumentType[] = (include || []).filter(
      (t): t is GitHubDocumentType => (GITHUB_DOCUMENT_TYPES as readonly string[]).includes(t)
    );

    const startedAt = Date.now();
    const stats: ConnectorSyncResult = { total: 0, indexed: 0, skipped: 0, failed: 0, deleted: 0, durationMs: 0, phases: {} };
    const repos = await this.listRepositories(workspaceId);

    // Per-repository outcome accounting (phases['repository']).
    const repoPhases = (stats.phases['repository'] ??= { indexed: 0, skipped: 0, failed: 0 });
    const repoErrors: ConnectorError[] = [];

    for (const repo of repos) {
      if (signal?.aborted) break;
      const request: GithubSyncRequest = {
        workspaceId,
        installationId: repo.installationId,
        repoId: repo.repoId,
        fullName: repo.fullName,
        branch: undefined,
        incremental: incremental ?? true,
        include: includeTypes,
      };

      let repoStats: GithubSyncStats;
      try {
        repoStats = await this.service.syncRepository(request);
      } catch (err) {
        // A failure syncing ONE repository must not abort the rest: record it,
        // continue with the remaining repos, and only fail the whole run when
        // nothing at all was produced (then a retry is the right move).
        const mapped = mapGitHubError(err);
        repoErrors.push(mapped);
        stats.failed++;
        repoPhases.failed++;
        logger.warn('github_connector_repo_sync_failed', {
          repository: repo.fullName,
          code: mapped.code,
          error: mapped.message,
          continuing: true,
        });
        continue;
      }

      mergeGithubStats(stats, repoStats);
      repoPhases.indexed++;
      if (maxObjects && maxObjects > 0 && stats.total >= maxObjects) break;
    }

    // Everything failed and nothing was produced: fail loudly so the queue can
    // retry (e.g. rate limit or auth error at run start) instead of reporting
    // an empty "success".
    if (repoErrors.length > 0 && repoErrors.length === repos.length && stats.indexed === 0 && stats.skipped === 0) {
      throw repoErrors[repoErrors.length - 1];
    }

    stats.durationMs = Date.now() - startedAt;

    // Snapshot of the per-repo checkpoints the service just persisted.
    // Repos whose sync aborted are marked 'error' by the service (not
    // 'running'), so they are correctly absent here — never "synced".
    const snapshot = await this.snapshotCheckpoints(workspaceId);
    return {
      result: stats,
      checkpoint: { completedPhases: [], extra: { repositories: snapshot } },
    };
  }

  private async snapshotCheckpoints(workspaceId: string): Promise<Record<string, GithubResumeToken | null>> {
    const { data, error } = await supabase
      .from('github_sync_state')
      .select('repository_id, resume_token')
      .eq('workspace_id', workspaceId)
      .eq('status', 'running');

    if (error) {
      throw new ConnectorError(this.provider, 'internal', `Failed to snapshot github_sync_state for workspace ${workspaceId}: ${error.message}`);
    }

    const snapshot: Record<string, GithubResumeToken | null> = {};
    for (const row of data || []) {
      snapshot[row.repository_id] = (row.resume_token as GithubResumeToken) ?? null;
    }
    return snapshot;
  }

  async close(): Promise<void> {
    this.auth.clearCache();
  }
}

export function mergeGithubStats(target: ConnectorSyncResult, source: GithubSyncStats): void {
  target.total += source.total;
  target.indexed += source.indexed;
  target.skipped += source.skipped;
  target.failed += source.failed;
  target.deleted += source.deleted;
  for (const [phase, counts] of Object.entries(source.phases || {})) {
    const t = (target.phases[phase] ??= { indexed: 0, skipped: 0, failed: 0 });
    t.indexed += counts.indexed ?? 0;
    t.skipped += counts.skipped ?? 0;
    t.failed += counts.failed ?? 0;
  }
}

export function createGithubConnector(options?: GithubConnectorOptions): GithubConnector {
  return new GithubConnector(options);
}
