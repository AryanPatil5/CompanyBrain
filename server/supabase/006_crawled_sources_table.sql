-- ============================================
-- Company Brain: Deduplication Audit Trail for Historical Crawlers
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

create table if not exists public.crawled_sources (
  id uuid primary key default gen_random_uuid(),
  source text not null,                -- 'slack', 'github', 'linear'
  external_id text not null unique,   -- Slack ts, GitHub issue ID, Linear issue ID
  target text,                        -- Channel ID, Repo name, or Team key
  processed_at timestamptz not null default now()
);

create index if not exists idx_crawled_sources_external on public.crawled_sources(external_id);
create index if not exists idx_crawled_sources_source on public.crawled_sources(source);

-- RLS policy (service role full access)
alter table public.crawled_sources enable row level security;

create policy "Service role full access on crawled_sources"
  on public.crawled_sources for all using (true) with check (true);
