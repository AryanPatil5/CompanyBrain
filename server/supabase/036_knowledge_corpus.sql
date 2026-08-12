-- ===================================================
-- Company Brain: Phase 3 — Knowledge corpus (ADR-T1, additive)
--
-- The immutable source document -> chunk -> claim -> evidence -> entity
-- substrate (ADR-T15). Everything here is additive: no graph_nodes /
-- graph_edges changes, no existing column removals, no renames.
--
-- Adds:
--   source_documents.storage_uri       — object-storage URI of the raw object
--                                        (ADR-T6 storageProvider; null for
--                                        thread/webhook-only documents)
--   source_documents.extraction_stage  — resumable pipeline checkpoint
--                                        (none|queued|parsing|chunking|
--                                        embedding|claims|resolve|completed|
--                                        ocr_required|failed)
--   document_chunks.source_object_key  — content-addressed storage key of the
--                                        source object the chunk came from
--   document_chunks.embedding_model    — model id that produced `embedding`
--   document_chunks.embedding_version  — model version that produced `embedding`
--   knowledge_claims                   — atomic, schema-validated claims
--   claim_evidence                     — char-offset evidence per claim
--   entities / entity_aliases /        — canonical knowledge entities (source
--   entity_relationships                 of truth; graph_nodes/graph_edges are
--                                        a compatibility projection)
--   sop_citations.chunk_id / claim_id  — additive SOP -> corpus linkage
--   sop_citations.raw_thread_id        — relaxed to nullable: upload-derived
--                                        documents have no raw thread
--
-- Tenant isolation: every new table carries workspace_id; RLS follows the
-- established 027/034/035 pattern (service-role full access for routes and
-- workers, workspace-scoped reads for members).
--
-- Idempotency: unique keys mirror the deterministic identity rules of the
-- claim store and entity resolver:
--   knowledge_claims UNIQUE (workspace_id, source_document_id, chunk_id,
--                            claim_text_hash)   — sha256(claim_text)
--   claim_evidence UNIQUE (claim_id, chunk_id)
--   entities PK (workspace_id, entity_id)       — entity_id = canonical slug
--   entity_aliases PK (workspace_id, entity_id, alias)
--   entity_relationships UNIQUE (workspace_id, source_entity_id,
--                                target_entity_id, relationship_type)
-- ===================================================

-- ─── Additive columns: source_documents ───────────────────────

alter table public.source_documents
  add column if not exists storage_uri text,
  add column if not exists extraction_stage text not null default 'none'
    check (extraction_stage in ('none', 'queued', 'parsing', 'chunking', 'embedding', 'claims', 'resolve', 'completed', 'ocr_required', 'failed'));

create index if not exists idx_source_documents_stage
  on public.source_documents(workspace_id, extraction_stage);

-- ─── Additive columns: document_chunks ────────────────────────

alter table public.document_chunks
  add column if not exists source_object_key text,
  add column if not exists embedding_model text,
  add column if not exists embedding_version text;

create index if not exists idx_document_chunks_workspace_source_doc
  on public.document_chunks(workspace_id, source_document_id);

-- ─── Additive columns: sop_citations ──────────────────────────

alter table public.sop_citations
  add column if not exists chunk_id uuid,
  add column if not exists claim_id uuid;

-- Upload-derived documents have no raw thread; relax the legacy NOT NULL.
alter table public.sop_citations
  alter column raw_thread_id drop not null;

create index if not exists idx_sop_citations_sop_claims
  on public.sop_citations(sop_id, claim_id)
  where claim_id is not null;

-- ─── knowledge_claims ──────────────────────────────────────────

create table if not exists public.knowledge_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  chunk_id uuid not null references public.document_chunks(id) on delete cascade,
  claim_text text not null,
  claim_text_hash text not null,
  claim_type text not null default 'operational',
  confidence numeric not null default 0.5
    check (confidence >= 0 and confidence <= 1),
  status text not null default 'draft'
    check (status in ('draft', 'reviewed', 'accepted', 'rejected')),
  ai_generated boolean not null default true,
  reviewed_by text,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint knowledge_claims_dedupe unique (workspace_id, source_document_id, chunk_id, claim_text_hash)
);

create index if not exists idx_knowledge_claims_workspace on public.knowledge_claims(workspace_id);
create index if not exists idx_knowledge_claims_source_doc on public.knowledge_claims(source_document_id);
create index if not exists idx_knowledge_claims_chunk on public.knowledge_claims(chunk_id);

alter table public.knowledge_claims enable row level security;

drop policy if exists "Service role full access on knowledge_claims" on public.knowledge_claims;
create policy "Service role full access on knowledge_claims"
  on public.knowledge_claims for all using (true) with check (true);

drop policy if exists "Workspace read own knowledge_claims" on public.knowledge_claims;
create policy "Workspace read own knowledge_claims"
  on public.knowledge_claims for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');

-- ─── claim_evidence ────────────────────────────────────────────

