-- ============================================
-- Company Brain: Remove Hardcoded RLS Bypass
-- Run this in Supabase SQL Editor
-- ============================================

drop policy if exists "Workspace tenant isolation policy on skills_sops" on public.skills_sops;

create policy "Workspace tenant isolation policy on skills_sops"
  on public.skills_sops
  for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

drop policy if exists "Workspace tenant isolation policy on raw_threads" on public.raw_threads;

create policy "Workspace tenant isolation policy on raw_threads"
  on public.raw_threads
  for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );
