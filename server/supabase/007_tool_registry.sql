-- ============================================
-- Company Brain: Integration Connections Registry Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default '00000000-0000-0000-0000-000000000000',
  integration_name text not null, -- 'stripe', 'github', 'postgres', 'slack', 'admin_cli', 'vault', 'zendesk'
  endpoint_config jsonb default '{}'::jsonb,
  credential_ref text default 'vault-secret-ref',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_integration_connections_workspace on public.integration_connections(workspace_id);
create index if not exists idx_integration_connections_name on public.integration_connections(integration_name);

-- Seed standard default connections
insert into public.integration_connections (workspace_id, integration_name, endpoint_config, credential_ref)
values
  ('00000000-0000-0000-0000-000000000000', 'stripe', '{"base_url": "https://api.stripe.com/v1"}'::jsonb, 'vault:stripe_secret_key'),
  ('00000000-0000-0000-0000-000000000000', 'github', '{"base_url": "https://api.github.com"}'::jsonb, 'vault:github_pat'),
  ('00000000-0000-0000-0000-000000000000', 'postgres', '{"host": "db.internal.net", "port": 5432}'::jsonb, 'vault:db_pass'),
  ('00000000-0000-0000-0000-000000000000', 'slack', '{"channel": "#ops-alerts"}'::jsonb, 'vault:slack_bot_token'),
  ('00000000-0000-0000-0000-000000000000', 'admin_cli', '{"cluster": "prod-us-east-1"}'::jsonb, 'vault:admin_token')
on conflict do nothing;

-- RLS policy (service role full access)
alter table public.integration_connections enable row level security;

create policy "Service role full access on integration_connections"
  on public.integration_connections for all using (true) with check (true);