create table if not exists public.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  claim_id uuid not null references public.knowledge_claims(id) on delete cascade,
  chunk_id uuid not null references public.document_chunks(id) on delete cascade,
  char_start integer,
  char_end integer,
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  provenance_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint claim_evidence_dedupe unique (claim_id, chunk_id)
);

create index if not exists idx_claim_evidence_workspace on public.claim_evidence(workspace_id);
create index if not exists idx_claim_evidence_claim on public.claim_evidence(claim_id);

alter table public.claim_evidence enable row level security;

drop policy if exists "Service role full access on claim_evidence" on public.claim_evidence;
create policy "Service role full access on claim_evidence"
  on public.claim_evidence for all using (true) with check (true);

drop policy if exists "Workspace read own claim_evidence" on public.claim_evidence;
create policy "Workspace read own claim_evidence"
  on public.claim_evidence for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');

-- ─── entities (canonical source of truth) ──────────────────────

create table if not exists public.entities (
  workspace_id text not null,
  entity_id text not null,
  canonical_name text not null,
  entity_type text not null
    check (entity_type in ('Person', 'System', 'SOP', 'Rule', 'Step', 'Policy', 'Team', 'Role', 'Entity')),
  confidence numeric not null default 0.5
    check (confidence >= 0 and confidence <= 1),
  valid_from timestamptz,
  valid_until timestamptz,
  source_document_id uuid references public.source_documents(id) on delete set null,
  properties jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint entities_pkey primary key (workspace_id, entity_id)
);

create index if not exists idx_entities_workspace_type on public.entities(workspace_id, entity_type);
create index if not exists idx_entities_source_doc on public.entities(source_document_id);

alter table public.entities enable row level security;

drop policy if exists "Service role full access on entities" on public.entities;
create policy "Service role full access on entities"
  on public.entities for all using (true) with check (true);

drop policy if exists "Workspace read own entities" on public.entities;
create policy "Workspace read own entities"
  on public.entities for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');

-- ─── entity_aliases ────────────────────────────────────────────

create table if not exists public.entity_aliases (
  workspace_id text not null,
  entity_id text not null,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint entity_aliases_pkey primary key (workspace_id, entity_id, alias),
  constraint entity_aliases_entity_fk
    foreign key (workspace_id, entity_id)
    references public.entities(workspace_id, entity_id)
    on delete cascade
);

create index if not exists idx_entity_aliases_workspace on public.entity_aliases(workspace_id);
create index if not exists idx_entity_aliases_alias on public.entity_aliases(workspace_id, alias);

alter table public.entity_aliases enable row level security;

drop policy if exists "Service role full access on entity_aliases" on public.entity_aliases;
create policy "Service role full access on entity_aliases"
  on public.entity_aliases for all using (true) with check (true);

drop policy if exists "Workspace read own entity_aliases" on public.entity_aliases;
create policy "Workspace read own entity_aliases"
  on public.entity_aliases for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');

-- ─── entity_relationships ──────────────────────────────────────

create table if not exists public.entity_relationships (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_entity_id text not null,
  target_entity_id text not null,
  relationship_type text not null,
  confidence numeric not null default 0.5
    check (confidence >= 0 and confidence <= 1),
  valid_from timestamptz,
  valid_until timestamptz,
  source_document_id uuid references public.source_documents(id) on delete set null,
  chunk_id uuid references public.document_chunks(id) on delete set null,
  properties jsonb not null default '{}'::jsonb,
  projected_at timestamptz,
  created_at timestamptz not null default now(),
  constraint entity_relationships_dedupe unique (workspace_id, source_entity_id, target_entity_id, relationship_type)
);

create index if not exists idx_entity_relationships_workspace on public.entity_relationships(workspace_id);
create index if not exists idx_entity_relationships_source on public.entity_relationships(workspace_id, source_entity_id);
create index if not exists idx_entity_relationships_target on public.entity_relationships(workspace_id, target_entity_id);

alter table public.entity_relationships enable row level security;

drop policy if exists "Service role full access on entity_relationships" on public.entity_relationships;
create policy "Service role full access on entity_relationships"
  on public.entity_relationships for all using (true) with check (true);

drop policy if exists "Workspace read own entity_relationships" on public.entity_relationships;
create policy "Workspace read own entity_relationships"
  on public.entity_relationships for select
  using (workspace_id = current_setting('request.jwt.claims', true)::json->>'workspace_id');

-- ─── sop_citations claim linkage (declared after knowledge_claims exists) ────
--
-- Idempotent claim linkage: at most one citation row per (sop, claim). Legacy
-- rows carry claim_id NULL — Postgres UNIQUE treats NULLs as distinct, so
-- existing multi-thread citations stay valid and only claim links dedupe.

alter table public.sop_citations
  add constraint sop_citations_claim_link unique (sop_id, claim_id);

alter table public.sop_citations
  add constraint sop_citations_claim_fk
  foreign key (claim_id)
  references public.knowledge_claims(id)
  on delete set null;
