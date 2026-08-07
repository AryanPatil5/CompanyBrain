// temporal-worker entrypoint — starts only the Temporal durable worker process
import { bootstrap } from '../bootstrap.js';

bootstrap(['temporal-worker']);
