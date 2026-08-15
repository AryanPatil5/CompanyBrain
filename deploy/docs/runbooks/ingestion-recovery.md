# Operations Runbook

Phase 3 ingestion + recovery procedures. Commands assume `server/.env` is
configured (Supabase service role, Redis via `docker compose up -d`).

## 1. Apply migrations (deploy-time)

```bash
npm run migrate --prefix server
```

The runner (`server/src/db/migrator.ts`, ADR-T1) applies new files in filename
order, owns the `schema_migrations` ledger, and refuses checksum-differing
re-applies. On cloud Supabase, migrations that cannot be run by the runner must
be applied via the SQL Editor (same files).

## 2. Verify health after deploy

```bash
curl -s localhost:5001/health          # API
curl -s localhost:5004/health          # ingestion-worker (redis + supabase deps)
curl -s localhost:5002/health          # crawler
```

Every process serves structured JSON and answers 200 while alive; dependencies
fail individually (`ok`/`unavailable`), never crash the process.

## 3. Re-upload recovery (Phase 3 N4)

A failed document row blocks re-upload with a unique violation? It no longer
does: re-uploading the same content returns `202` with the existing
`document_id` and `"deduplicated": true`, which re-enqueues `parse_document`.
The worker short-circuits content already at `extraction_stage=completed`
(content-hash check) and re-runs from the recorded stage otherwise.

Manual nudge if the queue is down:

```bash
# find the stuck row
psql ... -c "select id, workspace_id, extraction_stage, content_hash from source_documents where extraction_stage='failed';"
```

Re-enqueue via a duplicate upload (route 202) or the DLQ replay below.

## 4. DLQ replay

Failed jobs land in `ingestion-dlq`, `webhook-ingestion-dlq`,
`document-ingestion-dlq` after 3 attempts. Replay (requires a node script or
BullMQ REPL):

```ts
// scripts/replay-dlq.mjs (from server/)
import { Queue } from 'bullmq';
const q = new Queue('document-ingestion-dlq', { connection: { host: 'localhost', port: 6379 } });
const jobs = await q.getJobs(['failed']);
for (const j of jobs) await q.add(j.name, j.data);
await q.close();
```

For webhook events, prefer the stale-event sweep: events stranded in
`received`/`processing` are re-claimed automatically
(`WEBHOOK_STALE_EVENT_TIMEOUT_MS`, default 60s).

## 5. Verify a thread ingested claims (Phase 3)

```bash
# after a webhook/crawl, the thread must have produced grounding:
curl -s localhost:5001/api/sops/<sop-id>/claims -H "Authorization: Bearer <token>"
# -> {"sop_id":..., "count": N, "claims":[{...evidence...}]}

# direct check: source documents + claims rows for a workspace
psql ... -c "select source_document_id, count(*) from knowledge_claims where workspace_id='...' group by 1;"
```

## 6. Abort / revert

- Migration rollback is NOT supported by the runner (additive only). To revert,
  apply the inverse DDL manually via SQL Editor, then delete the row from
  `schema_migrations`.
- Feature flags gate new behavior: `CRAWLER_V2` (connector registry),
  `RETRIEVAL_V2` (Phase 4 search flip). Flip to `false` to restore legacy paths.

## 7. Embedding backfill (Phase 4 T2)

Runs inside the ingestion-worker process, no topology change. Health shows the
sweep state:

```bash
curl -s localhost:5004/health
# -> dependencies OK; details.embeddingBackfillLastBatch = {scanned, reembedded,
#    failed, permanentFailures, concurrentModifications, nextCursor, ...}
```

Observed behavior worth knowing:

- `nextCursor` persists into the BullMQ scheduler template after each sweep
  (Redis) — restarts resume at the cursor. A stale/missing cursor is safe:
  sweeps re-scan and skip chunks that are already current (zero provider
  calls, spec "skip-when-current").
- Per-chunk provider failures are isolated and counted honestly in the batch
  result. Retryable failures are re-attempted on the next sweep
  (`EMBEDDING_BACKFILL_INTERVAL_MS`, default 60s). Permanent failures
  (dimension mismatch, config errors, malformed responses) quarantine the
  chunk in-process until the worker restarts — restart clears the quarantine
  and the chunk is re-attempted once.
- `concurrentModifications` means ingestion wrote the chunk while the backfill
  was embedding it. The backfill NEVER overwrites a newer state: the
  conditional update (WHERE id + workspace + content + content_hash) misses
  and the newer row wins untouched.
- No DLQ: scan-level DB errors retry via the queue's default 3 attempts;
  per-chunk failures never poison the job.
- Cost accounting: a per-workspace `recordUsage` row (provider/model recorded,
  cost CENTS 0 — token counts are not known for embedding calls and are never
  fabricated).

Debug one-off sweep (beyond env defaults, e.g. force re-embed everything):

```bash
# manual job with force=true -> re-embeds ALL chunks this cycle
# (queue: embedding-backfill, scheduler id: embedding-backfill-batch)
redis-cli ...   # or a BullMQ REPL/add from a node script:
#   embeddingBackfillQueue.add('batch', {job_name:'batch', cursor:null, force:true})
```

To slow or stop the sweep: raise `EMBEDDING_BACKFILL_INTERVAL_MS` (min 10s)
or delete the scheduler (`embeddingBackfillQueue.removeJobScheduler('embedding-backfill-batch')`).
