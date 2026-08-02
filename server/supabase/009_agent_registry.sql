-- ============================================
-- Company Brain: FastMCP Agent Token Registry & Session Binding
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

create table if not exists public.agent_registry (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  agent_id text not null,
  workspace_id text not null default '00000000-0000-0000-0000-000000000000',
  trust_role text not null default 'low_trust', -- 'low_trust', 'high_trust', 'admin'
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_registry_token on public.agent_registry(token);

-- Seed standard token records for test agents and admin workers
insert into public.agent_registry (token, agent_id, workspace_id, trust_role)
values
  ('mcp-admin-key-99', 'admin-worker-01', '00000000-0000-0000-0000-000000000000', 'admin'),
  ('mcp-lowtrust-key-01', 'subagent-lowtrust', '00000000-0000-0000-0000-000000000000', 'low_trust'),
  ('mcp-hightrust-key-02', 'trusted-runner-02', '00000000-0000-0000-0000-000000000000', 'high_trust')
on conflict (token) do nothing;

-- RLS policy (service role full access)
alter table public.agent_registry enable row level security;

create policy "Service role full access on agent_registry"
  on public.agent_registry for all using (true) with check (true);
