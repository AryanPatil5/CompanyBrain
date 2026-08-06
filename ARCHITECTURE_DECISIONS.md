# Company Brain — Architecture Decisions (ADRs)

> **Status:** Ratified set of decisions guiding the 15-phase roadmap (v2.0, 2026-08-05). Phase references updated to the renumbered phases (0–14); scaffolds that Phase 0 pulls forward are noted per ADR.
> **Format:** Each ADR records Context → Options → Decision → Consequences → Status/Revisit.
> **Companion docs:** `MASTER_ROADMAP.md` (what), `IMPLEMENTATION_ORDER.md` (when).
> Decisions marked **decide-at-kickoff** must be locked before parallel tracks start.

---

## T1 — Migration Paradigm: Runner-Owned Additive Migrations

- **Status:** Ratified (Phase 1)
- **Context:** 30 hand-applied Supabase SQL files, applied manually in the SQL editor, with ordering fragility (migration `028` exists purely to repair ordering). No record of what ran. Code references columns (`crawled_sources.workspace_id`) and tables that don't exist.
- **Options:** (a) Keep manual Supabase SQL Editor workflow; (b) Adopt a lightweight runner (`migrate` CLI + `schema_migrations`) applying files in filename order; (c) Move to a full ORM migration framework (knex/prisma/drizzle).
- **Decision:** **(b)** Runner-owned, file-ordered, additive migrations. The runner reads `server/supabase/*.sql`, applies in numeric order, records `schema_migrations(version, applied_at, checksum)`, wraps each file in a transaction, and refuses checksum-differing re-applies.
- **Why not (a):** unverifiable, orders human error, blocks CI. **Why not (c):** existing investment is in raw SQL tuned for Supabase; an ORM migration layer would fight PostgREST/RLS/SQL functions.
- **Consequences:** Every schema change NECESSARILY is a new numbered file (no edits to applied files). Migrations run in CI on ephemeral Postgres and as a Helm pre-rollout Job. SQL quality bar: idempotent, transactional, code-contract tests.
- **Revisit:** If the team moves off Supabase to plain Postgres with a terraform/atlas pipeline, swap the runner backend, keep the file-based paradigm.

---

## T2 — Embedding Pipeline: Hosted Provider as Primary, Local as Optional Fallback, No Pseudo-Vectors in Production

- **Status:** Ratified (Phase 0 direction, Phase 4 delivery)
- **Context:** `aiProvider.generateEmbeddings` pads an Ollama 768-dim model to "1536" and falls back to a deterministic pseudo-vector with zero similarity semantics. Retrieval quality in production is therefore unfounded.
- **Options:** (a) Keep Ollama nomic-embed primary; (b) Hosted embedding APIs (OpenAI text-embedding-3 / Voyage / Cohere / OpenRouter-hosted); (c) Self-host a local embedding model service.
- **Decision:** **(b)** with pinned `embedding_model`/`embedding_version` recorded on every vector row, a provider abstraction (`embeddingProvider.ts`), and Ollama as an explicitly-flagged fallback. Pseudo-vectors exist only in unit tests. **Phase 0** enforces the provider-required contract (no pseudo-vector fallback outside tests) and surfaces provider health on `/health`; **Phase 4** delivers hosted primary + versioned re-embedding.
- **Consequences:** Cost per chunk; mitigated by content-hash caching, batch embedding, per-workspace budgets (P9) and model routing (P13). Versioned embeddings make re-embedding a resumable worker, not a migration.
- **Revisit:** If a customer requires Air-gapped SOC2-class deployments, reintroduce self-hosted embeddings (bge/embed-v3) behind the same provider interface.
- **Decision for ADR:** Also choose **rerank model** as hosted cross-encoder (Cohere rerank-v3 / OpenRouter bge-reranker) with lexical fallback; interface allows self-host later.

---

## T3 — Authorization Model: PDP Abstraction with Postgres-Backed Default, OpenFGA as Alternative

