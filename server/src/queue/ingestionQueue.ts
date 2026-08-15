import { logger } from '../logger.js';
import { Queue, type QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Bounded reconnect (Phase 1 hardening): ioredis's default retryStrategy
// retries forever, so a dead Redis makes every queue-touching process spin
// indefinitely. We retry with capped backoff for ~25s, then stop (returning
// null); the process stays alive and /health reports Redis unavailable.
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 5000;

export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (times > MAX_RECONNECT_ATTEMPTS) {
      logger.warn(
        `[IngestionQueue Warning] Redis unreachable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts — giving up (dependencies report Redis unavailable on /health).`,
      );
      return null;
    }
    return Math.min(100 * 2 ** (times - 1), MAX_RECONNECT_DELAY_MS);
  },
});

redisConnection.on('error', (err) => {
  if ((err as any).code === 'ECONNREFUSED') {
    logger.warn(`[IngestionQueue Warning] Redis connection refused at ${REDIS_URL}. Ensure Redis server is running.`);
  } else {
    logger.error('[IngestionQueue Redis Error]:', err);
  }
});

const queueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
};

export const ingestionQueue = new Queue('IngestionQueue', queueOptions);
export const webhookIngestionQueue = new Queue('webhook-ingestion', queueOptions);
export const documentIngestionQueue = new Queue('document-ingestion', queueOptions);
// Phase 3 (ADR-T15): claims backfill — one `batch` job per sweep, consumed by
// the claims-backfill-worker process with concurrency 1.
export const claimsBackfillQueue = new Queue('claims-backfill', queueOptions);
// Phase 4 T2: embedding backfill — one `batch` job per sweep via a BullMQ v6
// job scheduler, consumed inside the ingestion-worker process (no topology
// change, roadmap Phase 4). Cursor resume via scheduler template re-upsert.
export const embeddingBackfillQueue = new Queue('embedding-backfill', queueOptions);
