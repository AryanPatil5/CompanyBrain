-- ============================================
-- Company Brain: Versioning, Execution Logs & Freshness
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- This is the FINAL migration — no more tables after this.
-- ============================================

-- 1. Add freshness & versioning columns to skills_sops
alter table public.skills_sops
  add column if not exists version integer not null default 1,
  add column if not exists last_confirmed_at timestamptz not null default now(),
  add column if not exists is_stale boolean not null default false;

-- 2. SOP version history (immutable audit trail)
create table if not exists public.sop_versions (
  id              uuid primary key default gen_random_uuid(),
  sop_id          uuid not null references public.skills_sops(id) on delete cascade,
  version_number  integer not null,
  changed_by      text not null default 'system',
  change_reason   text not null default 'initial_extraction',
  snapshot        jsonb not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_sop_versions_sop_id on public.sop_versions(sop_id);

-- 3. Execution logs (MCP agent observability)
create table if not exists public.execution_logs (
  id              uuid primary key default gen_random_uuid(),
  sop_id          uuid references public.skills_sops(id) on delete set null,
  agent_id        text not null default 'unknown',
  tool_name       text not null,
  input_params    jsonb default '{}'::jsonb,
  outcome         text not null default 'success',
  created_at      timestamptz not null default now()
);

create index if not exists idx_execution_logs_sop_id on public.execution_logs(sop_id);
create index if not exists idx_execution_logs_created on public.execution_logs(created_at desc);

-- RLS policies (service role full access)
alter table public.sop_versions enable row level security;
alter table public.execution_logs enable row level security;

create policy "Service role full access on sop_versions"
  on public.sop_versions for all using (true) with check (true);

create policy "Service role full access on execution_logs"
  on public.execution_logs for all using (true) with check (true);