- **Status:** **decide-at-kickoff** (ratified direction: Phase 5)
- **Context:** `openfgaClient.ts` is an in-memory Set with a TTL cache and no server; `getUserAccessibleDocumentIds` iterates all tuples. RLS exists but is inconsistent; ABAC middleware is unwired; source ACLs aren't captured.
- **Options:** (a) Stand up an OpenFGA service immediately; (b) PostgreSQL/RLS-native authorization as the PDP (workspaces + `source_document_acls` + `entity_group_memberships`); (c) Authorize everything in application code only.
- **Decision:** **(b) first, with a hard `AuthorizationService` interface** and an OpenFGA implementation (`openfgaPdp.ts`) selectable via `AUTHZ_BACKEND`, sharing a single decision model (`check(user, action, object)` / `listAccessible`), fail-closed semantics, short TTL caches, and metrics. RLS remains the bottom-line tenant boundary; the PDP layer decides object-level access for search/graph/execution.
- **Why not (a) first:** an extra stateful service before the data model (corpus + ACLs) exists invites schema churn; PG-native ships faster and de-risks. **Why not (c):** unacceptable blast radius.
- **Consequences:** Cross-tenant isolation provable by test suite; PDP outage → 403 by contract; OpenFGA becomes an enablement feature for customers who demand it, not a dependency of the platform.
- **Revisit:** When object-graph authorization (inheritance, team trees) outgrows the PG model at scale, promote the OpenFGA path to default; the interface swap is the migration.

---

## T4 — Knowledge Graph Strategy: Relational Tables as System of Record; Apache AGE Retired as Dead Code

- **Status:** Ratified — executed as owned work in Phase 0 (previously "Phase 3/4 alignment")
- **Context:** AGE is enabled in SQL but `executeCypher` is dead code; all real logic uses `graph_nodes`/`graph_edges` (relational). AGE adds operational debt with no runtime consumer.
- **Options:** (a) Keep the SQL extension + RPC and invest in making AGE the graph store; (b) Commit to the relational graph as source of truth and delete the AGE scaffolding; (c) Hybrid dual-write.
- **Decision:** **(b)** with a **semantic graph extension** (entities/relationships/enriched claims edges, embedding columns, temporal validity via `valid_from/valid_until`, workspace scoping) maintained in relational tables that RLS and backup tooling already understand. **Phase 0** drops the dead `execute_cypher_query` RPC (`029_foundation_hardening.sql`), removes AGE references from helm/compose, adds traversal + workspace-scoping indexes, and ships a TS graph-algorithm library (topological sort, shortest path, connected components) so no separate graph engine is needed at this scale.
- **Why not (a):** no app consumer, operator burden (extension, version alignment) with zero payoff. **Why not (c):** dual-write doubles inconsistency risk for no current consumer benefit.
- **Consequences:** Graph traversal stays 1–N hop relational (already DLAC-filtered in `graphService`); the entity resolver (Phase 3) writes canonical entities/relationships with provenance; temporal edges (`SUPERSEDES`, `valid_until`) give point-in-time correctness. **Revisit:** >10⁶–10⁷ edges per workspace or true multi-hop analytical queries → evaluate a dedicated graph DB behind a graph-reads interface.
- **Proof requirement:** delete `executeCypher` test coverage, replace with relational traversal + graph-algorithm tests; fix workspace scoping gap noted in `getConnectedEntities` (Phase 0).

---

## T5 — Execution Engines: Temporal for Durable Agent Workflows; BullMQ for High-Volume Ingestion Only

- **Status:** **decide-at-kickoff** (ratified direction: Phase 6)
- **Context:** Both Temporal and BullMQ are wired today with overlapping responsibilities and a single-process boot; `runWorkflow` uses Redis checkpointing that loses state on crash; Temporal only wraps a research step.
- **Options:** (a) Consolidate everything on Temporal; (b) Keep BullMQ for ingestion/crawl and Temporal for agent execution; (c) Dropping Temporal and building durable logic itself.
- **Decision:** **(b).** Temporal = the durable, supervised execution orchestrator for agent workflows (run ledger in Postgres is the authoritative store; Temporal broadcasts steps/signals/retries). BullMQ = throughput-tolerant ingestion/crawl/webhook queues with per-provider rate limiting and DLQ.
- **Why not (a):** ingestion is inherently fire-and-forget with rate-limit semantics and label-based health; forcing it into Temporal adds operational cost. **Why not (c):** hand-rolling durable execution is a known failure mode.
- **Consequences:** Clear ownership: at-most-once-tolerant events → BullMQ; exactly-once semantic workflows → Temporal + idempotency keys. Run ledger tables (`agent_runs`/`agent_steps`/`tool_invocations`) are the audit-source of truth regardless of engine.

---

## T6 — Object Storage as First-Class Corpus Backend (S3-Compatible)

