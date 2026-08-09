-- ===================================================
-- Company Brain: Phase 1 schema alignment (ADR-T1, additive)
-- Closes the Phase 0 acceptance audit drift findings:
--   1. `execution_logs` is written by workers/ingestionWorker.ts and
--      workers/githubSyncWorker.ts with columns (workspace_id,
--      step_execution_id, target_system, status, input_payload,
--      output_payload, error_message, executed_at) that migration 003
--      (id, sop_id, agent_id, tool_name, input_params, outcome, created_at)
--      never defined. Inserts fail at runtime with "column does not exist".
--      This migration adds the missing columns, keeping the legacy ones.
--   2. `document_chunks` gets the roadmap composite index
--      (workspace_id, source_document_id) plus a GIN FTS index on content
--      for the full-text retrieval leg.
-- All statements are idempotent (additive-only policy).
-- ===================================================

-- 1. Align execution_logs with worker writes (keeps 003 columns intact)
alter table public.execution_logs
  add column if not exists workspace_id text,
  add column if not exists step_execution_id text,
  add column if not exists target_system text,
  add column if not exists status text not null default 'pending',
  add column if not exists input_payload jsonb not null default '{}'::jsonb,
  add column if not exists output_payload jsonb,
  add column if not exists error_message text,
  add column if not exists executed_at timestamptz not null default now();

create index if not exists idx_execution_logs_workspace on public.execution_logs(workspace_id);
create index if not exists idx_execution_logs_status on public.execution_logs(status);
create index if not exists idx_execution_logs_executed_at on public.execution_logs(executed_at desc);

-- 1b. skills_sops.is_stale: code (freshness.ts, mcp.ts) filters
--     .eq('is_stale', ...) on skills_sops, but the column was only ever
--     added to sop_versions (003). Align the schema with the code.
alter table public.skills_sops
  add column if not exists is_stale boolean not null default false;

-- 2. document_chunks retrieval indexes (roadmap Phase 1 schema repairs)
create index if not exists idx_document_chunks_ws_source
  on public.document_chunks(workspace_id, source_document_id);

create index if not exists idx_document_chunks_content_fts
  on public.document_chunks using gin (to_tsvector('english', content));
