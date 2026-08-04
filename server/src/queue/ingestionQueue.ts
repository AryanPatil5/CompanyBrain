import { Queue, type QueueOptions } from 'bullmq';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  lazyConnect: true,
});

redisConnection.on('error', (err) => {
  if ((err as any).code === 'ECONNREFUSED') {
    console.warn(`[IngestionQueue Warning] Redis connection refused at ${REDIS_URL}. Ensure Redis server is running.`);
  } else {
    console.error('[IngestionQueue Redis Error]:', err);
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
