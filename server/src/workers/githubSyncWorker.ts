import { Worker, type Job } from 'bullmq';
import { redisConnection } from '../queue/ingestionQueue.js';
import { githubSyncQueue } from '../queue/githubSyncQueue.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../logger.js';
import { createGitHubAppAuth } from '../connectors/github/auth.js';
import { createGithubSyncService } from '../connectors/github/sync.js';
import { createGithubWebhookHandler } from '../connectors/github/webhook.js';
import type { GithubSyncJobData } from '../connectors/github/types.js';
import {
  checkBullMQQueueCounts,
  checkRedis,
  checkSupabase,
  withTimeout,
  startHealthServer,
} from '../services/health.js';

let workerInstance: Worker<GithubSyncJobData> | null = null;

async function logJobLifecycle(params: {
  jobId: string;
  jobName: string;
  workspaceId: string;
  status: 'started' | 'completed' | 'failed';
  error?: string;
}) {
  try {
    const { jobId, jobName, workspaceId, status, error } = params;
    await supabase.from('execution_logs').insert({
      workspace_id: workspaceId,
      step_execution_id: jobId,
      sop_id: null,
      target_system: `github-connector:${jobName}`,
      status: status === 'completed' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      input_payload: { jobName, jobId },
      output_payload: error ? { error } : {},
      error_message: error || null,
      executed_at: new Date().toISOString(),
    });

    if (status === 'failed') {
      await supabase.from('ingestion_failures').insert({
        workspace_id: workspaceId,
        source: 'github',
        external_id: jobId,
        error_reason: error || 'GitHub sync worker execution failed',
      });
    }
  } catch (logErr) {
    logger.warn('github_worker_audit_log_failed', { error: (logErr as Error).message });
  }
}

export function createGithubSyncWorker(): Worker<GithubSyncJobData> {
  const worker = new Worker<GithubSyncJobData>(
    'github-sync',
    async (job: Job<GithubSyncJobData>) => {
      const { job_name, workspaceId } = job.data;
      const startTime = Date.now();
      logger.info('github_worker_job_started', {
        jobId: job.id,
        jobName: job_name,
        workspaceId,
        attempt: job.attemptsMade + 1,
      });

      await logJobLifecycle({ jobId: job.id!, jobName: job_name, workspaceId, status: 'started' });

      let result: any = null;
      switch (job_name) {
        case 'sync_installation': {
          const data = job.data;
          const auth = createGitHubAppAuth();
          const service = createGithubSyncService(auth);
          const repos = await service.listRepositories(data.installationId);
          await upsertRepositories(data.workspaceId, data.installationId, repos);

          const selected = data.repositories || repos.map((r) => ({ repoId: r.id, fullName: r.fullName, branch: undefined }));
          const enqueued: string[] = [];
          let delay = 0;
          for (const repo of selected) {
            await githubSyncQueue.add(
              'sync_repository',
              {
                job_name: 'sync_repository',
                workspaceId: data.workspaceId,
                installationId: data.installationId,
                repoId: repo.repoId,
                fullName: repo.fullName,
                branch: repo.branch,
                incremental: false,
                trigger: 'installation',
              },
              {
                jobId: `ghsync-${data.workspaceId}-${repo.fullName}-initial`,
                delay,
                removeOnComplete: true,
                removeOnFail: 500,
              }
            );
            enqueued.push(repo.fullName);
            delay += 500; // stagger per-repo starts to smooth rate-limit bursts
          }
          result = { installationId: data.installationId, enqueued };
          break;
        }

        case 'sync_repository': {
          const data = job.data;
          const auth = createGitHubAppAuth();
          const service = createGithubSyncService(auth);
          result = await service.syncRepository({
            workspaceId: data.workspaceId,
            installationId: data.installationId,
            repoId: data.repoId,
            fullName: data.fullName,
            branch: data.branch,
            incremental: data.incremental,
            include: data.include,
          });
          break;
        }

        case 'webhook_event': {
          const data = job.data;
          const handler = createGithubWebhookHandler();
          result = await handler.handleEvent({
            event: data.event,
            deliveryId: data.deliveryId,
            payload: data.payload,
            workspaceId: data.workspaceId,
          });
          break;
        }

        default: {
          throw new Error(`Unsupported github job_name: ${job_name}`);
        }
      }

      await logJobLifecycle({ jobId: job.id!, jobName: job_name, workspaceId, status: 'completed' });
      logger.info('github_worker_job_completed', {
        jobId: job.id,
        jobName: job_name,
        workspaceId,
        durationMs: Date.now() - startTime,
      });
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 2, // repo syncs are heavy and share the GitHub rate-limit budget
    }
  );

  worker.on('completed', (job) => {
    logger.info('github_worker_job_completed_event', { jobId: job.id, jobName: job.data.job_name });
  });

  worker.on('failed', async (job, err) => {
    logger.error('github_worker_job_failed', {
      jobId: job?.id,
      jobName: job?.data.job_name,
      workspaceId: job?.data.workspaceId,
      error: err.message,
    });
    if (job) {
      await logJobLifecycle({
        jobId: job.id!,
        jobName: job.data.job_name,
        workspaceId: job.data.workspaceId,
        status: 'failed',
        error: err.message,
      });
    }
  });

  worker.on('error', (err) => {
    if ((err as any).code === 'ECONNREFUSED') {
      // Redis offline in dev — suppress
    } else {
      logger.error('github_worker_error', { error: err.message });
    }
  });

  return worker;
}

