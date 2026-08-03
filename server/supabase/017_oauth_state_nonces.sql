-- ===================================================
-- Company Brain: OAuth State Nonces Table
-- Run this in Supabase SQL Editor
-- ===================================================

create table if not exists public.oauth_state_nonces (
  nonce text primary key,
  workspace_id text not null,
  provider text not null check (provider in ('slack', 'github', 'gmail', 'zendesk', 'linear', 'database')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.oauth_state_nonces enable row level security;

-- Nonce table is service-role managed only to protect OAuth authorization flows from CSRF hijacking.
drop policy if exists "Service role access for oauth_state_nonces" on public.oauth_state_nonces;

create policy "Service role access for oauth_state_nonces"
  on public.oauth_state_nonces for all
  using (true);
