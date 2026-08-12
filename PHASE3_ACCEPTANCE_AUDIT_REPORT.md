# Phase 3 Acceptance Audit Report

**Audit scope:** Phase 3 (Knowledge Corpus: chunk-first ingestion, claims, entities, graph projection, upload/storage, worker, search honesty) per `MASTER_ROADMAP.md` Phase 3, `IMPLEMENTATION_ORDER.md` Track A, `ARCHITECTURE.md` §9.5, `ARCHITECTURE_DECISIONS.md` (ADR-T6, ADR-T15).
**Method:** Read-only code/migration/test/document inspection + live verification runs. No code was modified.
**Audit date:** 2026-08-12
**Verdict: NEEDS FIXES** — the upload pipeline is functional and CI-green, but four requirements the roadmap explicitly called out are only partially implemented (or dead), and one is a cross-tenant integrity defect. None require architectural rework; all four have surgical fixes below.

---

## 1. Verification evidence (what was actually run)

| Check | Command | Result |
|---|---|---|
| Server typecheck | `npm run build --prefix server` (tsc) | ✅ PASS |
| Server lint | `npm run lint --prefix server` (eslint src test) | ✅ PASS |
| Hermetic suite | `npm test --prefix server` | ✅ **62 passed, 0 failed across 62 suites** (11.5s) |
| Standalone claim suites (unregistered) | `npx tsx test/knowledge/claimExtractor.test.ts` | ✅ 20 passed |
| | `test/knowledge/claimProvenance.test.ts` | ✅ 11 passed |
| | `test/knowledge/claimStore.test.ts` | ✅ 28 passed |
| | `test/knowledge/entityResolver.test.ts` | ✅ 38 passed |
| | `test/routes/sopClaims.test.ts` | ✅ 12 passed |

Migration 036 is additive and runner-safe (filename-order discovery; no hardcoded list in `migrator.ts`; CI migrations job applies all + asserts zero pending).

---

## 2. Requirement-by-requirement classification

