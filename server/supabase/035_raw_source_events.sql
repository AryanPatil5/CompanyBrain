-- ===================================================
-- Company Brain: Phase 2 Task 1 — durable webhook event ledger (ADR-T1, additive)
--
-- Append-only record of every webhook delivery accepted by the ingestion
-- pipeline (Phase 2 roadmap: "persisted raw events"). The row is the source
-- of truth the webhook consumer works from: raw payload, normalized payload,
-- status transitions, and resulting artefacts (thread / SOP) are all tracked
-- here so `GET /api/ingestion/events/:event_id` can report them.
--
-- Dedupe semantics:
--   dedupe_key (unique) = sha256(workspace_id + provider + external_id +
--     event_timestamp), computed by the pipeline from the Phase 1
--     idempotency ledger helpers. A redelivered event hits the unique index
--     and returns the ORIGINAL row (same event_id) instead of a second row.
--   The Phase 1 idempotency_keys ledger additionally guards the consumer,
--   so a delivery that is enqueued twice still extracts exactly once.
--
-- Status transitions: received -> queued -> processing -> completed | failed.
-- The row is immutable apart from status/result columns (ledger semantics).
-- ===================================================

create table if not exists public.raw_source_events (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  workspace_id text not null,
  provider text not null,
  source text not null,
  external_id text not null,
  event_timestamp text,
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_payload jsonb not null default '{}'::jsonb,
  source_trust text not null default 'crawled',
  status text not null default 'received'
    check (status in ('received', 'queued', 'processing', 'completed', 'failed')),
  resulting_thread_id uuid,
  sop_id uuid,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_raw_source_events_workspace on public.raw_source_events(workspace_id);
create index if not exists idx_raw_source_events_status on public.raw_source_events(status);
create index if not exists idx_raw_source_events_created on public.raw_source_events(created_at desc);

alter table public.raw_source_events enable row level security;

-- Service role has full access (routes + workers write the ledger).
drop policy if exists "Service role full access on raw_source_events" on public.raw_source_events;
create policy "Service role full access on raw_source_events"
  on public.raw_source_events for all using (true) with check (true);

-- Workspace members can read their own workspace's events (status polling).
drop policy if exists "Workspace read own raw_source_events" on public.raw_source_events;
create policy "Workspace read own raw_source_events"
  on public.raw_source_events for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');
