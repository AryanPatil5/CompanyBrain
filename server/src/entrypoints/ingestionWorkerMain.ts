import dotenv from 'dotenv';
import { startIngestionWorker, stopIngestionWorker } from '../workers/ingestionWorker.js';
import { startTemporalWorker, stopTemporalWorker } from '../workers/temporalWorker.js';

dotenv.config();

startIngestionWorker();
startTemporalWorker();

const shutdown = async () => {
  console.log('[INFO] Gracefully shutting down Ingestion/Temporal workers...');
  await stopIngestionWorker();
  await stopTemporalWorker();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
