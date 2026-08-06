// GitHub sync orchestration: initial + incremental sync of a repository into
// the existing Company Brain ingestion pipeline (source_documents/chunks).
//
//   GitHub  ->  normalize document  ->  persistSourceDocumentWithChunks
//            ->  chunks  ->  embeddings  ->  graph  ->  database
//
// Features: resume tokens, batch processing, bounded concurrency, deletion
// reconciliation, per-phase cursor/position checkpoints.

import { supabase } from '../../config/supabase.js';
import { persistSourceDocumentWithChunks } from '../../ingestion/sourceObjects.js';
import { logger } from '../../logger.js';
import { GitHubClient, GitHubApiError } from './client.js';
import { GitHubAppAuth } from './auth.js';
import {
  isIgnoredPath,
  isReadmePath,
  splitFullName,
  mapRepoFile,
  mapIssueLike,
  mapDiscussion,
  mapWikiPage,
  type GithubDocumentPayload,
} from './mapper.js';
import type {
  GitHubDocumentType,
  GitHubInstallation,
  GitHubRepository,
  GithubResumeToken,
  GithubSyncKind,
  GithubSyncRequest,
  GithubSyncStats,
} from './types.js';

const GITHUB_SYNC_BATCH_SIZE = parseInt(process.env.GITHUB_SYNC_BATCH_SIZE || '25', 10);
const GITHUB_SYNC_CONCURRENCY = parseInt(process.env.GITHUB_SYNC_CONCURRENCY || '4', 10);
const GITHUB_SYNC_MAX_FILES = parseInt(process.env.GITHUB_SYNC_MAX_FILES_PER_RUN || '10000', 10);
const GITHUB_SYNC_FILE_SIZE_LIMIT_BYTES = parseInt(process.env.GITHUB_SYNC_FILE_SIZE_LIMIT_KB || '1024', 10) * 1024;

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size: number;
}

interface RepoSyncContext {
  request: GithubSyncRequest;
  owner: string;
  name: string;
  branch: string;
  headSha: string;
  commitDate: string;
  permissions: Record<string, boolean>;
  kind: GithubSyncKind;
  since: string | null;
  resume: GithubResumeToken;
  stats: GithubSyncStats;
  lastCheckpointAt: number;
  indexedThisRun: number;
  stop: boolean;
}

const EMPTY_RESUME: GithubResumeToken = { completedPhases: [] };

export class GithubSyncService {
  private readonly auth: GitHubAppAuth;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly maxFilesPerRun: number;
  private readonly fileSizeLimitBytes: number;

  constructor(auth: GitHubAppAuth, options?: { batchSize?: number; concurrency?: number; maxFilesPerRun?: number; fileSizeLimitBytes?: number }) {
    this.auth = auth;
    this.batchSize = options?.batchSize || GITHUB_SYNC_BATCH_SIZE;
    this.concurrency = options?.concurrency || GITHUB_SYNC_CONCURRENCY;
    this.maxFilesPerRun = options?.maxFilesPerRun || GITHUB_SYNC_MAX_FILES;
    this.fileSizeLimitBytes = options?.fileSizeLimitBytes || GITHUB_SYNC_FILE_SIZE_LIMIT_BYTES;
  }

  // App-level endpoints use the app JWT; repo endpoints use installation tokens.
  private appClient(): GitHubClient {
    return new GitHubClient({ tokenProvider: () => this.auth.getAppJwt() });
  }

  private installationClient(installationId: number): GitHubClient {
    return new GitHubClient({ tokenProvider: () => this.auth.getInstallationToken(installationId) });
  }

  async listInstallations(): Promise<GitHubInstallation[]> {
    const client = this.appClient();
    const items = await client.paginateAll<GitHubInstallation>('/app/installations', {
      perPage: 100,
      items: (body) =>
        (body.installations || []).map((i: any) => ({
          id: i.id,
          accountLogin: i.account?.login || '',
          accountType: i.account?.type || 'User',
          targetType: i.target_type || '',
          createdAt: i.created_at,
          updatedAt: i.updated_at,
        })),
    });
    return items;
  }

