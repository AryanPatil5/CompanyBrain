-- ==========================================================
-- Company Brain: Source Documents, ACL-Aware Chunks & Schema Repairs
-- Run this after 026_temporal_graph_schema.sql
-- ==========================================================

create extension if not exists vector;

-- 1. Immutable source object ledger. Every connector payload should land here
-- before extraction so claims, SOPs, and chunks have durable provenance.
create table if not exists public.source_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source text not null,
  source_key text not null,
  external_id text not null,
  title text not null,
  uri text,
  content_hash text not null,
  raw_thread_id uuid references public.raw_threads(id) on delete set null,
  raw_metadata jsonb not null default '{}'::jsonb,
  allowed_roles text[] not null default array['admin', 'member'],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, source, external_id)
);

create index if not exists idx_source_documents_workspace on public.source_documents(workspace_id);
create index if not exists idx_source_documents_source_key on public.source_documents(source_key);
create index if not exists idx_source_documents_raw_thread on public.source_documents(raw_thread_id);

alter table public.source_documents enable row level security;

drop policy if exists "Tenant isolation policy on source_documents" on public.source_documents;
create policy "Tenant isolation policy on source_documents"
  on public.source_documents for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 2. ACL-aware semantic chunk table. This is the table referenced by the
-- DLAC HNSW search function but missing from earlier migrations.
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_document_id text not null,
  chunk_index integer not null,
  content text not null,
  content_hash text not null,
  token_count_estimate integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  allowed_roles text[] not null default array['admin', 'member'],
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_document_id, chunk_index)
);

create index if not exists idx_document_chunks_workspace on public.document_chunks(workspace_id);
create index if not exists idx_document_chunks_source_doc on public.document_chunks(source_document_id);
create index if not exists idx_document_chunks_metadata on public.document_chunks using gin(metadata);
create index if not exists idx_document_chunks_embedding_hnsw
  on public.document_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.document_chunks enable row level security;

drop policy if exists "Tenant isolation policy on document_chunks" on public.document_chunks;
create policy "Tenant isolation policy on document_chunks"
  on public.document_chunks for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 3. Source ACL mirror. This gives future OpenFGA sync a real source-of-truth.
create table if not exists public.source_document_acls (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_document_id text not null,
  principal_type text not null check (principal_type in ('user', 'group', 'role', 'workspace')),
  principal_id text not null,
  permission text not null check (permission in ('owner', 'editor', 'viewer', 'read')),
  inherited boolean not null default false,
  raw_acl jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(source_document_id, principal_type, principal_id, permission)
);

create index if not exists idx_source_document_acls_workspace on public.source_document_acls(workspace_id);
create index if not exists idx_source_document_acls_source_doc on public.source_document_acls(source_document_id);
create index if not exists idx_source_document_acls_principal on public.source_document_acls(principal_type, principal_id);

alter table public.source_document_acls enable row level security;

drop policy if exists "Tenant isolation policy on source_document_acls" on public.source_document_acls;
create policy "Tenant isolation policy on source_document_acls"
  on public.source_document_acls for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 4. Repair earlier schema drift.
alter table public.crawled_sources
  add column if not exists workspace_id text not null default '00000000-0000-0000-0000-000000000000';

create index if not exists idx_crawled_sources_workspace on public.crawled_sources(workspace_id);

alter table public.execution_logs
  add column if not exists workspace_id text,
  add column if not exists step_execution_id text,
  add column if not exists target_system text,
  add column if not exists status text,
  add column if not exists input_payload jsonb default '{}'::jsonb,
  add column if not exists output_payload jsonb default '{}'::jsonb,
  add column if not exists error_message text,
  add column if not exists executed_at timestamptz;

alter table public.ingestion_failures
  add column if not exists external_id text,
  add column if not exists error_reason text;

create table if not exists public.tool_registry (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  tool_name text not null,
  description text,
  parameters jsonb not null default '{}'::jsonb,
  target_system text not null,
  endpoint_config jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id, tool_name)
);

create index if not exists idx_tool_registry_workspace on public.tool_registry(workspace_id);
alter table public.tool_registry enable row level security;

drop policy if exists "Tenant isolation policy on tool_registry" on public.tool_registry;
create policy "Tenant isolation policy on tool_registry"
  on public.tool_registry for all
  using (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  )
  with check (
    workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id'
  );

-- 5. Correct DLAC vector search. Important: allowed_doc_ids = '{}' must
-- deny all document-specific chunks. Only NULL means unrestricted admin access.
create or replace function public.dlac_hnsw_vector_search(
  query_embedding vector(1536),
  workspace_id_filter text,
  allowed_doc_ids text[] default null,
  match_threshold float default 0.3,
  match_count int default 10
)
returns table (
  id uuid,
  document_id text,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
security definer
as $$
begin
  return query
  select
    d.id,
    d.source_document_id as document_id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.document_chunks d
  where d.workspace_id = workspace_id_filter
    and d.embedding is not null
    and (1 - (d.embedding <=> query_embedding)) > match_threshold
    and (
      allowed_doc_ids is null
      or d.source_document_id = any(allowed_doc_ids)
    )
  order by d.embedding <=> query_embedding
  limit match_count;
end;
$$;

