-- ============================================
-- Company Brain: raw_threads & sop_citations tables
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

-- 1. Raw conversation threads ingested from Slack, Linear, GitHub, etc.
create table if not exists public.raw_threads (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         text not null,
  source               text not null,           -- 'slack', 'linear', 'github'
  external_thread_id   text not null,
  channel_or_project   text not null default 'general',
  raw_content          jsonb not null default '[]'::jsonb,
  is_processed         boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Unique constraint for upsert (onConflict in the ingestion route)
alter table public.raw_threads
  add constraint raw_threads_unique_thread
  unique (workspace_id, source, external_thread_id);

-- 2. Citation links between SOPs and their source threads
create table if not exists public.sop_citations (
  id              uuid primary key default gen_random_uuid(),
  sop_id          uuid not null references public.skills_sops(id) on delete cascade,
  raw_thread_id   uuid not null references public.raw_threads(id) on delete cascade,
  created_at      timestamptz not null default now()
);

-- RLS policies (service role full access)
alter table public.raw_threads enable row level security;
alter table public.sop_citations enable row level security;

create policy "Service role full access on raw_threads"
  on public.raw_threads for all using (true) with check (true);

create policy "Service role full access on sop_citations"
  on public.sop_citations for all using (true) with check (true);
