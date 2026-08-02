-- ============================================
-- Company Brain: Server-Side Webhook Integration Installations
-- Run this in Supabase SQL Editor
-- ============================================

create table if not exists public.integration_installations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  provider text not null, -- 'slack', 'github', 'linear', 'zendesk'
  external_org_id text not null,
  created_at timestamptz not null default now(),
  unique(provider, external_org_id)
);

-- Seed default demo mappings for test environments
insert into public.integration_installations (workspace_id, provider, external_org_id)
values
  ('00000000-0000-0000-0000-000000000000', 'slack', 'T12345678'),
  ('00000000-0000-0000-0000-000000000000', 'github', 'gh-org-123'),
  ('00000000-0000-0000-0000-000000000000', 'linear', 'lin-org-123')
on conflict (provider, external_org_id) do nothing;
