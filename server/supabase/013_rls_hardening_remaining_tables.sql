-- ============================================
-- Company Brain: RLS Hardening for Remaining Tables
-- Run this in Supabase SQL Editor
-- ============================================

-- 1. Enable RLS and add tenant-scoped policies for sop_versions
alter table public.sop_versions enable row level security;
drop policy if exists "Service role full access on sop_versions" on public.sop_versions;
drop policy if exists "Tenant isolation policy on sop_versions" on public.sop_versions;

create policy "Tenant isolation policy on sop_versions"
  on public.sop_versions for all
  using (
    sop_id in (
      select id from public.skills_sops
      where workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
    )
  );

-- 2. Enable RLS and add tenant-scoped policies for pending_approvals
alter table public.pending_approvals enable row level security;
drop policy if exists "Service role full access on pending_approvals" on public.pending_approvals;
drop policy if exists "Tenant isolation policy on pending_approvals" on public.pending_approvals;

create policy "Tenant isolation policy on pending_approvals"
  on public.pending_approvals for all
  using (
    sop_id in (
      select id from public.skills_sops
      where workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
    )
  );

-- 3. Enable RLS and add tenant-scoped policies for execution_logs
alter table public.execution_logs enable row level security;
drop policy if exists "Service role full access on execution_logs" on public.execution_logs;
drop policy if exists "Tenant isolation policy on execution_logs" on public.execution_logs;

create policy "Tenant isolation policy on execution_logs"
  on public.execution_logs for all
  using (
    sop_id is null or
    sop_id in (
      select id from public.skills_sops
      where workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
    )
  );

-- 4. Enable RLS and add tenant-scoped policies for crawled_sources and ingestion_failures
alter table public.crawled_sources enable row level security;
drop policy if exists "Service role full access on crawled_sources" on public.crawled_sources;
drop policy if exists "Tenant isolation policy on crawled_sources" on public.crawled_sources;

create policy "Tenant isolation policy on crawled_sources"
  on public.crawled_sources for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

alter table public.ingestion_failures enable row level security;
drop policy if exists "Service role full access on ingestion_failures" on public.ingestion_failures;
drop policy if exists "Tenant isolation policy on ingestion_failures" on public.ingestion_failures;

create policy "Tenant isolation policy on ingestion_failures"
  on public.ingestion_failures for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 5. Restrict system/secret tables (agent_registry, integration_connections) to service-role access only
drop policy if exists "Service role full access on agent_registry" on public.agent_registry;
drop policy if exists "Service role full access on integration_connections" on public.integration_connections;
