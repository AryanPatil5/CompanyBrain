# Phase 2 Task 1 — Webhook Durability Pipeline (Implementation Report)

**Status:** Complete · **Scope:** Webhook durability slice of Phase 2 only (connector framework, attachments, crawler refactor, source-ACL capture are later Phase 2 tasks and were NOT touched).

## Root cause being fixed

The Phase 2 roadmap (MASTER_ROADMAP.md lines ~265+) calls the pre-Task-1 webhook path *"fire-and-forget"*: webhook routes normalized a payload, ran the full LLM extraction pipeline **synchronously inside the HTTP request**, and *"webhooks that currently dequeue are never consumed"* (the `webhook-ingestion` BullMQ queue existed but had **no worker**). Consequences:

1. A provider redelivery (or a dropped request) re-ran extraction → duplicate SOPs/threads; nothing deduplicated deliveries.
2. The raw payload was never persisted — no audit trail, no `event_id` to reconcile deliveries against.
3. An LLM/extraction failure aborted the webhook request itself (422/500), and a stalled request held the provider's webhook for seconds.

## What was built

### New durable event ledger — `server/supabase/035_raw_source_events.sql`
- `raw_source_events`: append-only ledger row per accepted delivery (raw + normalized payload, source, external_id, event timestamp, `status` state machine `received → queued → processing → completed | failed`, resulting thread/SOP ids, error message, timestamps).
- `dedupe_key text NOT NULL UNIQUE` — the enforcement point for at-least-once → exactly-once recording: a redelivery returns the original row instead of a second entry.
- Indexes (workspace, status, created_at desc) + RLS mirroring 024/034 (service-role full access; workspace members read their own rows).

### Pipeline — `server/src/ingestion/webhookPipeline.ts`
- `ingestWebhookEvent()` (route-side, ~0 LLM work): ledger pre-check → `persistRawSourceEvent` → best-effort enqueue on the **existing** `webhook-ingestion` queue → immediate `202 {event_id, status}`.
  - **Redelivery semantics:** same dedupe key + already queued/terminal → `status: "duplicate"`, same `event_id`, **no re-enqueue**; same key but previous enqueue never landed (`status: "received"`) → the redelivery IS the retry and re-enqueues (recovery path).
  - **Queue-down tolerance:** enqueue failure never fails the webhook — the event stays `received` and a provider redelivery (at-least-once) retries it.
- `processWebhookEventJob()` (consumer-side, runs in `webhookEventWorker`): exactly-once via **two** layers — the Phase 1 idempotency ledger (`webhook_extract`, workspace-scoped key, TTL 5min, fail-open) plus the event row status (terminal rows are skipped on job retries/redeliveries). Marks `processing` → runs `processThreadCore` → `completed` (with thread/SOP ids) or `failed` (with error message) → rethrows for BullMQ retry (attempts: 3, exponential backoff), DLQ after exhaustion.

### Worker — `server/src/workers/ingestionWorker.ts`
- `createWebhookEventWorker()` consumes `webhook-ingestion` (concurrency 3) inside the existing `ingestion-worker` process (started by `startIngestionWorker`, no bootstrap changes). Mirrors the crawler worker's audit logging (`execution_logs`), `webhook-ingestion-dlq` DLQ, and health reporting.

### Extracted thread core — `server/src/services/ingestion/webhookService.ts`
- `processThreadCore()` — the old `routes/ingestion.ts` `processThread()` body (raw_thread upsert → source document + chunks → LLM SOP extraction → conflict detection → embedding → SOP insert) moved out of the HTTP layer verbatim (behavior-preserving; `source_doc_id` now prefers the persisted source document id, matching the old route). Routes must not call it synchronously — worker only.
- `deriveWebhookDedupeKey()` — sha256 of workspace + provider + external_id + event timestamp (roadmap key spec); falls back to a raw-payload content hash when the provider exposes no event timestamp.
- `extractWebhookEventTimestamp()` — provider-specific timestamp extraction (Slack `event.ts`, GitHub `comment.created_at`/issue timestamps, Linear `data.createdAt`).
- `persistRawSourceEvent()` — pre-select + insert with race-safe unique-violation refetch (never clobbers a completed row), refetch by dedupe key.
- `updateEventStatus()` — best-effort status writes (never throw).

