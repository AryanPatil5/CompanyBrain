-- ===================================================
-- Company Brain: Idempotency ledger (ADR-T13, pulled forward from Phase 6)
-- Central replay-safety substrate. Webhook dedupe (Phase 2) and agent
-- execution (Phase 6) derive their keys from this table; the unique primary
-- key is the enforcement point — a second acquire() with the same key cannot
-- insert a second row.
--
-- Semantics:
--   key         = caller-derived idempotency key (uuid, or
--                 hash(source + external_id + event_ts) for webhooks)
--   operation   = logical operation name for diagnostics / per-op key spaces
--   status      = pending | completed | failed
--   result_ref  = pointer to the outcome artifact (execution id, queue job id)
--   expires_at  = optional TTL after which a stale pending key may be reaped
--                 (re-acquired) by the caller; NULL = no expiry
-- ===================================================

create table if not exists public.idempotency_keys (
  key text primary key,
  workspace_id text not null default 'system',
  operation text not null,
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed')),
  result_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists idx_idempotency_keys_workspace on public.idempotency_keys(workspace_id);
create index if not exists idx_idempotency_keys_status on public.idempotency_keys(status);

alter table public.idempotency_keys enable row level security;

-- Service role has full access (worker processes write the ledger).
drop policy if exists "Service role full access on idempotency_keys" on public.idempotency_keys;
create policy "Service role full access on idempotency_keys"
  on public.idempotency_keys for all using (true) with check (true);

-- Workspace members can read their own workspace's keys (audit/observability).
drop policy if exists "Workspace read own idempotency keys" on public.idempotency_keys;
create policy "Workspace read own idempotency keys"
  on public.idempotency_keys for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');