export function isGithubSyncWorkerRunning(): boolean {
  return workerInstance !== null && workerInstance.isRunning();
}

export function isGithubTokenConfigured(): boolean {
  const appId = (process.env.GITHUB_APP_ID || '').trim();
  const privateKey = (process.env.GITHUB_APP_PRIVATE_KEY || '').trim();
  const privateKeyPath = (process.env.GITHUB_APP_PRIVATE_KEY_PATH || '').trim();
  return appId.length > 0 && (privateKey.length > 0 || privateKeyPath.length > 0);
}

export function startGithubSyncWorker(): Worker<GithubSyncJobData> {
  if (!workerInstance) {
    logger.info('github_worker_starting', {});
    workerInstance = createGithubSyncWorker();
  }
  const healthPort = parseInt(process.env.GITHUB_SYNC_WORKER_HEALTH_PORT || '5005', 10);
  startHealthServer('github-sync-worker', healthPort, {
    checks: {
      redis: () => checkRedis(),
      supabase: () => checkSupabase(),
    },
    details: async () => {
      const queue = await checkBullMQQueueCounts(githubSyncQueue);
      const lastSyncAt = await withTimeout(2500, Promise.resolve()
        .then(async () => {
          const { data } = await supabase
            .from('github_repositories')
            .select('last_sync_at')
            .not('last_sync_at', 'is', null)
            .order('last_sync_at', { ascending: false })
            .limit(1);
          return data && data.length > 0 ? data[0].last_sync_at : null;
        })
        .catch(() => null));
      return {
        workerRunning: isGithubSyncWorkerRunning(),
        tokenConfigured: isGithubTokenConfigured(),
        queue: queue || 'unknown',
        lastSyncAt,
      };
    },
  });
  return workerInstance;
}

export async function stopGithubSyncWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}

async function upsertRepositories(
  workspaceId: string,
  installationId: number,
  repos: Array<{ id: number; fullName: string; owner: string; name: string; defaultBranch: string; private: boolean; permissions: Record<string, boolean> }>
): Promise<void> {
  for (const repo of repos) {
    await supabase.from('github_repositories').upsert(
      {
        workspace_id: workspaceId,
        installation_id: installationId,
        repo_id: repo.id,
        owner: repo.owner,
        name: repo.name,
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        is_private: repo.private,
        permissions: repo.permissions,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id, repo_id' }
    );
  }
}
