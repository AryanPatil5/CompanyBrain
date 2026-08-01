-- ============================================
-- Company Brain: Enterprise Guardrails, Risk Tiering & Real-Time Approval Gates
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- ============================================

-- 1. Add risk level & execution policy columns to skills_sops
alter table public.skills_sops
  add column if not exists risk_level text not null default 'Low', -- 'Low', 'Medium', 'High', 'Critical'
  add column if not exists requires_human_gate boolean not null default false,
  add column if not exists trust_role_required text not null default 'low_trust'; -- 'low_trust', 'high_trust', 'admin'

-- 2. Pending Agent Execution Approvals (Real-time Human Gating)
create table if not exists public.pending_approvals (
  id              uuid primary key default gen_random_uuid(),
  sop_id          uuid not null references public.skills_sops(id) on delete cascade,
  agent_id        text not null default 'unknown-agent',
  requested_by    text not null default 'mcp-agent',
  risk_level      text not null default 'High',
  status          text not null default 'pending', -- 'pending', 'approved', 'rejected'
  reason          text,
  execution_context jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

create index if not exists idx_pending_approvals_status on public.pending_approvals(status);
create index if not exists idx_pending_approvals_sop_id on public.pending_approvals(sop_id);

-- RLS policies
alter table public.pending_approvals enable row level security;

create policy "Service role full access on pending_approvals"
  on public.pending_approvals for all using (true) with check (true);