- **Status:** Ratified (Phase 0 substrate, Phase 2+ delivery)
- **Context:** Knowledge currently lives only as JSON blobs in DB. Attachments and raw source objects (Slack files, Drive attachments, Email MIME) — a large slice of enterprise knowledge — cannot be stored, parsed idempotently, or ACL-managed.
- **Options:** (a) Store everything as `bytea`/JSON in Supabase; (b) S3-compatible object storage (MinIO local / S3/GCS cloud); (c) Supabase Storage bucket.
- **Decision:** **(b)** behind a `storageProvider` interface. Raw source objects (immutable, content-hashed) and attachments live in buckets; DB stores fingerprints + URIs + metadata; parse pipeline reads from storage. Supabase Storage is a compatible option behind the same interface for hosted deployments. **Phase 0** adds the MinIO service to compose/Helm so the dependency exists before connectors write to it.
- **Consequences:** Cost separates from DB I/O; DLP/retention (P10/11) operate on storage lifecycle; connector attachments unblock (P12). Env additions (`STORAGE_ENDPOINT`, `STORAGE_BUCKET`, keys) and a MinIO compose service.
- **Revisit:** Rarely; blob lifecycle/retention classes may later move to provider-native policies.

---

## T7 — Retrieval Product Shape: Chunk-First Hybrid Search with Mandatory Citations

- **Status:** Ratified (Phase 4)
- **Context:** Retrieval mixes `skills_sops` pseudo-results, ILIKE, and term-overlap reranking; SOPs (coarse) are the return unit; citations link SOP→thread only; grounding guardrail is response-level and fail-closed-prone.
- **Options:** (a) Keep SOP-level retrieval and layer citations on top; (b) Chunk-level retrieval with forced claim/chunk citations and an answer endpoint; (c) Provide both behind a mode switch.
- **Decision:** **(b)** as the product core, with (c) as a transitional compatibility shim (`RETRIEVAL_V2`). Chunks are the atomic candidate; SOPs/procedures are projections. `POST /api/sops/answer` always returns step-level citations (claim + chunk offset); the grounding guardrail becomes claim-level with a deterministic chained-citation fallback when the LLM judge is unavailable (never silent fail-open/fail-closed).
- **Consequences:** Better relevance (chunk granularity), auditable provenance (trust), and cheaper synthesis (context contains only relevant chunks). Breaking search-API change is coordinated with the client in the same release.
- **Revisit:** If latency becomes a blocker at scale, hybrid-k and candidate caps (top-50 before rerank) become tunable knobs in the retrieval service config, not an architectural change.

---

## T8 — Observable Truth: OpenTelemetry End-to-End with Structured Logs; Metrics/SLOs as Code

- **Status:** Ratified (Phase 0 scaffold, Phase 9 completion)
- **Context:** In-memory traces + Prometheus text endpoint only; no export, no correlation IDs across REST/MCP/workers/Temporal; readiness probe points a `/metrics`; no SLOs; no cost attribution.
- **Options:** (a) Vendor-specific SDKs everywhere (DD/AWSObs); (b) OpenTelemetry SDK + OTLP export to an OTLP-compatible backend (SigNoz/datadog/AWS X-Ray/Tempo/lightstep); (c) keep in-memory.
- **Decision:** **(b).** One OTel config, OTLP exporter, correlation IDs (`req_id`/`trace_id`/`workspace_id`/`agent_id`) in structured JSON logs, dashboards + alert rules as code, and cost meters fed by the same telemetry. **Phase 0** installs the scaffold (OTel registration, correlation-ID middleware, structured logger with redaction) on the new process-isolated entrypoints; **Phase 9** completes OTLP export, SLOs/alerting, dashboards, load/chaos gates, and cost-meter enforcement.
- **Consequences:** Portable across backends; one instrumentation path for API/workers/Temporal/DB. Cards the readiness probe to a dedicated process health port (Phase 0).
- **Revisit:** Backend choice per deployment (self-host SigNoz vs cloud) — no code change, only `OTEL_EXPORTER_OTLP_ENDPOINT`.

---

## T9 — Repository / Build Topology: Per-Service Packages, Shared Scripts, Single CI

