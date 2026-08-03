-- ===================================================
-- Company Brain: Integration Credentials Table & RLS
-- Run this in Supabase SQL Editor
-- ===================================================

create table if not exists public.integration_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  provider text not null check (provider in ('slack', 'github', 'gmail', 'zendesk', 'linear', 'database')),
  external_org_id text not null,        -- Slack team_id / GitHub installation_id / Gmail account email
  access_token_encrypted text,          -- Vault secret reference or encrypted token
  refresh_token_encrypted text,         -- Gmail refresh token or OAuth refresh secret
  scopes text[],
  connected_by_user_id uuid references auth.users(id),
  connected_at timestamptz not null default now(),
  status text not null default 'connected' check (status in ('connected', 'revoked', 'error')),
  unique(workspace_id, provider)
);

alter table public.integration_credentials enable row level security;

-- Only admins of the workspace can read/manage credentials — never expose tokens
-- to 'member' or 'approver' roles, and never to other workspaces.
drop policy if exists "Admins can manage their workspace integration credentials" on public.integration_credentials;

create policy "Admins can manage their workspace integration credentials"
  on public.integration_credentials for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
    and current_setting('request.jwt.claims', true)::json->>'role' = 'admin'
  );
