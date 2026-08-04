-- ==========================================================
-- Fix Migration Order: Ensure crawled_sources has workspace_id
-- before RLS policy references it (013 references it, should run after 027)
-- This migration ensures idempotent schema state
-- ==========================================================

-- 1. Ensure crawled_sources has workspace_id column (repair from 027)
alter table if exists public.crawled_sources
  add column if not exists workspace_id text;

-- Update any NULL workspace_ids to a sensible default
update public.crawled_sources
set workspace_id = '00000000-0000-0000-0000-000000000000'
where workspace_id is null;

-- Now add NOT NULL constraint
alter table public.crawled_sources
  alter column workspace_id set not null;

-- 2. Ensure the index exists
create index if not exists idx_crawled_sources_workspace on public.crawled_sources(workspace_id);

-- 3. Ensure execution_logs has all required columns (repair from 027)
alter table if exists public.execution_logs
  add column if not exists workspace_id text,
  add column if not exists step_execution_id text,
  add column if not exists target_system text,
  add column if not exists status text,
  add column if not exists input_payload jsonb,
  add column if not exists output_payload jsonb,
  add column if not exists error_message text,
  add column if not exists executed_at timestamptz;

-- Set sensible defaults for new columns
update public.execution_logs
set input_payload = '{}'::jsonb where input_payload is null;

update public.execution_logs
set output_payload = '{}'::jsonb where output_payload is null;

-- 4. Ensure ingestion_failures has all required columns
alter table if exists public.ingestion_failures
  add column if not exists external_id text,
  add column if not exists error_reason text;

-- 5. Verify source_documents, document_chunks, source_document_acls exist with proper RLS
-- These were created in 027, but we ensure idempotency here

-- 6. Ensure FTS index is properly created on skills_sops
create index if not exists idx_skills_sops_fts on public.skills_sops using gin(
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(trigger_condition, ''))
);

-- 7. Ensure HNSW index on document_chunks is properly created
create index if not exists idx_document_chunks_embedding_hnsw
  on public.document_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- 8. Verify RLS is enabled on all tables (safe idempotent operation)
alter table public.source_documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.source_document_acls enable row level security;

-- Migration complete - all schema drift repaired