- **Status:** Ratified (Phase 0/1, executed)
- **Context:** Three deployable services, no root package.json; `server` ESM/NodeNext `.js` import rule; client uses `@/*` alias; overlapping scripts (test command skew) and no root orchestration.
- **Options:** (a) Convert to a pnpm/turbo workspace monorepo; (b) Keep per-directory package.json + root `Makefile`/`justfile` orchestration + CI per service; (c) single package.json root.
- **Decision:** **(b).** Preserve each service's independence (deploy autonomy), add a root task runner (`Makefile`/`justfile`) for `dev`, `lint`, `typecheck`, `build`, `test`, `migrate`, `helm-validate`; CI wires these per service. Keep the ESM/`.js`-import and `@/*` conventions enforced by lint. **Phase 0** executes the process-topology half as well: per-process entrypoints (`api`, `mcp`, `crawler`, `ingestion-worker`, `temporal-worker`) selected by `PROCESSES`, replacing single-process `npm start`.
- **Why not (a):** migration cost + shared-version coupling isn't needed at this scale; three deployables, two languages of config. **Why not (c):** fights per-service scripts/typescripts.
- **Consequences:** Developer UX improves via unified commands; CI remains per-service and hermetic; replicas scale independently without duplicated crawler timers.

---

## T10 — API & MCP Versioning Policy

- **Status:** Ratified (Phase 4+)
- **Context:** One consumer (client) today, but webhooks, MCP tools, and future partner integrations exist. Numerous breaking changes are planned (search shape, webhook async, workflow envelope, skills exec).
- **Options:** (a) Break freely (only first-party consumer); (b) Explicit versioned endpoints (`/api/v2`) with one-release deprecation windows; (c) Version everything including MCP tool names.
- **Decision:** **(b)** for HTTP (`/api/v1`, `/api/v2` during transitions) with a one-release overlap, and **(semantics)** for MCP: tool *parameters* may gain optional fields; tool behavioral changes (skills execution) shipped with a clear changelog and registry-gated rollout. Breaking changes always ride a client PR in the same release.
- **Consequences:** Slightly larger surface temporarily; protects future partners and the API as product surface (user writes integrations over REST).

---

## T11 — Test Strategy: Hermetic Unit Tier + Infra-Gated Integration/Eval Tiers, Hard Timeouts, CI Gates

