// ingestion-worker entrypoint — starts only the BullMQ ingestion worker process
import { bootstrap } from '../bootstrap.js';

bootstrap(['ingestion-worker']);
