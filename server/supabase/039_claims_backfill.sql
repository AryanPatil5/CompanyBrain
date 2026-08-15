-- ===================================================
-- Company Brain: Phase 3 — Knowledge claims backfill checkpoint (additive)
--
-- The claims backfill worker (ADR-T15 "backfill via idempotent, resumable
-- workers") re-derives knowledge_claims for source documents whose chunks
-- exist but whose claims were never extracted: documents completed before
-- the claim pipeline landed, or rows that slipped past the claims stage.
--
-- Progress is owned by a checkpoint on the source_documents row, NOT by the
-- queue: a crashed batch re-picks the same documents idempotently (the
-- knowledge_claims unique key makes re-derivation a no-op), and a poisoned
-- document is quarantined after CLAIMS_BACKFILL_MAX_FAILURES failed attempts
-- instead of retrying forever on every sweep.
--
-- The main ingestion paths (processThreadTail for threads/crawlers, the
-- parse_document upload worker) stamp claims_derived_at after a successful
-- claim extraction, so only genuinely-missing documents remain candidates.
-- ===================================================

alter table public.source_documents
  add column if not exists claims_derived_at timestamptz,
  add column if not exists claims_derived_version text,
  add column if not exists claims_backfill_failures integer not null default 0;

create index if not exists idx_source_documents_claims_pending
  on public.source_documents(workspace_id)
  where claims_derived_at is null;