// claims-backfill-worker entrypoint — starts only the knowledge-claims
// backfill worker process (Phase 3, ADR-T15 backfill-worker step).
import { bootstrap } from '../bootstrap.js';

bootstrap(['claims-backfill-worker']);