### Routes — `server/src/routes/ingestion.ts`
- All seven webhook routes (`/webhook`, `/webhook/{github,linear,zendesk,email,database,teach}`) now: persist → enqueue → **202 `{success, event_id, status, message}`** (was synchronous 200/201/422/500 processing).
- `GET /api/ingestion/events/:event_id` (authenticated, workspace-scoped — cross-workspace ids 404) returns the ledger row (status, provider, external_id, timestamps, resulting thread/SOP ids, error).
- `/run`, `/jobs/:jobId`, `/interview` untouched; signature/workspace middleware chains untouched (Slack `url_verification` still passes through `verifySlackSignature`).

## Files changed / created
- **New:** `server/supabase/035_raw_source_events.sql`, `server/src/ingestion/webhookPipeline.ts`, `server/test/connectors/webhookDurability.test.ts`
- **Modified:** `server/src/services/ingestion/webhookService.ts` (extraction core + persistence helpers), `server/src/routes/ingestion.ts` (202 semantics + events endpoint), `server/src/workers/ingestionWorker.ts` (webhook worker + DLQ), `server/test/harness/fakeSupabase.ts` (auto-generate row ids on insert/upsert to mirror `gen_random_uuid()`), `server/test/run-all.ts` (53rd suite), `README.md` (event semantics + status endpoint docs), `AGENTS.md` (webhook durability overview)

## Verification results
- `npx tsc --noEmit` clean; `npm run build` clean; `npm run lint` clean (server + client untouched by lint issues).
- **`npm test`: 53/53 suites pass, 0 failed (12.4s)** — new `connectors/webhookDurability` suite (30 checks) covers: dedupe-key determinism/sensitivity/workspace scoping/content-hash fallback; provider timestamp extraction; persistence + replay (same row, no second row, new-ts → new event); accept semantics (fresh/duplicate/new-ts/received-recovery); consumer exactly-once (terminal status, exactly one raw thread across the full cycle, skip-on-reprocess, duplicate-on-redelivery, ledger terminal); unknown event → `not_found`; route-level 202 + status endpoint + 404s + cross-workspace isolation + 400 on missing `team_id`.
- **Migration verified on ephemeral Postgres 16 (pgvector image):** clean apply = 32 (incl. `035_raw_source_events.sql`), re-run = `0 applied, 32 already applied`, `status` = 32/32 up-to-date; ledger checksum recorded; `\d` confirms table, unique dedupe_key, check constraint, indexes, RLS policies. Container removed afterwards.
- Harness additions are hermetic: no live Redis/Postgres/Supabase/LLM/network (the suite stubs the enqueue so queue transport artifacts cannot stall it; the pipeline's queue-down path is asserted via status semantics).

## Design decisions & remaining limitations
- **Ledger is the source of truth, idempotency ledger is the guard:** the unique `dedupe_key` is the hard exactly-once boundary; the Phase 1 ledger is fail-open by design (a ledger outage must not block extraction).
- **At-least-once delivery is preserved:** `received` rows are re-enqueued by the next redelivery; consumers are exactly-once regardless of how many times a delivery is enqueued.
- **`failed` events are acknowledged as duplicates on redelivery** (no infinite reprocessing loop; the DLQ + `error_message` record them for manual review).
- Known accepted harness quirk: importing the queue module before `installHarness()` can stall `Queue.add` when a developer's local docker Redis is reachable; the suite stubs the enqueue (fire-and-forget real call) and the pipeline tolerates queue failure by design.
- Not in scope (later Phase 2 tasks): connector contract/registry, sync cursor store, attachments, crawler refactor, source-ACL capture.
