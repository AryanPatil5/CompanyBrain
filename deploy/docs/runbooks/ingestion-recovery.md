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
