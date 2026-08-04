-- ==========================================================
-- Company Brain: Apache AGE Graph Extension & Schema Initialization
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

-- 1. Enable Apache AGE extension if available
create extension if not exists age;

-- Set search_path to include ag_catalog
set search_path = ag_catalog, "$user", public;

-- 2. Initialize Graph Namespace "company_knowledge_graph"
do $$
begin
  if not exists (select 1 from ag_catalog.ag_graph where name = 'company_knowledge_graph') then
    perform ag_catalog.create_graph('company_knowledge_graph');
  end if;
exception
  when undefined_function then
    -- Extension age not installed in standard postgres instance; create relational fallback tables below
    null;
end $$;

-- 3. Relational Fallback Tables for Apache AGE Nodes & Edges (for non-AGE postgres runtime)
create table if not exists public.graph_nodes (
  id text primary key,
  label text not null check (label in ('Person', 'System', 'SOP', 'Rule', 'Step', 'Entity', 'Policy', 'Team', 'Role')),
  name text not null,
  properties jsonb not null default '{}'::jsonb,
  workspace_id text,
  allowed_roles text[] not null default array['admin', 'member'],
  source_document_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.graph_edges (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.graph_nodes(id) on delete cascade,
  target_id text not null references public.graph_nodes(id) on delete cascade,
  edge_type text not null check (edge_type in ('OWNS', 'REQUIRES', 'MODIFIES', 'DEPENDS_ON', 'EXECUTES', 'HAS_STEP', 'REQUIRES_ROLE', 'TARGETS_SYSTEM', 'SUPERSEDES', 'GOVERNED_BY')),
  properties jsonb not null default '{}'::jsonb,
  workspace_id text,
  allowed_roles text[] not null default array['admin', 'member'],
  source_document_id text,
  created_at timestamptz not null default now(),
  constraint unique_graph_edge unique (source_id, target_id, edge_type)
);

create index if not exists idx_graph_nodes_label on public.graph_nodes(label);
create index if not exists idx_graph_edges_source on public.graph_edges(source_id);
create index if not exists idx_graph_edges_target on public.graph_edges(target_id);

alter table public.graph_nodes enable row level security;
alter table public.graph_edges enable row level security;

create policy "Service role full access on graph_nodes"
  on public.graph_nodes for all using (true) with check (true);

create policy "Service role full access on graph_edges"
  on public.graph_edges for all using (true) with check (true);
