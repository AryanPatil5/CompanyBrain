-- ==========================================================
-- Company Brain: Webhook Subscriptions & Incremental Sync Table
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

create table if not exists public.webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null default '00000000-0000-0000-0000-000000000000',
  provider text not null check (provider in ('github', 'slack', 'linear', 'zendesk')),
  webhook_secret text not null,
  last_delivery_token text,
  last_event_timestamp timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint unique_provider_workspace unique (workspace_id, provider)
);

alter table public.webhook_subscriptions enable row level security;

create policy "Service role full access on webhook_subscriptions"
  on public.webhook_subscriptions for all using (true) with check (true);