| # | Roadmap requirement | Status | Evidence |
|---|---|---|---|
| 1 | Every webhook/crawl/upload ingestion creates source document + chunks + **claims** | **PARTIAL** (blocking) | Uploads: full pipeline (workers/ingestionWorker.ts → documentPipeline.ts). Webhooks: `processThreadCore` (webhookService.ts) stops at `skills_sops` insert — no claims. Crawlers (slack/linear/zendesk/email/database/github): direct `skills_sops` insert, no documents/chunks/claims (github sync.ts uses legacy `persistSourceDocumentWithChunks`). `attachmentFetcher.ts` does not exist. |
| 2 | `GET /api/sops/:id/claims` returns grounded claims | **PARTIAL** (blocking) | Route exists and is correct (200/403/404/401, confidence-ordered, foreign-claim leak-proof — 12 tests pass). But the only writer of `sop_citations.claim_id`, `linkDocumentClaimsToSop` (claimProvenance.ts), is **never called in `server/src`** — dead code (grep: only its own file + test). Endpoint returns empty for all real data. |
| 3 | SOP `confidence_score` persisted | **MISSING** (blocking) | Extractor emits `confidence_score`; claim/relationship-level confidence columns exist (036 lines 88/151/213); **no `skills_sops` confidence column and no write anywhere**. Roadmap explicitly named this as the Phase 3 fix. |
| 4 | Canonical entity resolution + graph projection (ADR-T15) | **PARTIAL + 1 defect** (blocking) | Canonical `entities`/`entity_aliases`/`entity_relationships` correctly workspace-scoped (PK workspace_id+entity_id), alias dictionary, idempotent re-processing. **Defect:** projection writes `graph_nodes.id = canonical slug` (workspace-independent) into a **global PK** (`graph_nodes.id text primary key`, migration 022; `addEntityNode` upserts on it) → same entity name in two workspaces **silently clobbers the shared row** (workspace_id/name/source_document_id). Same for `graph_edges` global unique (source_id, target_id, edge_type). Tests cover canonical isolation only ("ws-2 gets its own canonical row"), not projection isolation. |
| 5 | Worker resumable by extraction_stage cursor; DLQ retained | **PARTIAL** (non-blocking) | DLQ ✅. But one `parse_document` job runs parse→chunk→embed→claims→resolve inline; only `parsing/completed/ocr_required/failed` of the 10-stage enum are ever written (no `chunking/embedding/claims/resolve` checkpoints). Retry = full re-run (idempotent via content-hash/chunk-dedupe checks, but not stage-checkpointed; re-embeds everything). |
| 6 | `POST /api/documents/upload` (multipart, 202, status probe) | **FULLY COMPLETE** | 202 + document_id; 503 when storage unconfigured; 413/415/400 gates; content-addressed `raw/{workspace_id}/{sha256}.{ext}`; `GET /api/documents/:id/status` 404s cross-workspace (no existence leak); routes mounted in server/src/index.ts. |
| 7 | No fabricated similarity in hybrid search | **PARTIAL** (non-blocking) | Sparse leg honest (null similarity, hybridSearch.ts) ✅; dense leg real DLAC RPC over chunks ✅. **But** `embeddings.ts` maps `similarity: item.similarity || 0.9` — a genuine 0/missing similarity is reported as **0.9** (fabricated fallback, the exact failure mode the roadmap banned). |
| 8 | Duplicate source object handling (same content hash → no duplicate chunks) | **PARTIAL** (non-blocking) | No duplicate chunks possible (route inserts `external_id = content_hash`; unique (workspace_id, source='upload', external_id) rejects the duplicate — but as an **uncaught 500**). Pipeline-level content-hash short-circuit (skip when extraction_stage='completed') is unreachable for re-uploads because the route rejects before enqueue. **Consequence:** re-uploading a file after worker failure is impossible (500); recovery relies on DLQ/queue retry only. Fix: catch 23505 → return existing document_id as 202. |
| 9 | Strict Phase 3/4 boundary (search flip behind RETRIEVAL_V2 in Phase 4) | **FULLY COMPLETE** | No Phase 4 scope leaked: no `RETRIEVAL_V2` flag in `.env.example` (created in Phase 4 — consistent), no rerank/backfill worker/citationBuilder/embedding-provider files; `CRAWLER_V2=false`; legacy hybridSearch shape retained. |
| 10 | Hermetic coverage: 62 suites + relevant standalone suites + build/lint + migration verification in CI | **PARTIAL** (blocking for CI) | 62/62, build, lint, migrations job all verified green. **But the 5 Phase 3 suites (109 assertions) are NOT registered in `run-all.ts`** → CI's `npm test` never exercises claims/provenance/entity/claims-route code. They are hermetic and pass standalone (verified). `chunkIngestion.integration` exclusion is documented and legitimate (jest + live Supabase). |
| 11 | Docs updated: ARCHITECTURE.md + migrations + AGENTS.md; runbook; README API docs | **PARTIAL** (non-blocking) | ARCHITECTURE.md §9.5 worker doc is accurate ✅. But: ER diagram (lines 688–712) omits `storage_uri`/`extraction_stage` on source_documents, `source_object_key`/`embedding_model`/`embedding_version` on document_chunks, and **all** of knowledge_claims/claim_evidence/entities/entity_aliases/entity_relationships; migration table (723–753) omits 033–036; roadmap cites `031_knowledge_corpus.sql` but actual is `036` (031 taken by usage_meters_detail — rename not propagated); README has no upload/claims API docs; `deploy/docs/runbooks/` absent; `COMPANY_BRAIN_CRITICAL_REVIEW.md` missing (deleted in commit c6b4875) though AGENTS.md and the roadmap reference it; AGENTS.md not updated for Phase 3. |

---

## 3. Findings

### BLOCKING (fix before Phase 4 planning is finalized)

**B1 — Claims not extracted from webhooks or crawlers** (requirement 1, 1/3 paths wired)
- `workers/ingestionWorker.ts` (upload path) → `processDocumentPipeline` ✅
- `services/ingestion/webhookService.ts` `processThreadCore` → stops at SOP insert ✗
- `services/crawlers/{slack,linear,zendesk,email,database,github}.ts` → direct `skills_sops` insert ✗
- Fix: route thread-based SOP creation through a claims-extraction step (shared helper invoked by webhook worker and crawlers), or enqueue a `parse_document`-style claims job keyed to the raw_thread/source_document.

