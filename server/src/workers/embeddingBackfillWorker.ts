// Phase 4 T2: embedding backfill worker — consumes the `embedding-backfill`
// BullMQ queue INSIDE the ingestion-worker process (roadmap Phase 4: "no
// topology change"). A BullMQ v6 job scheduler fires one `batch` job per
// sweep (EMBEDDING_BACKFILL_INTERVAL_MS, default 60s); each job processes
// ONE bounded keyset page (concurrency 1 at the queue level; the chunk-level
// bounded pool lives in the core module).
//
// The processor seam (processEmbeddingBackfillJob) lives in
// src/ingestion/embeddingBackfill.ts so the core stays queue-free and
// hermetically testable (house pattern: claimsBackfill). This module is the
// thin queue citizen: scheduler registration, cursor persistence, lifecycle
// and health details.
//
// Resume: the batch result carries nextCursor; this worker re-upserts the
// scheduler template so subsequent sweeps (and restarts — the template is
// persisted in Redis) resume with `WHERE id < cursor` instead of rescanning
// the head. Skip-when-current makes the cursor a pure optimization: a stale
// or missing cursor re-scans pages and skips chunks that are already
// current — zero provider calls for them. Never clobbers an existing
// scheduler on boot (a persisted cursor survives restarts).
//
// No DLQ: per-chunk failures are isolated and counted in the job result
// (honest job state); scan-level/DB errors throw and BullMQ's default retry
// (attempts 3, exponential backoff) re-fires the job.

import { Worker, type Job } from 'bullmq';
import { redisConnection, embeddingBackfillQueue } from '../queue/ingestionQueue.js';
import { logger } from '../logger.js';
import {
  processEmbeddingBackfillJob,
  embeddingBackfillConfig,
  resetEmbeddingBackfillState,
  getLastEmbeddingBackfillBatch,
  isEmbeddingBackfillRunning,
  poisonedChunkCount,
  type EmbeddingBackfillJobData,
  type EmbeddingBackfillBatchResult,
} from '../ingestion/embeddingBackfill.js';

const SCHEDULER_ID = 'embedding-backfill-batch';

export type { EmbeddingBackfillJobData, EmbeddingBackfillBatchResult };

let workerInstance: Worker<EmbeddingBackfillJobData> | null = null;
let lastObservedCursor: string | null = null;

export function isEmbeddingBackfillWorkerRunning(): boolean {
  return workerInstance !== null && workerInstance.isRunning();
}

/** Scheduler template shared by registration + cursor persistence. */
export function embeddingBackfillSchedulerTemplate(cursor: string | null): {
  name: string;
  data: EmbeddingBackfillJobData;
  opts: { removeOnComplete: boolean; removeOnFail: number };
} {
  return {
    name: 'batch',
    data: { job_name: 'batch', cursor },
    opts: { removeOnComplete: true, removeOnFail: 100 },
  };
}

/** Worker-side handler: core seam + resume-optimization cursor persistence. */
export async function processEmbeddingBackfillWorkerJob(
  job: Job<EmbeddingBackfillJobData>
): Promise<EmbeddingBackfillBatchResult> {
  const result = await processEmbeddingBackfillJob(job);
  if (result.nextCursor !== lastObservedCursor) {
    await persistSchedulerCursor(result.nextCursor);
    lastObservedCursor = result.nextCursor;
  }
  return result;
}

/** Resume optimization: re-upsert the scheduler template cursor in Redis. */
async function persistSchedulerCursor(cursor: string | null): Promise<void> {
  try {
    const cfg = embeddingBackfillConfig();
    await embeddingBackfillQueue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: cfg.intervalMs },
      embeddingBackfillSchedulerTemplate(cursor)
    );
    logger.debug('embedding_backfill_cursor_persisted', { cursor: cursor ?? null });
  } catch (err) {
    // Optimization only — never fail the job over cursor persistence.
    logger.warn('embedding_backfill_cursor_persist_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Register the sweep schedule. Never clobbers an existing scheduler: a
 * persisted cursor from a previous process survives restarts (resume). A
 * missing scheduler is created from the head (cursor null).
 */
export async function ensureEmbeddingBackfillScheduler(): Promise<void> {
  const cfg = embeddingBackfillConfig();
  if (cfg.intervalMs < 10_000) {
    logger.warn('embedding_backfill_interval_too_small', { intervalMs: cfg.intervalMs });
    return;
  }
  const existing = await embeddingBackfillQueue.getJobScheduler(SCHEDULER_ID);
  if (!existing) {
    await embeddingBackfillQueue.upsertJobScheduler(
      SCHEDULER_ID,
      { every: cfg.intervalMs },
      embeddingBackfillSchedulerTemplate(null)
    );
    logger.info('embedding_backfill_scheduler_registered', { intervalMs: cfg.intervalMs });
  }
}

function createEmbeddingBackfillWorker(): Worker<EmbeddingBackfillJobData> {
  const worker = new Worker<EmbeddingBackfillJobData>('embedding-backfill', processEmbeddingBackfillWorkerJob, {
    connection: redisConnection,
    concurrency: 1,
  });
  worker.on('failed', (job, err) => {
    logger.warn('embedding_backfill_job_failed', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      message: err.message,
    });
  });
  worker.on('error', (err) => {
    if ((err as { code?: string }).code !== 'ECONNREFUSED') {
      logger.error('embedding_backfill_worker_error', { message: (err as Error).message });
    }
  });
  return worker;
}

export function startEmbeddingBackfillWorker(): void {
  if (workerInstance) return;
  resetEmbeddingBackfillState();
  workerInstance = createEmbeddingBackfillWorker();
  void ensureEmbeddingBackfillScheduler().catch((err) => {
    logger.warn('embedding_backfill_scheduler_registration_failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  logger.info('embedding_backfill_worker_started');
}

export async function stopEmbeddingBackfillWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    logger.info('embedding_backfill_worker_stopped');
  }
}

/** Health payload merged into the ingestion-worker /health details. */
export function embeddingBackfillHealthDetails(): Record<string, unknown> {
  const last = getLastEmbeddingBackfillBatch();
  return {
    embeddingBackfillRunning: isEmbeddingBackfillWorkerRunning() || isEmbeddingBackfillRunning(),
    embeddingBackfillPoisonedChunks: poisonedChunkCount(),
    embeddingBackfillLastBatch: last
      ? {
          scanned: last.scanned,
          skippedCurrent: last.skippedCurrent,
          skippedQuarantined: last.skippedQuarantined,
          reembedded: last.reembedded,
          failed: last.failed,
          retryableFailures: last.retryableFailures,
          permanentFailures: last.permanentFailures,
          concurrentModifications: last.concurrentModifications,
          nextCursor: last.nextCursor,
          durationMs: last.durationMs,
        }
      : null,
  };
}