  async listRepositories(installationId: number): Promise<GitHubRepository[]> {
    const client = this.installationClient(installationId);
    const items = await client.paginateAll<GitHubRepository>('/installation/repositories', {
      perPage: 100,
      items: (body) =>
        (body.repositories || []).map((r: any) => ({
          id: r.id,
          name: r.name,
          owner: r.owner?.login || '',
          fullName: r.full_name || '',
          defaultBranch: r.default_branch || 'main',
          private: !!r.private,
          permissions: r.permissions || {},
          updatedAt: r.updated_at,
        })),
    });
    return items;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async syncRepository(request: GithubSyncRequest): Promise<GithubSyncStats> {
    const startedAt = Date.now();
    const { owner, name } = splitFullName(request.fullName);
    const kind: GithubSyncKind = request.incremental ? 'incremental' : 'initial';
    const client = this.installationClient(request.installationId);
    const include = request.include || [];

    const meta = await this.fetchRepoMeta(client, owner, name, request.fullName);
    const branch = request.branch || meta.defaultBranch || 'main';
    const headSha = await this.fetchBranchHead(client, owner, name, branch);
    const commitDate = headSha ? await this.fetchCommitDate(client, owner, name, headSha) : '';
    const permissions = meta.permissions;

    const state = await this.loadState(request.workspaceId, request.fullName, kind);
    const resume: GithubResumeToken = state?.status === 'running' && state.resume_token
      ? { ...EMPTY_RESUME, ...(state.resume_token as GithubResumeToken) }
      : { ...EMPTY_RESUME };

    const since = request.incremental
      ? state?.updated_at || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      : null;

    const ctx: RepoSyncContext = {
      request,
      owner,
      name,
      branch,
      headSha,
      commitDate,
      permissions,
      kind,
      since,
      resume,
      stats: this.emptyStats(),
      lastCheckpointAt: Date.now(),
      indexedThisRun: 0,
      stop: false,
    };

    await this.markState(request.workspaceId, request.fullName, kind, 'running', ctx.resume, ctx.stats, null, true);

    logger.info('github_sync_started', {
      repository: request.fullName,
      kind,
      branch,
      headSha,
      since,
      resumePhase: resume.phase,
      completedPhases: resume.completedPhases,
    });

    const phases: Array<{ name: string; run: () => Promise<void> }> = [];
    if (this.phaseIncluded(include, 'readme') || this.phaseIncluded(include, 'file')) {
      phases.push({ name: 'tree', run: () => this.syncTreePhase(ctx, client) });
    }
    if (this.phaseIncluded(include, 'issue')) phases.push({ name: 'issues', run: () => this.syncIssuesPhase(ctx, client) });
    if (this.phaseIncluded(include, 'pull_request')) phases.push({ name: 'pulls', run: () => this.syncPullsPhase(ctx, client) });
    if (this.phaseIncluded(include, 'discussion')) phases.push({ name: 'discussions', run: () => this.syncDiscussionsPhase(ctx, client) });
    if (this.phaseIncluded(include, 'release')) phases.push({ name: 'releases', run: () => this.syncReleasesPhase(ctx, client) });
    if (this.phaseIncluded(include, 'wiki')) phases.push({ name: 'wiki', run: () => this.syncWikiPhase(ctx, client) });

    try {
      for (const phase of phases) {
        if (ctx.stop) break;
        if (ctx.resume.completedPhases.includes(phase.name)) continue;
        if (ctx.resume.phase && ctx.resume.phase !== phase.name) continue;

        ctx.resume.phase = phase.name;
        await phase.run();

        if (!ctx.stop) {
          ctx.resume.completedPhases.push(phase.name);
          ctx.resume.phase = undefined;
          ctx.resume.position = undefined;
          ctx.resume.cursor = undefined;
          await this.checkpoint(ctx, true);
        }
      }

      if (!ctx.stop) {
        await this.markRepoSynced(request, headSha);
      }
    } catch (err) {
      await this.checkpoint(ctx, true);
      await this.markState(request.workspaceId, request.fullName, kind, 'error', ctx.resume, ctx.stats, (err as Error).message, false);
      logger.error('github_sync_failed', {
        repository: request.fullName,
        kind,
        phase: ctx.resume.phase,
        error: (err as Error).message,
      });
      throw err;
    }

    await this.markState(request.workspaceId, request.fullName, kind, 'completed', ctx.resume, ctx.stats, null, false);

    ctx.stats.durationMs = Date.now() - startedAt;
    logger.info('github_sync_completed', {
      repository: request.fullName,
      kind,
      total: ctx.stats.total,
      indexed: ctx.stats.indexed,
      skipped: ctx.stats.skipped,
      failed: ctx.stats.failed,
      deleted: ctx.stats.deleted,
      durationMs: ctx.stats.durationMs,
      phases: ctx.stats.phases,
    });

    return ctx.stats;
  }

  private phaseIncluded(include: GitHubDocumentType[], type: GitHubDocumentType): boolean {
    return include.length === 0 || include.includes(type);
  }

  private async fetchRepoMeta(client: GitHubClient, owner: string, name: string, fullName: string): Promise<{ defaultBranch: string; permissions: Record<string, boolean> }> {
    try {
      const repo: any = await client.getJson(`/repos/${owner}/${name}`);
      return {
        defaultBranch: repo.default_branch || 'main',
        permissions: repo.permissions || {},
      };
    } catch (err) {
      logger.warn('github_sync_repo_meta_fetch_failed', { repository: fullName, error: (err as Error).message });
      return { defaultBranch: 'main', permissions: {} };
    }
  }

  private async fetchBranchHead(client: GitHubClient, owner: string, name: string, branch: string): Promise<string> {
    try {
      const branchInfo: any = await client.getJson(`/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`);
      return branchInfo.commit?.sha || '';
    } catch {
      return '';
    }
  }

  private async fetchCommitDate(client: GitHubClient, owner: string, name: string, sha: string): Promise<string> {
    try {
      const commit: any = await client.getJson(`/repos/${owner}/${name}/commits/${encodeURIComponent(sha)}`);
      return commit.commit?.committer?.date || commit.commit?.author?.date || '';
    } catch {
      return '';
    }
  }

  // ─── Phase: tree (README + files) ─────────────────────────────────────────

  private async syncTreePhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    if (this.phaseIncluded(ctx.request.include || [], 'readme')) await this.syncReadme(ctx, client);
    if (this.phaseIncluded(ctx.request.include || [], 'file')) await this.syncFiles(ctx, client);
  }

