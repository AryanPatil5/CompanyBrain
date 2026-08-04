-- ============================================
-- Company Brain: skills_sops table
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

create table if not exists public.skills_sops (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  text,
  title         text not null,
  category      text not null default 'Engineering',
  status        text not null default 'Draft',
  trigger_condition  text,
  preconditions      text,
  summary       text,
  execution_steps    jsonb not null default '[]'::jsonb,
  sop_ast            jsonb,
  source_doc_id      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Allow the service role full access (RLS off for server-side usage)
alter table public.skills_sops enable row level security;

create policy "Service role has full access"
  on public.skills_sops
  for all
  using (true)
  with check (true);

-- Optional: seed one sample SOP so the frontend shows live data immediately
insert into public.skills_sops (title, category, status, trigger_condition, summary, execution_steps)
values (
  'Enterprise VIP Rate Limit Override Protocol',
  'Engineering',
  'Draft',
  'customer.tier == ''enterprise'' AND api_429_count > 25 within 10m',
  'Temporarily elevates API quota for enterprise tenants experiencing throttling during peak load windows.',
  '[
    {"action": "Confirm the tenant''s contract tier and current burst allowance in the accounts table.", "target_system": "Postgres"},
    {"action": "Raise the tenant rate-limit bucket to 3x baseline with a 4 hour expiry token.", "target_system": "Admin CLI"},
    {"action": "Annotate the subscription record so overage is not auto-billed for the override window.", "target_system": "Stripe"},
    {"action": "Post an override summary to #enterprise-ops and open a follow-up capacity ticket.", "target_system": "Slack"}
  ]'::jsonb
);
