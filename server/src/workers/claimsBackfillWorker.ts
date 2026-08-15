// Phase 3: knowledge-claims backfill worker (ADR-T15 backfill-worker step).
//
// Owns the `claims-backfill` BullMQ queue: a repeatable `batch` job every
// CLAIMS_BACKFILL_INTERVAL_MS (default 60s) sweeps up to N candidate
// documents whose chunks exist but whose claims were never derived, and
// re-derives knowledge_claims + claim_evidence through the SAME idempotent
// store the ingestion pipeline uses.
//
// Resumability lives in the database, not the queue: a row's
// claims_derived_at checkpoint (migration 039) advances only on success, so
// a crashed batch re-picks the same documents and the knowledge_claims
// unique key makes re-derivation a no-op. Poisoned documents are quarantined
// in-DB after CLAIMS_BACKFILL_MAX_FAILURES attempts — there is deliberately
// NO DLQ for this queue; a failing `batch` job (DB unreachable etc.) is
// retried by BullMQ defaults and the per-document outcomes are durable
// regardless of the job's own completion state.
//
// Runs in its own process (PROCESSES=claims-backfill-worker) so LLM-heavy
// backfilling never starves live ingestion; concurrency is 1 by design.

import { Worker, type Job } from 'bullmq';
import { redisConnection, claimsBackfillQueue } from '../queue/ingestionQueue.js';
import { logger } from '../logger.js';
import {
  checkBullMQQueueCounts,
  checkRedis,
  checkSupabase,
  startHealthServer,
} from '../services/health.js';
import {
  processClaimsBackfillBatch,
  countClaimsBackfillPending,
  DEFAULT_BACKFILL_BATCH_LIMIT,
  type BackfillBatchResult,
} from '../ingestion/claimsBackfill.js';

export interface ClaimsBackfillJobData {
  job_name: 'batch';
  /** Documents per sweep (defaults to DEFAULT_BACKFILL_BATCH_LIMIT). */
  limit?: number;
}

const REPEATABLE_JOB_ID = 'claims-backfill-batch';
const REPEATABLE_JOB_NAME = 'batch';

let workerInstance: Worker<ClaimsBackfillJobData> | null = null;
let lastBatchResult: BackfillBatchResult | null = null;

/**
 * The production `batch` processor — exported as the hermetic-test seam
 * (same pattern as processDocumentIngestionJob). Runs extraction + claim
 * persistence directly; the job-level retry covers only batch-wide failures
 * (e.g. database down), never per-document failures.
 */
export async function processClaimsBackfillJob(job: Job<ClaimsBackfillJobData>): Promise<BackfillBatchResult> {
  const startTime = Date.now();
  const limit = Number.isFinite(job.data?.limit) && (job.data?.limit ?? 0) > 0
    ? job.data!.limit!
    : DEFAULT_BACKFILL_BATCH_LIMIT;

  logger.info('claims_backfill_batch_started', { jobId: job.id, limit });

  const result = await processClaimsBackfillBatch({ limit });

  lastBatchResult = result;
  logger.info('claims_backfill_batch_completed', {
    jobId: job.id,
    scanned: result.scanned,
    succeeded: result.succeeded,
    failed: result.failed,
    claimsPersisted: result.claimsPersisted,
    durationMs: Date.now() - startTime,
  });
  return result;
}

export function createClaimsBackfillWorker(): Worker<ClaimsBackfillJobData> {
  const worker = new Worker<ClaimsBackfillJobData>(
    'claims-backfill',
    processClaimsBackfillJob,
    {
      connection: redisConnection,
      concurrency: 1,
      limiter: {
        max: 30,
        duration: 60000,
      },
    }
  );

  worker.on('completed', (job) => {
    logger.info('claims_backfill_job_completed_event', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('claims_backfill_job_failed', {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    });
  });

  worker.on('error', (err) => {
    if ((err as any).code === 'ECONNREFUSED') {
      // Redis offline in dev — suppress
    } else {
      logger.error('claims_backfill_worker_error', { error: (err as Error).message });
    }
  });

  return worker;
}

export function isClaimsBackfillWorkerRunning(): boolean {
  return workerInstance !== null && workerInstance.isRunning();
}

/**
 * Idempotently (re)registers the recurring sweep job. BullMQ v6 job
 * schedulers are upserts: calling this on every start updates the interval
 * in place and never double-enqueues, so any worker instance may own it.
 */
export async function ensureClaimsBackfillSchedule(): Promise<void> {
  const intervalMs = parseInt(process.env.CLAIMS_BACKFILL_INTERVAL_MS || '60000', 10);
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    logger.warn('claims_backfill_interval_too_small', { intervalMs });
    return;
  }

  await claimsBackfillQueue.upsertJobScheduler(
    REPEATABLE_JOB_ID,
    { every: intervalMs },
    {
      name: REPEATABLE_JOB_NAME,
      data: { job_name: REPEATABLE_JOB_NAME },
      opts: { removeOnComplete: true, removeOnFail: 100 },
    }
  );
  logger.info('claims_backfill_schedule_registered', { intervalMs });
}

export function startClaimsBackfillWorker(): Worker<ClaimsBackfillJobData> {
  if (!workerInstance) {
    logger.info('claims_backfill_worker_starting', {});
    workerInstance = createClaimsBackfillWorker();
  }
  void ensureClaimsBackfillSchedule().catch((err) => {
    logger.warn('claims_backfill_schedule_registration_failed', {
      message: (err as Error).message,
    });
  });
  const healthPort = parseInt(process.env.CLAIMS_BACKFILL_WORKER_HEALTH_PORT || '5007', 10);
  startHealthServer('claims-backfill-worker', healthPort, {
    checks: {
      redis: () => checkRedis(),
      supabase: () => checkSupabase(),
    },
    details: async () => {
      const queue = await checkBullMQQueueCounts(claimsBackfillQueue);
      return {
        workerRunning: isClaimsBackfillWorkerRunning(),
        queue: queue || 'unknown',
        lastBatch: lastBatchResult,
        pending: await countClaimsBackfillPending(),
      };
    },
  });
  return workerInstance;
}

export async function stopClaimsBackfillWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
  }
}