  private async syncReadme(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    let content: string;
    try {
      content = await client.getRaw(`/repos/${ctx.owner}/${ctx.name}/readme`, { ref: ctx.branch });
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        logger.info('github_sync_readme_missing', { repository: ctx.request.fullName });
        return;
      }
      throw err;
    }
    if (!content?.trim()) return;

    const doc = mapRepoFile({
      workspaceId: ctx.request.workspaceId,
      repoId: ctx.request.repoId,
      fullName: ctx.request.fullName,
      branch: ctx.branch,
      commit: ctx.headSha,
      commitDate: ctx.commitDate,
      path: 'README.md',
      sha: '',
      content,
      url: `https://github.com/${ctx.request.fullName}/blob/${ctx.branch}/README.md`,
      permissions: ctx.permissions,
    });
    await this.indexDocument(ctx, doc, '');
  }

  private async syncFiles(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    let entries: TreeEntry[];
    try {
      entries = await this.fetchTreeEntries(ctx, client);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        logger.warn('github_sync_tree_unavailable', { repository: ctx.request.fullName, error: err.message });
        return;
      }
      throw err;
    }

    const indexable = entries.filter(
      (e) => e.type === 'blob' && !isIgnoredPath(e.path) && !isReadmePath(e.path) && e.size <= this.fileSizeLimitBytes
    );

    logger.info('github_sync_tree_loaded', {
      repository: ctx.request.fullName,
      totalEntries: entries.length,
      indexable: indexable.length,
    });

    const seenPaths = new Set<string>();
    const knownShas = new Map<string, string>();
    if (ctx.kind === 'incremental') {
      for (const [path, sha] of await this.loadIndexedFileShas(ctx.request.workspaceId, ctx.request.fullName)) {
        knownShas.set(path, sha);
      }
    }

    const startPosition = typeof ctx.resume.position === 'number' ? ctx.resume.position : 0;
    let position = startPosition;

    while (position < indexable.length && !ctx.stop) {
      const batch = indexable.slice(position, position + this.batchSize);
      position += batch.length;

      await this.runWithConcurrency(batch, async (entry) => {
        if (ctx.stop) return;
        const path = entry.path;
        seenPaths.add(path);

        if (knownShas.get(path) === entry.sha) {
          ctx.stats.skipped++;
          this.countPhase(ctx, 'file', 'skipped');
          return;
        }

        try {
          const encodedPath = path.split('/').map(encodeURIComponent).join('/');
          const content = await client.getRaw(
            `https://raw.githubusercontent.com/${ctx.owner}/${ctx.name}/${encodeURIComponent(ctx.branch)}/${encodedPath}`
          );
          if (!content?.trim()) {
            ctx.stats.skipped++;
            this.countPhase(ctx, 'file', 'skipped');
            return;
          }
          const doc = mapRepoFile({
            workspaceId: ctx.request.workspaceId,
            repoId: ctx.request.repoId,
            fullName: ctx.request.fullName,
            branch: ctx.branch,
            commit: ctx.headSha,
            commitDate: ctx.commitDate,
            path,
            sha: entry.sha,
            content,
            url: `https://github.com/${ctx.request.fullName}/blob/${ctx.branch}/${path}`,
            permissions: ctx.permissions,
          });
          await this.indexDocument(ctx, doc, entry.sha);
        } catch (err) {
          if (err instanceof GitHubApiError && err.status === 404) {
            ctx.stats.skipped++;
            return;
          }
          ctx.stats.failed++;
          this.countPhase(ctx, 'file', 'failed');
          logger.warn('github_sync_file_fetch_failed', { repository: ctx.request.fullName, path, error: (err as Error).message });
        }
      });

      ctx.resume.position = position;
      await this.checkpoint(ctx, false);
    }
    ctx.resume.position = undefined;

    if (ctx.kind === 'initial') {
      await this.reconcileDeletions(ctx, seenPaths);
    }
  }

  private async fetchTreeEntries(ctx: RepoSyncContext, client: GitHubClient): Promise<TreeEntry[]> {
    const tree: any = await client.getJson(
      `/repos/${ctx.owner}/${ctx.name}/git/trees/${encodeURIComponent(ctx.headSha || ctx.branch)}?recursive=1`
    );
    const entries: TreeEntry[] = (tree.tree || []).map((e: any) => ({
      path: e.path,
      type: e.type,
      sha: e.sha,
      size: e.size || 0,
    }));

    if (tree.truncated) {
      // Tree too large for a single recursive response (>100k entries):
      // fall back to a bounded depth-first walk of the contents API.
      logger.warn('github_sync_tree_truncated', { repository: ctx.request.fullName, fallback: 'contents-walk' });
      return this.walkContents(ctx, client);
    }
    return entries;
  }

  private async walkContents(ctx: RepoSyncContext, client: GitHubClient): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    const queue: string[] = [''];

    while (queue.length > 0 && entries.length < this.maxFilesPerRun) {
      const dirPath = queue.shift()!;
      let items: any[];
      try {
        items = await client.getJson(`/repos/${ctx.owner}/${ctx.name}/contents/${dirPath}`, { ref: ctx.branch });
      } catch (err) {
        if (err instanceof GitHubApiError && err.status === 404) continue;
        throw err;
      }
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item.type === 'dir') {
          if (!isIgnoredPath(item.path)) queue.push(item.path);
        } else if (item.type === 'file') {
          entries.push({ path: item.path, type: 'blob', sha: item.sha, size: item.size || 0 });
        }
      }
    }
    return entries;
  }

  // ─── Phase: issues ─────────────────────────────────────────────────────────

  private async syncIssuesPhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    const params: Record<string, string | number | undefined> = { state: 'all' };
    if (ctx.since) params.since = ctx.since;
    const startPage = typeof ctx.resume.position === 'number' ? ctx.resume.position : 1;

    for await (const batch of client.paginate<any>(`/repos/${ctx.owner}/${ctx.name}/issues`, {
      perPage: 100,
      startPage,
      items: (body) => body,
      params,
    })) {
      for (const item of batch) {
        if (item.pull_request) continue; // PRs are indexed by the pulls phase
        if (this.hitMax(ctx)) return;
        const doc = mapIssueLike({
          workspaceId: ctx.request.workspaceId,
          repoId: ctx.request.repoId,
          fullName: ctx.request.fullName,
          branch: ctx.branch,
          commit: ctx.headSha,
          kind: 'issue',
          numberOrTag: item.number,
          title: item.title || `Issue #${item.number}`,
          body: item.body || '',
          url: item.html_url || '',
          author: item.user?.login || 'unknown',
          createdAt: item.created_at || '',
          updatedAt: item.updated_at || '',
          permissions: ctx.permissions,
          metadata: { state: item.state, labels: (item.labels || []).map((l: any) => l.name) },
        });
        await this.indexDocument(ctx, doc, '');
      }
      ctx.resume.position = (ctx.resume.position || 1) + 1;
      await this.checkpoint(ctx, false);
    }
    ctx.resume.position = undefined;
  }

  // ─── Phase: pull requests ──────────────────────────────────────────────────

  private async syncPullsPhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    const params: Record<string, string | number | undefined> = { state: 'all' };
    if (ctx.since) params.since = ctx.since;
    const startPage = typeof ctx.resume.position === 'number' ? ctx.resume.position : 1;

    for await (const batch of client.paginate<any>(`/repos/${ctx.owner}/${ctx.name}/pulls`, {
      perPage: 100,
      startPage,
      items: (body) => body,
      params,
    })) {
      for (const item of batch) {
        if (this.hitMax(ctx)) return;
        const doc = mapIssueLike({
          workspaceId: ctx.request.workspaceId,
          repoId: ctx.request.repoId,
          fullName: ctx.request.fullName,
          branch: ctx.branch,
          commit: ctx.headSha,
          kind: 'pull_request',
          numberOrTag: item.number,
          title: item.title || `PR #${item.number}`,
          body: item.body || '',
          url: item.html_url || '',
          author: item.user?.login || 'unknown',
          createdAt: item.created_at || '',
          updatedAt: item.updated_at || '',
          permissions: ctx.permissions,
          metadata: { state: item.state, merged: !!item.merged_at, baseBranch: item.base?.ref },
        });
        await this.indexDocument(ctx, doc, '');
      }
      ctx.resume.position = (ctx.resume.position || 1) + 1;
      await this.checkpoint(ctx, false);
    }
    ctx.resume.position = undefined;
  }

  // ─── Phase: discussions (GraphQL, cursor pagination) ───────────────────────

  private async syncDiscussionsPhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    const query = `
      query RepoDiscussions($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          discussions(first: 100, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number title url createdAt updatedAt
              author { login }
              category { name }
              body
            }
          }
        }
      }`;

    let cursor: string | null = ctx.resume.cursor || null;
    let hasNext = true;

    while (hasNext && !ctx.stop) {
      let data: any;
      try {
        data = await client.graphql<{ repository: any }>(query, {
          owner: ctx.owner,
          name: ctx.name,
          cursor,
        });
      } catch (err) {
        if (err instanceof GitHubApiError && (err.status === 404 || !err.retryable)) {
          logger.info('github_sync_discussions_unavailable', { repository: ctx.request.fullName, error: (err as Error).message });
          return;
        }
        logger.warn('github_sync_discussions_skipped', { repository: ctx.request.fullName, error: (err as Error).message });
        return;
      }

      const repo = data?.repository;
      if (!repo || !repo.discussions) return;

      const pageInfo = repo.discussions.pageInfo || {};
      hasNext = !!pageInfo.hasNextPage;
      cursor = pageInfo.endCursor || null;

      for (const node of repo.discussions.nodes || []) {
        if (this.hitMax(ctx)) return;
        const doc = mapDiscussion({
          workspaceId: ctx.request.workspaceId,
          repoId: ctx.request.repoId,
          fullName: ctx.request.fullName,
          branch: ctx.branch,
          commit: ctx.headSha,
          number: node.number,
          title: node.title || `Discussion #${node.number}`,
          body: node.body || '',
          url: node.url || '',
          author: node.author?.login || 'unknown',
          createdAt: node.createdAt || '',
          updatedAt: node.updatedAt || '',
          category: node.category?.name || '',
          permissions: ctx.permissions,
        });
        await this.indexDocument(ctx, doc, '');
      }

      ctx.resume.cursor = cursor ?? undefined;
      await this.checkpoint(ctx, false);
    }
    ctx.resume.cursor = undefined;
  }

  // ─── Phase: releases ───────────────────────────────────────────────────────

  private async syncReleasesPhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    const sinceTs = ctx.since ? new Date(ctx.since).getTime() : 0;
    const startPage = typeof ctx.resume.position === 'number' ? ctx.resume.position : 1;

    for await (const batch of client.paginate<any>(`/repos/${ctx.owner}/${ctx.name}/releases`, {
      perPage: 100,
      startPage,
      items: (body) => body,
    })) {
      for (const item of batch) {
        const publishedAt = item.published_at || item.created_at;
        if (sinceTs > 0 && publishedAt && new Date(publishedAt).getTime() < sinceTs) {
          ctx.resume.position = undefined;
          return; // releases are newest-first; nothing newer than `since` remains
        }
        if (this.hitMax(ctx)) return;
        const doc = mapIssueLike({
          workspaceId: ctx.request.workspaceId,
          repoId: ctx.request.repoId,
          fullName: ctx.request.fullName,
          branch: ctx.branch,
          commit: ctx.headSha,
          kind: 'release',
          numberOrTag: item.tag_name || item.name || item.id,
          title: item.name || item.tag_name || `Release ${item.tag_name}`,
          body: item.body || '',
          url: item.html_url || '',
          author: item.author?.login || 'unknown',
          createdAt: item.created_at || publishedAt || '',
          updatedAt: publishedAt || item.created_at || '',
          permissions: ctx.permissions,
          metadata: { tagName: item.tag_name, prerelease: !!item.prerelease, draft: !!item.draft },
        });
        await this.indexDocument(ctx, doc, '');
      }
      ctx.resume.position = (ctx.resume.position || 1) + 1;
      await this.checkpoint(ctx, false);
    }
    ctx.resume.position = undefined;
  }

  // ─── Phase: wiki ───────────────────────────────────────────────────────────

  private async syncWikiPhase(ctx: RepoSyncContext, client: GitHubClient): Promise<void> {
    let tree: any;
    try {
      tree = await client.getJson(`/repos/${ctx.owner}/${ctx.name}.wiki/git/trees/${encodeURIComponent(ctx.branch)}?recursive=1`);
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 422)) {
        logger.info('github_sync_wiki_unavailable', { repository: ctx.request.fullName });
        return;
      }
      throw err;
    }

    const pages = (tree.tree || []).filter(
      (e: any) => e.type === 'blob' && /\.(md|txt)$/i.test(e.path) && !isIgnoredPath(e.path)
    );

    for (const entry of pages) {
      if (this.hitMax(ctx)) return;
      try {
        const encodedPath = entry.path.split('/').map(encodeURIComponent).join('/');
        const content = await client.getRaw(
          `https://raw.githubusercontent.com/wiki/${ctx.owner}/${ctx.name}/${encodedPath}`
        );
        if (!content?.trim()) {
          ctx.stats.skipped++;
          this.countPhase(ctx, 'wiki', 'skipped');
          continue;
        }
        const doc = mapWikiPage({
          workspaceId: ctx.request.workspaceId,
          repoId: ctx.request.repoId,
          fullName: ctx.request.fullName,
          branch: ctx.branch,
          commit: ctx.headSha,
          commitDate: ctx.commitDate,
          path: entry.path,
          content,
          permissions: ctx.permissions,
        });
        await this.indexDocument(ctx, doc, entry.sha);
      } catch (err) {
        ctx.stats.failed++;
        this.countPhase(ctx, 'wiki', 'failed');
        logger.warn('github_sync_wiki_fetch_failed', { repository: ctx.request.fullName, path: entry.path, error: (err as Error).message });
      }
    }
  }

  // ─── Document indexing (the pipeline seam) ─────────────────────────────────

  private async indexDocument(ctx: RepoSyncContext, doc: GithubDocumentPayload, sha: string): Promise<void> {
    if (!doc.text?.trim()) {
      ctx.stats.skipped++;
      return;
    }

    const persisted = await persistSourceDocumentWithChunks({
      workspaceId: doc.workspaceId,
      source: 'github',
      externalId: doc.externalId,
      title: doc.title,
      text: doc.text,
      uri: doc.url || undefined,
      metadata: {
        workspaceId: doc.workspaceId,
        repositoryId: doc.repositoryId,
        repositoryName: doc.repositoryName,
        branch: doc.branch,
        commit: doc.commit,
        author: doc.author,
        url: doc.url,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        permissions: doc.permissions,
        source: 'github',
        type: doc.type,
        path: doc.path,
      },
    });

    if (!persisted) {
      ctx.stats.failed++;
      this.countPhase(ctx, doc.type, 'failed');
      return;
    }

    await supabase
      .from('github_indexed_documents')
      .upsert(
        {
          workspace_id: doc.workspaceId,
          repository_id: ctx.request.fullName,
          document_type: doc.type,
          path: doc.path,
          external_id: doc.externalId,
          sha: sha || null,
          title: doc.title,
          url: doc.url,
          author: doc.author,
          branch: doc.branch,
          commit_sha: doc.commit,
          deleted_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'repository_id, document_type, path' }
      )
      .select('id');

    ctx.stats.indexed++;
    ctx.indexedThisRun++;
    this.countPhase(ctx, doc.type, 'indexed');
  }

  private async loadIndexedFileShas(workspaceId: string, fullName: string): Promise<Map<string, string>> {
    const { data } = await supabase
      .from('github_indexed_documents')
      .select('path, sha')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', fullName)
      .in('document_type', ['file'])
      .is('deleted_at', null);

    const map = new Map<string, string>();
    for (const row of data || []) {
      if (row.path && row.sha) map.set(row.path, row.sha);
    }
    return map;
  }

  private async reconcileDeletions(ctx: RepoSyncContext, seenPaths: Set<string>): Promise<void> {
    const { data } = await supabase
      .from('github_indexed_documents')
      .select('id, path, external_id')
      .eq('workspace_id', ctx.request.workspaceId)
      .eq('repository_id', ctx.request.fullName)
      .in('document_type', ['file', 'readme'])
      .is('deleted_at', null);

    for (const row of data || []) {
      if (!row.path || seenPaths.has(row.path)) continue;
      ctx.stats.deleted++;
      await supabase
        .from('github_indexed_documents')
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id);
      await supabase
        .from('source_documents')
        .delete()
        .eq('workspace_id', ctx.request.workspaceId)
        .eq('source', 'github')
        .eq('external_id', row.external_id);
    }
  }

  // ─── Resume / state persistence ────────────────────────────────────────────

  private async loadState(workspaceId: string, fullName: string, kind: GithubSyncKind): Promise<any | null> {
    const { data } = await supabase
      .from('github_sync_state')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', fullName)
      .eq('sync_kind', kind)
      .maybeSingle();
    return data || null;
  }

  private async markState(
    workspaceId: string,
    fullName: string,
    kind: GithubSyncKind,
    status: string,
    resume: GithubResumeToken,
    stats: GithubSyncStats,
    error: string | null,
    setStartedAt: boolean
  ): Promise<void> {
    const now = new Date().toISOString();
    const { data } = await supabase
      .from('github_sync_state')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('repository_id', fullName)
      .eq('sync_kind', kind)
      .maybeSingle();

    const payload: Record<string, any> = {
      workspace_id: workspaceId,
      repository_id: fullName,
      sync_kind: kind,
      status,
      resume_token: status === 'completed' ? {} : resume,
      processed_count: stats.total,
      indexed_count: stats.indexed,
      last_error: error,
      updated_at: now,
    };
    if (setStartedAt) payload.started_at = now;
    if (status === 'completed' || status === 'error') payload.completed_at = now;

    if (data) {
      await supabase.from('github_sync_state').update(payload).eq('id', data.id);
    } else {
      payload.created_at = now;
      await supabase.from('github_sync_state').insert(payload);
    }
  }

  private async markRepoSynced(request: GithubSyncRequest, headSha: string): Promise<void> {
    await supabase
      .from('github_repositories')
      .update({
        sync_status: 'done',
        last_sync_at: new Date().toISOString(),
        last_commit_sha: headSha || null,
        updated_at: new Date().toISOString(),
      })
      .eq('workspace_id', request.workspaceId)
      .eq('full_name', request.fullName);
  }

  private async checkpoint(ctx: RepoSyncContext, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - ctx.lastCheckpointAt < 5000) return;
    ctx.lastCheckpointAt = now;
    await this.markState(ctx.request.workspaceId, ctx.request.fullName, ctx.kind, 'running', ctx.resume, ctx.stats, null, false);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private hitMax(ctx: RepoSyncContext): boolean {
    if (ctx.indexedThisRun >= this.maxFilesPerRun) {
      ctx.stop = true;
      return true;
    }
    return false;
  }

  private emptyStats(): GithubSyncStats {
    return { total: 0, indexed: 0, skipped: 0, failed: 0, deleted: 0, durationMs: 0, phases: {} };
  }

  private countPhase(ctx: RepoSyncContext, type: GitHubDocumentType, action: 'indexed' | 'skipped' | 'failed'): void {
    const entry = (ctx.stats.phases[type] ||= { indexed: 0, skipped: 0, failed: 0 });
    entry[action]++;
  }

  private async runWithConcurrency<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    const runners = Array.from({ length: this.concurrency }, async () => {
      while (index < items.length) {
        const item = items[index++];
        if (item === undefined) break;
        await worker(item);
      }
    });
    await Promise.all(runners);
  }
}

export function createGithubSyncService(auth: GitHubAppAuth, options?: ConstructorParameters<typeof GithubSyncService>[1]): GithubSyncService {
  return new GithubSyncService(auth, options);
}
