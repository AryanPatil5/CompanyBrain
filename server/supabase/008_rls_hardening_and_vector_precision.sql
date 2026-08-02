-- ============================================
-- Company Brain: RLS Hardening & Vector Similarity Precision
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

-- 1. Update match_sops_by_embedding RPC Function to default match_threshold = 0.75
create or replace function match_sops_by_embedding(
  query_embedding vector(1536),
  filter_workspace_id text default null,
  match_threshold float default 0.75,
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
    and (1 - (s.embedding <=> query_embedding)) >= match_threshold
  order by s.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 2. Harden RLS Policies with Tenant Isolation Check
drop policy if exists "Service role full access on skills_sops" on public.skills_sops;
drop policy if exists "Workspace tenant isolation policy on skills_sops" on public.skills_sops;

create policy "Workspace tenant isolation policy on skills_sops"
  on public.skills_sops
  for all
  using (
    workspace_id is null or
    workspace_id = '00000000-0000-0000-0000-000000000000' or
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id is null or
    workspace_id = '00000000-0000-0000-0000-000000000000' or
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

drop policy if exists "Service role full access on raw_threads" on public.raw_threads;
drop policy if exists "Workspace tenant isolation policy on raw_threads" on public.raw_threads;

create policy "Workspace tenant isolation policy on raw_threads"
  on public.raw_threads
  for all
  using (
    workspace_id = '00000000-0000-0000-0000-000000000000' or
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = '00000000-0000-0000-0000-000000000000' or
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );
