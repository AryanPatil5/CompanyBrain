import { Queue, type QueueOptions } from 'bullmq';
import { redisConnection } from './ingestionQueue.js';
import type { GithubSyncJobData } from '../connectors/github/types.js';

const queueOptions: QueueOptions = {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
};

export const githubSyncQueue = new Queue<GithubSyncJobData>('github-sync', queueOptions);
