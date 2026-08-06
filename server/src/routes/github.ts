import { Router, Request, Response } from 'express';
import { authenticate, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { ingestionLimiter } from '../middleware/rateLimiter.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { githubSyncQueue } from '../queue/githubSyncQueue.js';
import { createGitHubAppAuth } from '../connectors/github/auth.js';
import { createGithubSyncService } from '../connectors/github/sync.js';
import { splitFullName } from '../connectors/github/mapper.js';

const router = Router();

function requireGitHubAppConfigured(res: Response): boolean {
  const auth = createGitHubAppAuth();
  if (!auth.isConfigured()) {
    res.status(530).json({
      error: 'integration_not_configured',
      provider: 'github',
      detail: 'Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH) in the server environment.',
    });
    return false;
  }
  return true;
}

/**
 * GET /api/github/installations — list GitHub App installations the app can see.
 */
router.get('/installations', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!requireGitHubAppConfigured(res)) return;
    const service = createGithubSyncService(createGitHubAppAuth());
    const installations = await service.listInstallations();
    res.json({ installations });
  } catch (err) {
    logger.error('github_route_list_installations_failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list GitHub installations.' });
  }
});

/**
 * GET /api/github/installations/:id/repositories — repositories selectable
 * for a given installation.
 */
router.get('/installations/:id/repositories', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!requireGitHubAppConfigured(res)) return;
    const installationId = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(installationId)) {
      res.status(400).json({ error: 'Invalid installation id.' });
      return;
    }
    const service = createGithubSyncService(createGitHubAppAuth());
    const repositories = await service.listRepositories(installationId);
    res.json({ installationId, repositories });
  } catch (err) {
    logger.error('github_route_list_repositories_failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to list repositories for installation.' });
  }
});

/**
 * POST /api/github/sync — start indexing one or more repositories.
 * Body: { installationId, repositories?: [{ repoId, fullName, branch? }] }
 * When repositories is omitted, every repo in the installation is enqueued.
 */
router.post('/sync', authenticate, requireRole(['admin']), ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const installationId = Number.parseInt(req.body?.installationId, 10);
    const repositories: Array<{ repoId: number; fullName: string; branch?: string }> = req.body?.repositories || [];

    if (!Number.isFinite(installationId)) {
      res.status(400).json({ error: 'Missing or invalid installationId.' });
      return;
    }
    for (const repo of repositories) {
      if (!repo.fullName || repo.fullName.split('/').length !== 2) {
        res.status(400).json({ error: `Invalid repository full name: ${repo.fullName}` });
        return;
      }
    }

    if (!requireGitHubAppConfigured(res)) return;

    if (repositories.length === 0) {
      await githubSyncQueue.add(
        'sync_installation',
        { job_name: 'sync_installation', workspaceId, installationId },
        { jobId: `ghinstall-${workspaceId}-${installationId}` }
      );
      res.json({ status: 'queued', mode: 'sync_installation', installationId, repositories: 'all' });
      return;
    }

    const enqueued: Array<{ fullName: string; jobId: string }> = [];
    for (const repo of repositories) {
      const { owner, name } = splitFullName(repo.fullName);
      await supabase.from('github_repositories').upsert(
        {
          workspace_id: workspaceId,
          installation_id: installationId,
          repo_id: repo.repoId,
          owner,
          name,
          full_name: repo.fullName,
          default_branch: repo.branch || null,
          sync_status: 'queued',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'workspace_id, repo_id' }
      );

      const jobId = `ghsync-${workspaceId}-${repo.fullName}-initial`;
      await githubSyncQueue.add(
        'sync_repository',
        {
          job_name: 'sync_repository',
          workspaceId,
          installationId,
          repoId: repo.repoId,
          fullName: repo.fullName,
          branch: repo.branch,
          incremental: false,
          trigger: 'manual',
        },
        { jobId, removeOnComplete: true, removeOnFail: 500 }
      );
      enqueued.push({ fullName: repo.fullName, jobId });
    }

    logger.info('github_route_sync_queued', { workspaceId, installationId, repositories: enqueued.map((e) => e.fullName) });
    res.json({ status: 'queued', mode: 'sync_repository', enqueued });
  } catch (err) {
    logger.error('github_route_sync_failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to queue GitHub sync.' });
  }
});

/**
 * POST /api/github/repositories/:repositoryId/sync — incremental resync of a
 * single repository (repositoryId = URL-encoded "owner/name").
 */
router.post('/repositories/:repositoryId/sync', authenticate, requireRole(['admin']), ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const fullName = decodeURIComponent(req.params.repositoryId);

    const { data: repo } = await supabase
      .from('github_repositories')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('full_name', fullName)
      .maybeSingle();

    if (!repo) {
      res.status(404).json({ error: 'Repository not found for this workspace.' });
      return;
    }

    const jobId = `ghsync-${workspaceId}-${fullName}-incremental`;
    await githubSyncQueue.add(
      'sync_repository',
      {
        job_name: 'sync_repository',
        workspaceId,
        installationId: repo.installation_id,
        repoId: repo.repo_id,
        fullName: repo.full_name,
        branch: repo.default_branch || undefined,
        incremental: true,
        trigger: 'manual',
      },
      { jobId, removeOnComplete: true, removeOnFail: 500 }
    );

    res.json({ status: 'queued', mode: 'incremental', fullName, jobId });
  } catch (err) {
    logger.error('github_route_incremental_sync_failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to queue incremental sync.' });
  }
});

/**
 * GET /api/github/sync/status — sync state for all repositories the workspace
 * has connected.
 */
router.get('/sync/status', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;

    const { data: repos, error: reposError } = await supabase
      .from('github_repositories')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('last_sync_at', { ascending: false });

    if (reposError) throw reposError;

    const { data: states, error: statesError } = await supabase
      .from('github_sync_state')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false });

    if (statesError) throw statesError;

    res.json({
      repositories: repos || [],
      syncStates: states || [],
    });
  } catch (err) {
    logger.error('github_route_sync_status_failed', { error: (err as Error).message });
    res.status(500).json({ error: 'Failed to load GitHub sync status.' });
  }
});

export default router;
