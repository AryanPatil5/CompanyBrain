-- ===================================================
-- Company Brain: Platform OAuth Config Table & RLS
-- Run this in Supabase SQL Editor
-- ===================================================

create table if not exists public.platform_oauth_config (
  provider text primary key check (provider in ('slack', 'github', 'gmail')),
  client_id text,
  client_secret_encrypted text,   -- encrypted via encryptSecret()
  extra_config jsonb default '{}', -- e.g. { "app_name": "..." } for GitHub
  configured_by_user_id uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.platform_oauth_config enable row level security;

-- Platform-level config: restrict read access to workspace admins only
drop policy if exists "Admins can view non-secret platform oauth config" on public.platform_oauth_config;

create policy "Admins can view non-secret platform oauth config"
  on public.platform_oauth_config for select
  using (current_setting('request.jwt.claims', true)::json->>'role' = 'admin');
