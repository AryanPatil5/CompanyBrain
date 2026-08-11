import { logger } from '../logger.js';
import { Worker, Queue, type Job } from 'bullmq';
import { redisConnection } from '../queue/ingestionQueue.js';
import { supabase } from '../config/supabase.js';
import {
  crawlSlackHistory,
  crawlGithubPostMortems,
  crawlLinearIncidents,
  crawlZendeskTickets,
  crawlEmailInbox,
  crawlDatabaseLogs,
} from '../services/crawler.js';
import { startTraceSpan, recordMetric } from '../middleware/telemetry.js';
import {
  checkBullMQQueueCounts,
  checkRedis,
  checkSupabase,
  startHealthServer,
} from '../services/health.js';
import { ingestionQueue } from '../queue/ingestionQueue.js';
import { processWebhookEventJob, recoverStaleWebhookEvents, DEFAULT_STALE_EVENT_TIMEOUT_MS } from '../ingestion/webhookPipeline.js';
import { updateEventStatus } from '../services/ingestion/webhookService.js';
import { dispatchConnectorSync, isCrawlerV2Enabled } from '../connectors/registry.js';
import { registerBuiltinConnectors } from '../connectors/register.js';

export interface IngestionJobData {
  job_name: 'crawl_slack' | 'crawl_github' | 'crawl_linear' | 'crawl_zendesk' | 'crawl_email' | 'crawl_db' | 'crawl_provider' | 'all';
  workspace_id: string;
  requested_by?: string;
  inbox?: string;
  target_system?: string;
  provider?: string;
  incremental?: boolean;
}

export interface WebhookEventJobData {
  eventId: string;
  workspaceId: string;
}

let workerInstance: Worker<IngestionJobData> | null = null;
let webhookWorkerInstance: Worker<WebhookEventJobData> | null = null;
let webhookSweepTimer: NodeJS.Timeout | null = null;

// Dead-Letter Queue (DLQ) for failed ingestion tasks requiring manual inspection
export const dlqQueue = new Queue<IngestionJobData>('ingestion-dlq', { connection: redisConnection });
export const webhookDlqQueue = new Queue<WebhookEventJobData>('webhook-ingestion-dlq', { connection: redisConnection });

async function logJobLifecycle(params: {
  jobId: string;
  jobName: string;
  workspaceId: string;
  status: 'started' | 'completed' | 'failed' | 'dlq_routed';
  result?: any;
  error?: string;
}) {
  try {
    const { jobId, jobName, workspaceId, status, result, error } = params;

    await supabase.from('execution_logs').insert({
      workspace_id: workspaceId,
      step_execution_id: jobId,
      sop_id: null,
      target_system: `crawler:${jobName}`,
      status: status === 'completed' ? 'success' : status === 'failed' ? 'failed' : 'pending',
      input_payload: { jobName, jobId },
      output_payload: result || { error: error || null },
      error_message: error || null,
      executed_at: new Date().toISOString(),
    });

    if (status === 'failed' || status === 'dlq_routed') {
      await supabase.from('ingestion_failures').insert({
        workspace_id: workspaceId,
        source: jobName,
        external_id: jobId,
        error_reason: error || 'Worker execution failed',
      });
    }
  } catch (logErr) {
    logger.warn('[IngestionWorker Warning] Failed to write audit log:', logErr);
  }
}

/**
 * The production ingestion job processor — the exact handler BullMQ invokes
 * inside createIngestionWorker().
 *
 * Exported as a seam for the hermetic suites: the test harness stubs
 * `Worker.prototype.run` (no polling, no job delivery), so the production
 * processor would otherwise never execute in CI. Suites invoke this function
 * directly with a controlled fake job to exercise the REAL logic — including
 * the CRAWLER_V2 `crawl_provider` dispatch path and its flag gate — without
 * live Redis.
 */
