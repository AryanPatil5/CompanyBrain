-- ==========================================================
-- Company Brain: Relational Knowledge Graph Schema
-- (Apache AGE removed in Phase 0 Task 3 — see 030_retire_apache_age.sql)
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

-- Relational Graph Tables (system of record; ADR-T4)
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
