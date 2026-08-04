-- ==========================================================
-- Company Brain: Temporal Validity & Time-Decay Graph Schema Migration
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

alter table public.graph_edges
  add column if not exists valid_from timestamptz not null default now(),
  add column if not exists valid_until timestamptz default null;

create index if not exists idx_graph_edges_validity on public.graph_edges(valid_from, valid_until);