export async function processIngestionJob(job: Job<IngestionJobData>): Promise<unknown> {
  const { job_name, workspace_id, inbox } = job.data;
  const span = startTraceSpan(`BullMQ Job ${job_name}`, { jobId: job.id, workspaceId: workspace_id });
  const startTime = Date.now();

  logger.info(`[IngestionWorker] Processing job ${job.id} (${job_name}) for workspace ${workspace_id}... (Attempt #${job.attemptsMade + 1})`);

  await job.updateProgress(10);
  await logJobLifecycle({ jobId: job.id!, jobName: job_name, workspaceId: workspace_id, status: 'started' });

  let result: any = null;

  switch (job_name) {
    case 'crawl_slack': {
      result = await crawlSlackHistory(process.env.SLACK_INCIDENT_CHANNEL_ID || 'C0123456789', workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_github': {
      result = await crawlGithubPostMortems(process.env.GITHUB_REPO || 'owner/repo', workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_linear': {
      result = await crawlLinearIncidents(workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_zendesk': {
      result = await crawlZendeskTickets(workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_email': {
      const targetInbox = inbox || process.env.OPS_INBOX_EMAIL || 'ops-support@company.com';
      result = await crawlEmailInbox(targetInbox, workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_db': {
      result = await crawlDatabaseLogs(workspace_id);
      await job.updateProgress(100);
      break;
    }
    case 'crawl_provider': {
      // CRAWLER_V2 (Phase 2 Task 2): generic registry-dispatched crawl.
      // Strictly flag-gated: with the flag off the route rejects this job
      // name, and even if a job somehow landed here we fail loudly rather
      // than falling back to legacy behavior.
      if (!isCrawlerV2Enabled()) {
        throw new Error('crawl_provider dispatch is disabled: CRAWLER_V2 is not enabled.');
      }
      // Defensively validate the type as well as emptiness: job payloads
      // arrive via JSON deserialization, so a non-string provider must hit
      // this controlled contract error — not a raw `provider.trim()` TypeError.
      const provider = job.data.provider;
      if (typeof provider !== 'string' || !provider.trim()) {
        throw new Error('crawl_provider job requires a non-empty provider field.');
      }
      result = await dispatchConnectorSync(provider.trim(), workspace_id, {
        incremental: job.data.incremental,
      });
      await job.updateProgress(100);
      break;
    }
    case 'all': {
      await job.updateProgress(20);
      const slack = await crawlSlackHistory(process.env.SLACK_INCIDENT_CHANNEL_ID || 'C0123456789', workspace_id);
      await job.updateProgress(40);
      const github = await crawlGithubPostMortems(process.env.GITHUB_REPO || 'owner/repo', workspace_id);
      await job.updateProgress(60);
      const linear = await crawlLinearIncidents(workspace_id);
      await job.updateProgress(80);
      const zendesk = await crawlZendeskTickets(workspace_id);
      const email = await crawlEmailInbox(inbox || 'ops-support@company.com', workspace_id);
      const db = await crawlDatabaseLogs(workspace_id);
      await job.updateProgress(100);
      result = { slack, github, linear, zendesk, email, db };
      break;
    }
    default: {
      throw new Error(`Unsupported job_name: ${job_name}`);
    }
  }

  await logJobLifecycle({
    jobId: job.id!,
    jobName: job_name,
    workspaceId: workspace_id,
    status: 'completed',
    result,
  });

  const durationMs = Date.now() - startTime;
  span.end('ok');
  recordMetric('ingestion_queue_latency_ms', durationMs, { job_name, workspace_id });

  return result;
}

export function createIngestionWorker(): Worker<IngestionJobData> {
  const worker = new Worker<IngestionJobData>(
    'IngestionQueue',
    processIngestionJob,
    {
      connection: redisConnection,
      concurrency: 5, // Concurrency: 5 parallel workers
      limiter: {
        max: 100,
        duration: 60000, // 100 jobs per 60 seconds
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[IngestionWorker] Job ${job.id} (${job.name}) completed successfully.`);
  });

  worker.on('failed', async (job, err) => {
    logger.error(`[IngestionWorker] Job ${job?.id} (${job?.name}) failed:`, err.message);

    if (job) {
      // Check if job exhausted maximum attempts (3) -> route to Dead-Letter Queue (DLQ)
      if (job.attemptsMade >= (job.opts.attempts || 3)) {
        logger.warn(`[IngestionWorker] Job ${job.id} reached maximum retries. Routing to Dead-Letter Queue (ingestion-dlq)...`);
        try {
          await dlqQueue.add('dlq_failed_ingestion', job.data, {
            jobId: `dlq_${job.id}`,
          });
          await logJobLifecycle({
            jobId: job.id!,
            jobName: job.data.job_name,
            workspaceId: job.data.workspace_id,
            status: 'dlq_routed',
            error: `Max retries exhausted: ${err.message}`,
          });
        } catch (dlqErr: any) {
          logger.error('[IngestionWorker Error] Failed to push to DLQ:', dlqErr.message);
        }
      } else {
        await logJobLifecycle({
          jobId: job.id!,
          jobName: job.data.job_name,
          workspaceId: job.data.workspace_id,
          status: 'failed',
          error: err.message,
        });
      }
    }
  });

  worker.on('error', (err) => {
    if ((err as any).code === 'ECONNREFUSED') {
      // Suppress offline Redis dev message
    } else {
      logger.error('[IngestionWorker Error]:', err);
    }
  });

  return worker;
}

export function isIngestionWorkerRunning(): boolean {
  return workerInstance !== null && workerInstance.isRunning();
}

/**
 * Webhook consumer worker (Phase 2 Task 1): drains `webhook-ingestion` jobs
 * enqueued by the durable pipeline. Each job processes the persisted
 * raw_source_events row exactly-once (event status + Phase 1 idempotency
 * ledger), so provider redeliveries and Redis-outage recovery never produce
 * duplicate SOPs. Runs inside the `ingestion-worker` process.
 */
export function createWebhookEventWorker(): Worker<WebhookEventJobData> {
  const worker = new Worker<WebhookEventJobData>(
    'webhook-ingestion',
    async (job: Job<WebhookEventJobData>) => {
      const { eventId, workspaceId } = job.data;
      const span = startTraceSpan('BullMQ Webhook Event', { jobId: job.id, eventId, workspaceId });
      const startTime = Date.now();

      logger.info(`[WebhookWorker] Processing event ${eventId} for workspace ${workspaceId}... (Attempt #${job.attemptsMade + 1})`);
      await logJobLifecycle({ jobId: job.id!, jobName: 'webhook_event', workspaceId, status: 'started' });

      const result = await processWebhookEventJob({
        eventId,
        workspaceId,
        // BullMQ v6 semantics (verified against node_modules/bullmq): inside
        // the processor `job.attemptsMade` counts COMPLETED attempts before
        // this one, and it is incremented by moveToFinished BEFORE the
        // 'failed' event fires. So the current attempt number is
        // `attemptsMade + 1` and `attemptsMade + 1 >= attempts` marks the
        // final attempt (the 'failed' handler then routes to the DLQ).
        attempts: { made: job.attemptsMade + 1, max: job.opts.attempts || 3 },
      });

      await logJobLifecycle({
        jobId: job.id!,
        jobName: 'webhook_event',
        workspaceId,
        status: 'completed',
        result,
      });

      span.end('ok');
      recordMetric('webhook_event_latency_ms', Date.now() - startTime, { eventId, workspaceId });
      return result;
    },
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    logger.info(`[WebhookWorker] Event job ${job.id} (${job.data.eventId}) completed.`);
  });

  worker.on('failed', async (job, err) => {
    logger.error(`[WebhookWorker] Event job ${job?.id} (${job?.data?.eventId}) failed:`, err.message);

    if (job) {
      const maxAttempts = job.opts.attempts || 3;
      try {
        if (job.attemptsMade >= maxAttempts) {
          // Attempts are genuinely exhausted (bullmq v6 increments
          // attemptsMade in moveToFinished BEFORE emitting 'failed', so
          // attemptsMade >= attempts here means this was the last try).
          // Preserve the failed state and route the job to the DLQ.
          await updateEventStatus(job.data.eventId, {
            status: 'failed',
            error_message: err.message,
          }, job.data.workspaceId);
          logger.warn(`[WebhookWorker] Event job ${job.id} reached maximum retries. Routing to webhook-ingestion-dlq...`);
          try {
            await webhookDlqQueue.add('dlq_failed_webhook_event', job.data, { jobId: `dlq_${job.id}` });
            await logJobLifecycle({
              jobId: job.id!,
              jobName: 'webhook_event',
              workspaceId: job.data.workspaceId,
              status: 'dlq_routed',
              error: `Max retries exhausted: ${err.message}`,
            });
          } catch (dlqErr: any) {
            logger.error('[WebhookWorker Error] Failed to push to webhook DLQ:', dlqErr.message);
          }
        } else {
          // BullMQ will retry this job. The pipeline's catch deliberately
          // leaves the event 'processing' on a transient failure — reset it
          // to 'queued' so the next attempt can atomically re-claim it and
          // actually re-run the work (instead of skipping a terminal event).
          await updateEventStatus(job.data.eventId, { status: 'queued', error_message: null }, job.data.workspaceId);
          await logJobLifecycle({
            jobId: job.id!,
            jobName: 'webhook_event',
            workspaceId: job.data.workspaceId,
            status: 'failed',
            error: err.message,
          });
        }
      } catch (statusErr) {
        logger.warn('[WebhookWorker Warning] Failed to update event status:', statusErr);
      }
    }
  });

  worker.on('error', (err) => {
    if ((err as any).code === 'ECONNREFUSED') {
      // Suppress offline Redis dev message
    } else {
      logger.error('[WebhookWorker Error]:', err);
    }
  });

  return worker;
}

export function isWebhookEventWorkerRunning(): boolean {
  return webhookWorkerInstance !== null && webhookWorkerInstance.isRunning();
}

export function startWebhookEventWorker(): Worker<WebhookEventJobData> {
  if (!webhookWorkerInstance) {
    logger.info('[WebhookWorker] Starting BullMQ webhook event worker (Concurrency: 3)...');
    webhookWorkerInstance = createWebhookEventWorker();
  }

  // Stale-event recovery sweep (Phase 2 Task 1): periodically re-claims
  // events stranded in `received`/`processing` beyond the stale timeout
  // (worker crash, lost status update, Redis outage at enqueue time) and
  // re-enqueues the canonical { eventId, workspaceId } job. Timings are
  // env-overridable; the timer never keeps the process alive by itself.
  if (!webhookSweepTimer) {
    const staleTimeoutMs = parseInt(process.env.WEBHOOK_STALE_EVENT_TIMEOUT_MS || String(DEFAULT_STALE_EVENT_TIMEOUT_MS), 10);
    const sweepIntervalMs = parseInt(process.env.WEBHOOK_STALE_SWEEP_INTERVAL_MS || '60000', 10);
    let sweeping = false;
    webhookSweepTimer = setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      void (async () => {
        try {
          const result = await recoverStaleWebhookEvents({ staleAfterMs: staleTimeoutMs });
          if (result.recovered > 0 || result.failed > 0) {
            logger.info(
              `[WebhookWorker] Stale event sweep: ${result.recovered} recovered, ${result.skipped} skipped (worker alive), ${result.failed} failed.`,
            );
          }
        } catch (err) {
          logger.warn('[WebhookWorker Warning] Stale event sweep failed:', err);
        } finally {
          sweeping = false;
        }
      })();
    }, sweepIntervalMs);
    webhookSweepTimer.unref();
  }

  return webhookWorkerInstance;
}

export async function stopWebhookEventWorker(): Promise<void> {
  if (webhookSweepTimer) {
    clearInterval(webhookSweepTimer);
    webhookSweepTimer = null;
  }
  if (webhookWorkerInstance) {
    logger.info('[WebhookWorker] Stopping webhook event worker...');
    await webhookWorkerInstance.close();
    webhookWorkerInstance = null;
  }
}

export function startIngestionWorker(): Worker<IngestionJobData> {
  // The connector registry is process-local: register builtins so
  // CRAWLER_V2=true crawl_provider jobs can resolve their connector. Idempotent.
  registerBuiltinConnectors();

  if (!workerInstance) {
    logger.info('[IngestionWorker] Starting BullMQ Ingestion Worker (Concurrency: 5, Rate Limiter: 100/min)...');
    workerInstance = createIngestionWorker();
  }
  startWebhookEventWorker();
  const healthPort = parseInt(process.env.INGESTION_WORKER_HEALTH_PORT || '5004', 10);
  startHealthServer('ingestion-worker', healthPort, {
    checks: {
      redis: () => checkRedis(),
      supabase: () => checkSupabase(),
    },
    details: async () => {
      const queue = await checkBullMQQueueCounts(ingestionQueue);
      return {
        workerRunning: isIngestionWorkerRunning() && isWebhookEventWorkerRunning(),
        webhookWorkerRunning: isWebhookEventWorkerRunning(),
        queue: queue || 'unknown',
      };
    },
  });
  return workerInstance;
}

export async function stopIngestionWorker(): Promise<void> {
  await stopWebhookEventWorker();
  if (workerInstance) {
    logger.info('[IngestionWorker] Stopping BullMQ Ingestion Worker...');
    await workerInstance.close();
    workerInstance = null;
  }
}