**B2 — SOP confidence_score never persisted** (requirement 3)
- Extractor emits it; nothing writes it; no column on `skills_sops`.
- Fix: migration adding `confidence_score numeric check (0..1)` to `skills_sops`; populate in `extractSOPFromThread`/SOP persist paths.

**B3 — SOP→claim provenance is dead code** (requirement 2)
- `linkDocumentClaimsToSop` (claimProvenance.ts) unreferenced in `server/src`; `GET /api/sops/:id/claims` therefore always empty in production.
- Fix: call it after claims persist in the SOP-creation paths (webhook worker at minimum); delete or wire `sop_citations.chunk_id`.

**B4 — Cross-workspace graph projection clobbering** (requirement 4, isolation)
- `entityResolver.ts` passes deterministic workspace-independent canonical slugs as `graph_nodes.id`; `graph_nodes.id` is a **global** PK (022); `addEntityNode` upserts on it (graphService.ts:61). Same-entity ingestion in two workspaces overwrites one shared row. `graph_edges` global unique (source_id, target_id, edge_type) likewise.
- Fix (surgical): namespace projection ids as `${workspace_id}:${slug}` (projection is a derived compat layer — canonical `entities` remain the correct, scoped source of truth); optionally add `workspace_id` to the graph PKs in a migration.

### NON-BLOCKING (should fix; do not block Phase 4)

- **N1** Phase 3 suites excluded from CI — register all 5 in `run-all.ts` (109 assertions currently unguarded).
- **N2** Fabricated-similarity fallback `item.similarity || 0.9` in embeddings.ts — use `?? null` + treat-as-missing instead.
- **N3** Worker stage checkpointing is nominal — 10-stage enum, 4 states written; no `chunking/embedding/claims/resolve` markers; retries re-run + re-embed everything (idempotent, wasteful).
- **N4** Duplicate upload → uncaught 500 (unique violation); catch 23505 → return existing document_id 202; enables re-upload recovery.
- **N5** Entity/relationship confidence hardcoded `Math.max(prev, 1.0)` (always 1.0, not derived); `valid_until` never set.
- **N6** Docs drift: ER diagram, migration table, roadmap 031→036 rename, README API docs, missing runbook + missing COMPANY_BRAIN_CRITICAL_REVIEW.md.
- **N7** Process: entire Phase 3 is **uncommitted** (13 modified + 22 untracked; no Phase 3 commits; latest commit fc5749f is connectors registry). Commit before Phase 4 planning so the audit baseline is durable.

---

## 4. What is genuinely complete (do not re-audit)

- Migration 036: well-formed, additive, RLS+tenant policies on all new tables, dedupe constraints (claim_text_hash, evidence (claim_id, chunk_id), unique(source_document_id, chunk_index)).
- `documentPipeline.ts`: provider-agnostic, staged exports, content-hash short-circuit when `extraction_stage='completed'`.
- `claimExtractor.ts`: zod-validated (≥10 chars, confidence 0..1, char offsets into chunk), grounded prompt, FAQ-style, max 20 claims.
- `claimStore.ts`: idempotent, rejects unknown chunk ids.
- Parser layer: pdf (layout-aware), docx (mammoth), xlsx (500×200 caps), ocr gateway (honest null → `ocr_required` terminal state).
- Storage: factory + S3 + in-memory (production-refused), content-addressed keys, health checks.
- Route behavior matrix (202/404/403/401/503/413/415) — tested.
- Hybrid search sparse leg honesty; OpenFGA prefilter; DLAC dense leg over document_chunks.
- Legacy compatibility: `skills_sops` still written by all thread paths; extractor/zod/queue imports intact; no Phase 4 scope leaked.

## 5. Recommended action order

1. B4 (cross-tenant integrity — highest severity)
2. B3 + B2 (wire provenance + persist confidence — one migration, one shared helper)
3. B1 (claims in webhook/crawler paths)
4. N1 (register suites — CI then guards 1–3)
5. N2, N4, N3, N5 (small code fixes)
6. N6, N7 (docs + commit)

After B1–B4 + N1: re-run `npm test` (expect 67 suites) and re-audit → likely upgrades verdict to PASS WITH MINOR ISSUES.
