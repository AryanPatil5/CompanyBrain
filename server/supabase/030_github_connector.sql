-- ==========================================================
-- Company Brain: GitHub Connector (Phase 1)
-- Repositories, sync state (resume tokens), and per-document
-- index tracking for the GitHub App connector.
-- Run after 029_foundation_hardening.sql
-- ==========================================================

-- 1. Repositories connected via the GitHub App installation.
create table if not exists public.github_repositories (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  installation_id bigint not null,
  repo_id bigint not null,
  owner text not null,
  name text not null,
  full_name text not null,
  default_branch text,
  is_private boolean not null default false,
  permissions jsonb not null default '{}'::jsonb,
  sync_status text not null default 'idle'
    check (sync_status in ('idle', 'queued', 'syncing', 'done', 'error')),
  last_sync_at timestamptz,
  last_commit_sha text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, repo_id)
);

create index if not exists idx_github_repositories_workspace on public.github_repositories(workspace_id);
create index if not exists idx_github_repositories_installation on public.github_repositories(installation_id);
create index if not exists idx_github_repositories_full_name on public.github_repositories(full_name);

alter table public.github_repositories enable row level security;

drop policy if exists "Tenant isolation policy on github_repositories" on public.github_repositories;
create policy "Tenant isolation policy on github_repositories"
  on public.github_repositories for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 2. Per-repo sync state with resume tokens (initial + incremental).
create table if not exists public.github_sync_state (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  repository_id text not null,
  sync_kind text not null check (sync_kind in ('initial', 'incremental')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'error')),
  resume_token jsonb not null default '{}'::jsonb,
  processed_count integer not null default 0,
  indexed_count integer not null default 0,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, repository_id, sync_kind)
);

create index if not exists idx_github_sync_state_workspace on public.github_sync_state(workspace_id);
create index if not exists idx_github_sync_state_repository on public.github_sync_state(repository_id);

alter table public.github_sync_state enable row level security;

drop policy if exists "Tenant isolation policy on github_sync_state" on public.github_sync_state;
create policy "Tenant isolation policy on github_sync_state"
  on public.github_sync_state for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 3. Per-document index ledger for change detection, incremental sync,
-- and deletion reconciliation.
create table if not exists public.github_indexed_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  repository_id text not null,
  document_type text not null
    check (document_type in ('readme', 'file', 'issue', 'pull_request', 'discussion', 'release', 'wiki')),
  path text not null,
  external_id text not null,
  sha text,
  title text not null,
  url text,
  author text,
  branch text,
  commit_sha text,
  indexed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(repository_id, document_type, path)
);

create index if not exists idx_github_indexed_documents_workspace on public.github_indexed_documents(workspace_id);
create index if not exists idx_github_indexed_documents_repository on public.github_indexed_documents(repository_id);
create index if not exists idx_github_indexed_documents_type on public.github_indexed_documents(document_type);
create index if not exists idx_github_indexed_documents_deleted on public.github_indexed_documents(deleted_at)
  where deleted_at is null;

alter table public.github_indexed_documents enable row level security;

drop policy if exists "Tenant isolation policy on github_indexed_documents" on public.github_indexed_documents;
create policy "Tenant isolation policy on github_indexed_documents"
  on public.github_indexed_documents for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- schema_migrations compatibility note
insert into schema_migrations (version, applied_at, checksum)
values ('030', now(), 'github_connector')
on conflict (version) do nothing;
