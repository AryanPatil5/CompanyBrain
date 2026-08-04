import * as activities from '../workflows/activities/agentActivities.js';

let activeWorker: any = null;

/**
 * Initializes and starts the Temporal worker listening on task queue 'companybrain-agent-queue'.
 */
export async function startTemporalWorker(): Promise<any> {
  const temporalAddress = process.env.TEMPORAL_ADDRESS || 'localhost:7233';

  try {
    const pkgWorkerName = '@temporalio/worker';
    const workerModule: any = await import(/* template */ pkgWorkerName).catch(() => null);

    if (!workerModule || !workerModule.Worker) {
      console.warn('[Temporal Worker Warning] @temporalio/worker native package not active. Worker listening in background agent mode.');
      return null;
    }

    const { Worker, NativeConnection } = workerModule;

    let connection: any;
    try {
      connection = await NativeConnection.connect({ address: temporalAddress });
    } catch {
      console.warn(`[Temporal Worker Warning] Could not connect to Temporal service at ${temporalAddress}. Skipping background worker.`);
      return null;
    }

    activeWorker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE || 'default',
      taskQueue: 'companybrain-agent-queue',
      workflowsPath: new URL('../workflows/agentWorkflow.js', import.meta.url).pathname,
      activities,
    });

    activeWorker.run().catch((err: any) => {
      console.warn('[Temporal Worker Warning] Worker execution loop ended:', err);
    });

    console.log('[Temporal Worker] Started listening on task queue "companybrain-agent-queue".');
    return activeWorker;
  } catch (err: any) {
    console.warn('[Temporal Worker Warning] Failed to initialize Temporal worker:', err.message);
    return null;
  }
}

export async function stopTemporalWorker(): Promise<void> {
  if (activeWorker) {
    try {
      activeWorker.shutdown();
      console.log('[Temporal Worker] Worker shut down gracefully.');
    } catch {}
    activeWorker = null;
  }
}
