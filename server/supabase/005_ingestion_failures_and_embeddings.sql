-- ============================================
-- Company Brain: Ingestion Failures Audit & pgvector Semantic Conflict Detection
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

-- 1. Ingestion Failures Audit Table
create table if not exists public.ingestion_failures (
  id uuid primary key default gen_random_uuid(),
  workspace_id text,
  source text not null default 'unknown',
  raw_content text not null,
  error_message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_ingestion_failures_created on public.ingestion_failures(created_at desc);

-- 2. Enable pgvector extension (if available in database)
create extension if not exists vector;

-- 3. Add embedding vector column to skills_sops
alter table public.skills_sops
  add column if not exists embedding vector(1536);

-- 4. Match SOPs by Embedding RPC Function
create or replace function match_sops_by_embedding(
  query_embedding vector(1536),
  filter_workspace_id text default null,
  match_threshold float default 0.1,
  match_count int default 5
)
returns table (
  id uuid,
  title text,
  trigger_condition text,
  category text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    s.id,
    s.title,
    s.trigger_condition,
    s.category,
    (1 - (s.embedding <=> query_embedding))::float as similarity
  from public.skills_sops s
  where (s.workspace_id = filter_workspace_id or filter_workspace_id is null or s.workspace_id is null)
    and s.embedding is not null
    and (1 - (s.embedding <=> query_embedding)) > match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- RLS policies
alter table public.ingestion_failures enable row level security;

create policy "Service role full access on ingestion_failures"
  on public.ingestion_failures for all using (true) with check (true);
