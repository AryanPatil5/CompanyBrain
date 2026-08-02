-- ===================================================
-- Company Brain: User Workspace Roles Mapping Table
-- Run this in Supabase SQL Editor
-- ===================================================

create table if not exists public.user_workspace_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id text not null,
  role text not null check (role in ('admin', 'approver', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_workspace_roles enable row level security;

-- Users can read their own workspace role mapping; nothing else.
-- Writes go through service-role only (e.g. user provisioning script), not directly by end users.
drop policy if exists "Users can read their own workspace role" on public.user_workspace_roles;

create policy "Users can read their own workspace role"
  on public.user_workspace_roles for select
  using (user_id = auth.uid());