- **Status:** Ratified (Phase 1)
- **Context:** No framework; custom tsx self-executing runners; suites false-pass and hang; `npm test` runs one file; no CI.
- **Options:** (a) Move everything to Vitest; (b) Keep tsx custom runners but add infra gating + CI; (c) Pick Jest.
- **Decision:** **(b) with a light converging harness.** Keep tsx runners (that's the pattern the repo uses, incl. self-execution hooks), add `testEnv.ts` infra-gating, hard timeouts, and unified `test:unit` / `test:integration` / `test:coverage`; extraction/retrieval/policy/skill suites grow `test:eval:*` with threshold gates in CI. Migrating the bespoke runners to Vitest is tracked as an option, done only if ergonomics justify the churn without breaking the eval/self-exec pattern.
- **Consequences:** CI never hangs; suites either run hermetic or skip cleanly on missing infra; eval gates stop regression. Vital for trusting every later phase.
- **Revisit:** When a second framework consumer (e.g., browser component tests for client) appears, standardize the client on Vitest + testing-library and the server stays as decided.

---

## T12 — Cost & Multi-Tenant Economy: Per-Workspace Budgets and Meters From Day One of AI Scale

- **Status:** Ratified (Phase 0 scaffold, Phase 9 enforcement)
- **Context:** Embedding/LLM costs scale with chunk corpus and query volume; no attribution today; single demo workspace dominates.
- **Options:** (a) Central budget + alerting; (b) Per-workspace meters with soft limits then hard enforcement; (c) Unmetered.
- **Decision:** **(b)** — `costMeter` (P9) + `usage_meters` records for embeddings, LLM tokens, OCR/transcription, storage; soft alerts first, per-workspace hard caps behind flag for SMB/paid tiers. Model routing (P13) classifies tasks to cost-optimal tiers per policy. **Phase 0** installs the `usage_meters` table (`029_foundation_hardening.sql`) and the `costMeter` interface at the LLM/embedding gate so attribution exists from the first AI call.
- **Consequences:** Pricing and multi-tenant viability; ops visibility into runaway ingestion; evals confirm quality doesn't regress when cheaper models are routed.

---

## T13 — Idempotency & Exactly-Once Semantics for Execution (Before Any Real Automation)

- **Status:** Ratified (Phase 6)
- **Context:** `executePlan` has minimal retry and no idempotency; payment/refund/DB/notify adapters could double-execute on retry; compensation is absent.
- **Options:** (a) Document "adapters must be naturally idempotent"; (b) Central idempotency-key ledger + adapter-level compensation hooks; (c) no-op.
- **Decision:** **(b)** — every tool invocation has a `idempotency_key`, persisted in `idempotency_keys` with unique constraint; adapters emit upstream Idempotency-Key headers where supported (Stripe) and are flagged when not; a run-level dedupe guarantees at-most-once external action; compensation registry executes registered compensating actions on terminal failure; un-backed actions escalate to humans.
- **Consequences:** Trustworthy automation for high-risk ops; audit trail per tool call; the platform never claims exactly-once for adapters that can't provide it (explicit capability flags).

---

## T14 — DLP/Retention/Tenancy as Ingestion-Time Concerns, Not Bolt-On Reporting

- **Status:** Ratified (Phase 2/3 design, Phase 10/11 enforcement)
- **Context:** Enterprise compliance is a purchasing blocker; retention and DLP are far cheaper to enforce at ingestion and corpus-write time than retroactively.
- **Options:** (a) Retrospective DLP/retention scanner over the corpus; (b) DLP classification + retention metadata written at ingestion/parse; (c) skip.
- **Decision:** **(b)** — `dlp_classifications`, retention class, and legal-hold metadata are attached when source objects/chunks are written (Phases 2/3), then enforced by Phase 10 retention workers and Phase 11 DSR/DLP enforcement. DLP runs pattern+entity checks at parse; quarantines with admin review.
- **Consequences:** Small ingestion-time cost; compliance automation (export/delete/hold) has the metadata to execute precisely; audit ledger covers the whole lifecycle rather than only execution.

---

## T15 — The Company Brain "Recipe": Immutable Raw → Chunks → Claims → Entities → Projections (SOPs/Skills) → Memory

- **Status:** Ratified north-star (Phases 2–4, 6–7, 13)
- **Context:** The product currently flattens everything into `skills_sops`, losing granularity, provenance, confidence, and temporal correctness.
- **Options:** (a) Treat SOPs as the atom and evolve; (b) Re-architect to the multi-layer substrate; (c) hybrid.
- **Decision:** **(b)** — durable, content-hashed source objects (P2) → chunks with embeddings (P3) → atomic claims + evidence + confidence (P3) → canonical entities/relationships via resolver (P3) → SOPs, skills, workflow graphs as **projections** over the substrate (P4–P7) → episodic/semantic/procedural memory built on runs + claims (P13).
- **Consequences:** Every downstream feature (retrieval, citations, freshness, contradiction detection, skills, evals, feedback re-scoring) becomes a consumer of one well-defined substrate instead of bespoke logic per feature; kills the current schema-drift class of bugs at the root. This is the single most important architecture decision; the phases exist to build it without breaking the demo.
- **Revisit:** Only if the substrate's abstractions prove insufficiently expressive at >100k chunks/workspace; the projection layer is designed to absorb that.

---

## 8 Quick-Reference Decision Summary

| # | Decision | Phase | Status |
|---|---|---|---|
| T1 | Runner-owned additive migrations, `schema_migrations` | 1 | Ratified |
| T2 | Hosted embeddings + rerank providers, versioned, no pseudo-vectors in prod | 0 dir / 4 | Ratified |
| T3 | PDP abstraction; PG-backed default, OpenFGA optional (`AUTHZ_BACKEND`) | 5 | **kickoff** |
| T4 | Relational graph system-of-record; retire AGE dead code | 0 | Ratified |
| T5 | Temporal for durable agents; BullMQ for ingestion only | 6 | **kickoff** |
| T6 | S3-compatible object storage for raw objects/attachments | 0/2 | Ratified |
| T7 | Chunk-first retrieval + mandatory claim citations | 4 | Ratified |
| T8 | OTel + OTLP export; structured logs; SLOs as code | 0 scaffold / 9 | Ratified |
| T9 | Per-service packages + root task runner + per-service CI; process topology | 0/1 | Ratified |
| T10 | Versioned HTTP API with one-release deprecation; semantic MCP versioning | 4+ | Ratified |
| T11 | Hermetic unit + infra-gated integration/eval tiers, hard timeouts, CI gates | 1 | Ratified |
| T12 | Per-workspace cost meters + soft→hard budget caps | 0 scaffold / 9 | Ratified |
| T13 | Central idempotency ledger + compensation registry for execution | 6 | Ratified |
| T14 | DLP/retention/legal-hold metadata written at ingestion time | 2/3 → 10/11 | Ratified |
| T15 | Substrate: raw → chunks → claims → entities → projections → memory | 2–7, 13 | Ratified |

**To lock at kickoff:** T3 (authz backend posture), T5 (engine split), T2 model + dimensions (embedding/rerank provider + version), T15 scope-of-substrate v1.