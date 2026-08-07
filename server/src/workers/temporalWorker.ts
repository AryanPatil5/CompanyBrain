import { logger } from '../logger.js';
import * as activities from '../workflows/activities/agentActivities.js';
import {
  checkTemporalConnectivity,
  getProcessStats,
  setProcessStat,
  startHealthServer,
} from '../services/health.js';

export const TEMPORAL_TASK_QUEUE = 'companybrain-agent-queue';

let activeWorker: any = null;

export function isTemporalWorkerRunning(): boolean {
  return activeWorker !== null;
}

/**
 * Initializes and starts the Temporal worker listening on task queue 'companybrain-agent-queue'.
 */
export async function startTemporalWorker(): Promise<any> {
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  const healthPort = parseInt(process.env.TEMPORAL_WORKER_HEALTH_PORT || '5006', 10);
  startHealthServer('temporal-worker', healthPort, {
    checks: {
      temporal: () => checkTemporalConnectivity(temporalAddress),
    },
    details: () => ({
      workerRunning: isTemporalWorkerRunning(),
      namespace,
      taskQueue: TEMPORAL_TASK_QUEUE,
      address: temporalAddress,
      ...getProcessStats('temporal-worker'),
    }),
  });

  try {
    const pkgWorkerName = '@temporalio/worker';
    const workerModule: any = await import(/* template */ pkgWorkerName).catch(() => null);

    if (!workerModule || !workerModule.Worker) {
      logger.warn('[Temporal Worker Warning] @temporalio/worker native package not active. Worker listening in background agent mode.');
      setProcessStat('temporal-worker', 'started', false);
      return null;
    }

    const { Worker, NativeConnection } = workerModule;

    let connection: any;
    try {
      connection = await NativeConnection.connect({ address: temporalAddress });
    } catch {
      logger.warn(`[Temporal Worker Warning] Could not connect to Temporal service at ${temporalAddress}. Skipping background worker.`);
      setProcessStat('temporal-worker', 'started', false);
      return null;
    }

    activeWorker = await Worker.create({
      connection,
      namespace,
      taskQueue: TEMPORAL_TASK_QUEUE,
      workflowsPath: new URL('../workflows/agentWorkflow.js', import.meta.url).pathname,
      activities,
    });

    activeWorker.run().catch((err: any) => {
      logger.warn('[Temporal Worker Warning] Worker execution loop ended:', err);
    });

    setProcessStat('temporal-worker', 'started', true);
    logger.info(`[Temporal Worker] Started listening on task queue "${TEMPORAL_TASK_QUEUE}".`);
    return activeWorker;
  } catch (err: any) {
    logger.warn('[Temporal Worker Warning] Failed to initialize Temporal worker:', err.message);
    setProcessStat('temporal-worker', 'started', false);
    return null;
  }
}

export async function stopTemporalWorker(): Promise<void> {
  if (activeWorker) {
    try {
      activeWorker.shutdown();
      logger.info('[Temporal Worker] Worker shut down gracefully.');
    } catch {}
    activeWorker = null;
  }
}
