# Company Brain — Master Engineering Roadmap

> **Status:** v2.0 — Living document (restructured by Principal-Engineer design review, 2026-08-05)
> **Author:** CTO / Principal Engineer
> **Basis:** Full-repository audit (see `COMPANY_BRAIN_CRITICAL_REVIEW.md` + `ARCHITECTURE.md`) completed 2026-08-04.
> **Timeframe:** 15 phases across ~3 quarters of delivery with a squad of 7–8 engineers.
> **Companion docs:** `IMPLEMENTATION_ORDER.md` (sequencing, tracks, critical path), `ARCHITECTURE_DECISIONS.md` (ADRs).
> **v1.0 → v2.0 delta:** adds Phase 0 (foundation hardening + process topology), Phase 10 (DR/data residency), Phase 14 (AI safety); pulls process isolation, OTel scaffolding, cost meters, idempotency, and the audit substrate forward from Phases 8/9/10/6/10 into Phases 0–5; splits the former monolithic Phase 12 into a standing eval platform (P4) + flywheel activation (P13); reframes the former Phase 11 connector binge as an SDK-GA program (P12); and executes ADR-T4 (AGE retirement) as owned work in Phase 0 rather than an unowned hope.

---

## 0. Executive Summary

Company Brain is currently a **functioning prototype** with the right north-star nouns (ingestion, SOP extraction, freshness, hybrid retrieval, graph, MCP skills, approval gates, OpenFGA, Temporal) but without the depth, operational discipline, or data substrate a production enterprise knowledge engine requires. This roadmap takes the repository from prototype to a world-class platform while keeping the repo **deployable at the end of every phase** and avoiding refactors that create debt.

### The nine structural truths that drive the plan

1. **The schema and the code disagree.** Several tables referenced in code (`document_chunks`, `crawled_sources.workspace_id`, a wide `execution_logs`) are missing, malformed, or duplicated. Any further feature work on top of this compounds drift. → **Phase 1 fixes this first.**
2. **The tests cannot be trusted.** Suites "pass" with zero graph/search results, hang forever when Redis is down, and there is no CI. Without trustworthy tests, no later phase can claim correctness. → **Phase 1 fixes this first.**
3. **The platform runs as one process.** Express, FastMCP, BullMQ, Temporal, and the crawler boot from a single `index.ts`. One OOM kills everything; replicas would duplicate timers/watchers; workers cannot scale independently. This is the single biggest scalability and reliability defect. → **Phase 0 fixes this before any feature track starts.**
4. **The product has no knowledge substrate.** It extracts coarse SOP blobs from a few shallow connectors. A Company Brain is built on immutable source documents → chunks → claims → entities, with provenance and confidence. → **Phases 2–4 build the substrate.**
5. **Security is mostly decorative.** OpenFGA is an in-memory Set, KMS has a hardcoded dev key, ABAC is unwired (and its IP check is a substring-match vulnerability), mock tokens exist in production code paths, and source ACLs are not captured. Enterprise buyers and safe agent execution both fail here. → **Phase 5 does real authorization in parallel with 2–4; Phase 0 removes the unsafe primitives immediately.**
6. **Deployment is aspirational.** One process boots everything, the Helm chart is broken (`_helpers.tpl` missing), there are no Dockerfiles, and there is no CI/CD, secrets, ingress, or migration runner. → **Phases 0 + 8 make it a real platform.**
7. **Several subsystems are simulated success.** Apache AGE is enabled but dead code; embeddings fall back to pseudo-vectors with zero similarity semantics; OpenAPI skills return `compiled_skill_dispatched` without executing. This is eliminated at the source, not papered over. → **Phase 0 (AGE, pseudo-vectors), Phase 7 (skills).**
8. **Observability and disaster recovery are absent, not deferred.** No OTLP export, no correlation IDs, no SLOs; no multi-region, retention, or residency plan. For a company-brain platform these are trust prerequisites. → **OTel scaffold in Phase 0, full observability in Phase 9, DR/residency in Phase 10.**
9. **AI safety and eval discipline are missing.** No prompt registry, no model-routing integration, no adversarial testing, no claim-level grounding, no feedback capture. For a platform that executes agent actions, safety gates are non-negotiable. → **Eval platform in Phase 4; dedicated AI-safety phase (14).**

### Guiding principles (non-negotiables)

- **Additive migrations only.** Never edit an applied SQL file; every change is a new numbered migration after `028`. A migration runner applies them in order, idempotently, transactionally.
- **Foundations ship early, not late.** Idempotency, cost meters, structured logging, correlation IDs, secret/dependency scanning, CIDR-correct ABAC, and process isolation are prerequisites for trustworthy feature work — they land in Phases 0–1, not in tail-end phases.
- **No simulated success.** Any place that currently fabricates success (pseudo-embeddings, mock fallbacks, compiled-but-not-executed skills, dead graph extensions, simulated adapters) is marked and eliminated in the phase where its real replacement lands.
- **Feature-flag every risky path.** New retrieval, authz, and agent runtime land behind env flags; the old path stays runnable until the new path is proven, then the flag flips, then (one phase later) the old path is deleted.
- **Expand → migrate/backfill → contract.** Columns are additive first; data is backfilled via idempotent, resumable workers; only then are old paths removed.
- **Versioned public API.** All HTTP/MCP surfaces get explicit versioning so the client and external integrations ship in lockstep without breaking drift.
- **Hermetic tests.** Unit suites run without infrastructure; integration/e2e suites gate on infra health and cannot hang; eval thresholds gate retrieval/extraction/agent/skill quality.
- **Every phase is shippable.** Each phase ends with green lint/typecheck/tests, apply-able migrations, and docs updated.
- **Idempotency everywhere by default.** No external action, webhook, or retry path ships without an idempotency key (ADR-T13).

---

## 1. Roadmap at a Glance

| # | Phase | Theme | Effort (eng-weeks) | Parallel Track | Breaking API |
|---|---|---|---|---|---|
| 0 | Foundation Hardening & Process Topology | Foundation | 8 | D0 (blocks all) | Yes (boot topology, mock-token removal) |
| 1 | Cornerstone: Schema Integrity, Migrations, Test Infrastructure & Trust Gates | Foundation | 8 | D0 (blocks all) | No |
| 2 | Connector Integration Framework & Webhook Durability | Data | 8 | A | Low (webhook responses → async 202) |
| 3 | Knowledge Corpus: Source Documents, Chunks & Claims | Data | 10 | A | Yes (search results become chunk-backed) |
| 4 | Production Retrieval, Grounded RAG & Eval Platform | AI | 9 | A | Yes (search response schema, embedding model) |
| 5 | Authorization, Source ACLs, Key Management & Audit Substrate | Security | 10 | B | Yes (authz middleware, env changes) |
| 6 | Durable Agent Runtime & Policy Engine | Agents | 10 | C | Yes (workflow execution becomes durable) |
| 7 | Executable Skill Platform | Skills | 8 | C | Yes (skills actually execute) |
| 8 | Deployable Infrastructure & Release Pipeline | Ops | 8 | D | Yes (Helm/CD/secrets) |
| 9 | Observability, Reliability, Cost Controls & Scale | Ops | 8 | D | No |
| 10 | Multi-Region, Disaster Recovery & Data Residency | Ops | 6 | D | Yes (locality constraints) |
| 11 | Compliance & Enterprise Administration (SSO/SCIM) | Enterprise | 10 | B | Yes (IdP-only auth, audit enforcement) |
| 12 | Connector SDK GA & Reference Connector Program | Data | 10 | A | Low (new providers, additive) |
| 13 | AI Quality Flywheel: Evals, Memory & Freshness | AI | 14 + ongoing | C/A | No |
| 14 | AI Safety & Red-Teaming | AI | 6 | C/B | Yes (unsafe-action gating) |

**Tracks:** A = Knowledge & Retrieval (`2→3→4`, then `12`), B = Security & Tenancy (`5`, then `11`), C = Agents & Skills (`6→7`, then `13`), D = Operations (`0→1→8→9→10`), E = AI Quality & Safety (cross-track; `4` eval platform, `13`, `14`). Tracks A/B/C start after Phase 1; Track D is continuous from Day 1.

### Critical path

```
Phase 0 ──▶ Phase 1 ──▶ Track A: 2 → 3 → 4 ──────────▶ 12
                          └─────────────────────────▶ 13 (via 4+6+9)
```

The **critical path** is `0 → 1 → 2 → 3 → 4 → (13)`. Everything customer-visible (retrieval quality, citations, evals) funnels through it. Keep the A-track resourced and unblocked above all; Phase 0/1 are on the critical path and must not slip.

---

# 2. The Phases

---

## Phase 0 — Foundation Hardening & Process Topology

### Objective
Make the platform operable and honest before anything else is built: split the monolith into isolated processes, retire the dead Apache AGE path (ADR-T4) and the pseudo-vector production fallback, remove mock tokens from production code paths, fix the CIDR/SSRF security bugs, stand up the hidden infrastructure dependencies (MinIO, Temporal, optional OpenFGA, Vault interface), and install the observability + cost-meter scaffolds every later phase debugs against.

### Business Value
Investors and enterprise reviewers validate three things first: (1) does the system actually run its retrieval and execution on real data (no fake vectors, no dead code)? (2) can it be operated and scaled as separate processes? (3) is the deploy substrate usable? Phase 0 converts "monolith demo that bootloops everything" into "a real platform skeleton" and unblocks all four tracks from Week 1 instead of Week 13.

### Technical Rationale
The former roadmap put process isolation in Phase 8 (Week 13+) — but single-process boot makes every worker/replica claim false, makes one OOM kill REST + MCP + all workers, and makes the crawler timer duplicate across replicas. Simultaneously: `022_apache_age_graph_schema.sql` enables AGE with a dead `executeCypher` RPC (operational debt, misleading claims); `aiProvider.generateEmbeddings` pads a local Ollama model and falls back to pseudo-vectors (retrieval claims are unfounded); `abacMiddleware` uses `clientIp.includes(range)` (substring-match = policy bypass); `http_adapters` can reach internal networks (no SSRF guard); mock MCP tokens and the zero-workspace seed exist in prod code paths. All are cheap to fix now, expensive to fix later.

### Features Included
- **Process-topology split** (ADR-T9 executed here, not in P8): thin entrypoints `api`, `mcp`, `crawler`, `ingestion-worker`, `temporal-worker`; boot selection via `PROCESSES` env; per-process health checks; crawler timer runs only in the crawler process; shared library code only.
- **Retire Apache AGE (ADR-T4 executed):** remove `execute_cypher_query` RPC, drop AGE references from helm/compose, commit to relational `graph_nodes`/`graph_edges` as system-of-record, add traversal + workspace-scoping indexes, add a TS graph-algorithm library (topological sort, shortest path, connected components) so no separate graph engine is needed at this scale.
- **Kill pseudo-vectors in production:** embedding provider abstraction required in prod; no pseudo-vector fallback outside unit tests; provider health surfaced on `/health` (ADR-T2 direction).
- **Remove mock tokens & demo credentials from prod code paths:** dev-only mock MCP keys and the zero-workspace seed are compiled out or refused in production; `AUTHZ_ENFORCED` skeleton mounts ABAC middleware in audit mode.
- **Fix CIDR ABAC:** replace substring matching with a real CIDR matcher (IPv4/IPv6).
- **SSRF guard:** allowlisted target hosts, private-range/loopback rejection for `http_adapters`, storage, and future OpenAPI executor.
- **Infra substrate** (removes hidden later-phase dependencies): MinIO service for ADR-T6; Temporal server + UI in compose/Helm; optional OpenFGA container behind `AUTHZ_BACKEND`; Vault (or KMS) behind the `keyProvider` interface.
- **Observability scaffold (ADR-T8 pulled forward):** OTel SDK registration, correlation-ID middleware (`req_id`/`trace_id`/`workspace_id`/`agent_id`), structured JSON logger with redaction. Export + SLOs complete in Phase 9.
- **Cost-meter scaffold (ADR-T12 pulled forward):** `usage_meters` table + `costMeter` interface wired at the LLM/embedding gate; attribution from the first AI call.
- **Root task runner (ADR-T9):** `Makefile`/`justfile` with `dev`, `lint`, `typecheck`, `build`, `test`, `migrate`, `helm-validate`.

### Files to Modify
- `server/src/index.ts` — dispatch by `PROCESSES` to entrypoints; guarded boot.
- `server/src/services/embeddings.ts` — provider-required; remove pseudo-vector fallback from prod path.
- `server/src/middleware/abacMiddleware.ts` — CIDR-correct checks.
- `server/src/services/graph/graphService.ts` + `getConnectedEntities` — fix workspace scoping gap.
- `server/src/services/integrations/http_adapters.ts` — SSRF guard + redacting client.
- `server/src/services/security/kmsEncryption.ts` — delegate to `keyProvider`.
- `docker-compose.yml`, `deploy/helm/company-brain/` — AGE removal, MinIO/Temporal/OpenFGA/Vault services.
- `server/src/services/crawler.ts` — timer only under crawler process.

### Files to Create
- `server/src/entrypoints/{api,mcpServer,crawlerMain,ingestionWorkerMain,temporalWorkerMain}.ts`
- `server/src/graph/algorithms.ts`
- `server/src/services/security/{ssrfGuard,keyProvider}.ts`
- `server/src/config/otel.ts`, `server/src/middleware/correlationId.ts`, `server/src/logger.ts`
- `server/src/services/costMeter.ts`
- `Makefile` (or `justfile`)
- `server/supabase/029_foundation_hardening.sql` (drop AGE RPC, add indexes, `usage_meters`)
- Tests: `server/test/infra/processBoot.test.ts`, `server/test/infra/ssrfGuard.test.ts`, `server/test/infra/cidrAbac.test.ts`, `server/test/graph/graphAlgorithms.test.ts`

### Database Changes
- `029_foundation_hardening.sql`: drop `execute_cypher_query`; add `graph_edges` traversal index `(workspace_id, source_id, target_id)`; add `usage_meters` (workspace_id, resource, period, units, cost_cents, alert_threshold); add `schema_migrations` placeholder compatibility notes (owned by Phase 1 runner).

### API Changes
- **Breaking:** boot topology — `PROCESSES`-based entrypoints replace single-process `npm start`.
- `/health` gains dependency status per process (Redis, Postgres, Supabase, embeddings provider, storage).
- Mock tokens structurally rejected in production.

### Background Workers
- Each worker becomes its own process/deployment boundary (deploy wiring in Phase 8).

### Infrastructure Changes
- Compose: `minio`, `temporal`, `temporal-ui`, optional `openfga`, optional `vault` services.
- Helm: remove AGE from DB image expectations; document per-process `command`.

### Tests Required
- Process boot matrix: each entrypoint starts only its workload; API has no crawler timer.
- No-pseudo-vector contract: embeddings provider offline → production path errors/empty, never fake vectors.
- CIDR allow/deny incl. IPv6; substring-bypass regression test.
- SSRF: private-range/loopback rejected across all outbound clients.
- Graph: relational traversal + algorithms + workspace scoping.
- Prod-mode boot refuses mock tokens.

### Documentation Updates
- `ARCHITECTURE.md`: process topology, AGE retired, storage/queue substrate.
- `AGENTS.md`: new commands, entrypoints, infra services.
- `README.md`: boot model, env requirements.

### Risks
- Splitting processes can expose startup races (workers before migrations) — mitigated by Phase 1 migrate runner + Phase 8 migrations Job.
- Removing pseudo-vector fallback may surface test breakage — explicitly desired (contract tests replace fake similarity).
- Adding infra services increases local setup surface — keep them optional and documented in `check-environment.mjs`.

### Dependencies
- None (this is the base). Inbound: **every** later phase needs Phase 0.

### Acceptance Criteria
- Five entrypoints boot in isolation; single-process mode removed.
- No production code path contains pseudo-vectors, AGE RPCs, or mock tokens (CI grep + boot test).
- CIDR/SSRF/workspace-scoping tests pass.
- MinIO/Temporal/OpenFGA/Vault compose services start; `check-environment.mjs` reports them.
- Structured logs carry correlation IDs; cost meter records a synthetic LLM call.

### Estimated Complexity
Medium-High (wide, not deep).

### Estimated Engineering Effort
8 eng-weeks (~2 eng × 4 wks + DevOps assist).

---

## Phase 1 — Cornerstone: Schema Integrity, Migration Runner, Test Infrastructure & Trust Gates

### Objective
Make the repository trustworthy underneath everything else: one migration pipeline that any clean database can apply in order and that re-applies safely, a test harness that cannot false-pass or hang, CI gates (lint + typecheck + build + tests) on every merge, plus the security/cost "trust gates" (secret scanning, dependency scanning, idempotency ledger) that make CI meaningful.

### Business Value
No customer or investor can trust a platform whose tests pass with zero results and whose schema contradicts its code. This phase converts "demo" into "engineering org" credibility and is a precondition for every downstream feature, bug fix, and enterprise sale. It also makes CI enforce the security baseline started in Phase 0 (no secrets in repo, no known-vulnerable dependencies, code↔schema contract).

### Technical Rationale
The audit found: `crawled_sources.workspace_id` RLS policies reference a nonexistent column; `execution_logs` is written by `workers/ingestionWorker.ts` with columns that don't exist in migration `003`; retrieval code references `document_chunks` before the tables existed (fixed in `027/028` but with ordering fragility); migration `028` exists purely to repair ordering; there is no `typecheck` script on the server and no lint; `npm test` runs a single suite and hangs without Redis; `test:e2e` and 40+ custom tsx suites are non-hermetic. The v2.0 addition: CI without secret/dependency scanning cannot credibly ship code that touches credentials and executes external APIs — these are trust gates, not nice-to-haves.

### Features Included
- **Migration runner** (`server/src/db/migrator.ts`) reading `server/supabase/*.sql` in filename order, tracking applied state in `schema_migrations`, wrapping each IDEMPOTENT file in a transaction, and exposing `migrate`, `status`, and `rollback-last` CLIs (ADR-T1).
- **Schema repair migration `030_schema_repairs.sql`** that (idempotently) adds `crawled_sources.workspace_id`, aligns `execution_logs` columns with code, adds missing indexes on `document_chunks`/`source_documents`, harmonizes RLS policies; validates by re-applying on a clean Postgres in CI.
- **Code↔schema contract test** — every `supabase.from('<t>')` table/field referenced in `server/src` resolves in the applied schema. This kills the schema-drift bug class permanently.
- **Guardrail tests** proving the full migration set applies cleanly to an ephemeral Postgres twice (fresh + re-run), plus a fresh-install path.
- **Hermetic test infrastructure:** infra-gated test bootstrap (`test/helpers/testEnv.ts`); unified `npm test` (unit, no infra), `npm run test:integration` (infra-gated), `npm run test:coverage`; hard timeouts so no suite can retry forever (ADR-T11).
- **CI pipeline** (.github/workflows/ci.yml): server lint + typecheck + build + unit tests; client lint + typecheck + build; migrations-on-ephemeral-Postgres; coverage thresholds.
- **Trust gates:** `gitleaks` secret scan, `npm audit`/OSV dependency scan, `trivy` image scan (image scan gates at Phase 8 build), all wired into CI and merge-blocking.
- **Idempotency ledger (ADR-T13 pulled forward from P6):** `idempotency_keys` table + central `idempotency.ts` module so webhook dedupe (P2) and agent execution (P6) are replay-safe from day one.
- **Lint & typecheck for server** (`eslint` + `tsc --noEmit` scripts), `typecheck` for client.
- **Boot-time infrastructure validation:** each entrypoint starts only the processes whose dependencies are present (no infinite ioredis retry), and reports dependency health on `/health`.
- **Fix `scripts/check-environment.mjs`** to check Supabase + `.env` completeness instead of Ollama (which isn't in the compose stack).

### Files to Modify
- `server/src/index.ts` — guarded boot per entrypoint, health detail, fail-fast on prod misconfig.
- `server/src/queue/ingestionQueue.ts` — lazy connection, bounded reconnect.
- `server/package.json`, `client/package.json` — typecheck/lint/test/migrate scripts.
- `scripts/check-environment.mjs` — Supabase + `.env` checks.
- `server/.env.example` — `PG_REPLICA_URL`/`CI_*` test-env vars.
- `docker-compose.yml` — optional `migrations` one-shot service.

### Files to Create
- `server/src/db/migrator.ts`, `server/src/db/migrations.ts`
- `server/supabase/030_schema_repairs.sql`
- `server/test/infra/migrations.test.ts`, `server/test/infra/schemaContract.test.ts`, `server/test/infra/envGuard.test.ts`
- `server/test/helpers/testEnv.ts`
- `server/eslint.config.js`, `server/tsconfig.typecheck.json`
- `.github/workflows/ci.yml`, `.github/workflows/security-scan.yml`
- Coverage config (`.nycrc` or vitest/c8 equivalent)

### Database Changes
- `schema_migrations(version text pk, applied_at timestamptz, checksum text)`.
- `030_schema_repairs.sql`: repair `crawled_sources.workspace_id` + RLS, align `execution_logs`, add partial indexes on `document_chunks(workspace_id, source_document_id)`, `graph_edges(source_id,target_id)`, FTS index on `document_chunks.content`.
- `idempotency_keys(key text pk, run/step/tool ref, status, result_ref, created_at)` with unique constraint.

### API Changes
- `/health` returns dependency status (Redis, Postgres, Supabase, embeddings provider, storage) with per-dep `ok|unavailable`.
- No breaking route changes.

### Background Workers
- None new. Boot code refuses to start a worker whose dependency is absent.

### Infrastructure Changes
- CI runner services (Postgres + Redis + MinIO + Temporal containers) for migration and integration suites.
- Compose: optional `migrations` service.

### Tests Required
- Migration apply-twice invariant on clean Postgres; fresh install via runner only.
- Code↔schema contract test (all table/field refs resolve).
- Migrator ordering/checksum failure unit tests.
- Env-guard: no suite hangs >N seconds; suites skip cleanly when infra absent.
- No suite "passes with zero results" silently (ADR-T11 enforcement).
- Idempotency: same key → single effect; replay rejected.

### Documentation Updates
- `README.md`: "apply 18 migrations manually" → "run `npm run migrate`"; `schema_migrations` + repair policy.
- `AGENTS.md`: new commands (migrate, test:unit, test:integration, coverage, scans).
- `ARCHITECTURE.md`: migration section → runner model.

### Risks
- Converting test execution may surface latent false-passers — fix in-phase, don't skip.
- `030` must be idempotent — apply-twice CI + additive-only policy.
- CI flakiness from infra-gating — fast unit tier + timeouts.

### Dependencies
- Phase 0 (entrypoints, infra services, observability scaffold). Inbound: **every** later phase needs Phase 1.

### Acceptance Criteria
- `docker compose up -d` + `npm run migrate` → valid schema; second run is a no-op.
- `npm run build`/`lint`/`typecheck` pass in CI on every PR; secret + dependency scans green.
- `npm test` < ~60s with no infra; integration suites self-skip.
- Code↔schema contract test passes; no silent zero-result passes.

### Estimated Complexity
Medium (wide, not deep).

### Estimated Engineering Effort
8 eng-weeks (~2 engineers × 3–4 weeks).

---

## Phase 2 — Connector Integration Framework & Webhook Durability

### Objective
Replace bespoke per-source crawlers and the fire-and-forget webhook path with a typed connector framework: `Connector`, `SyncCursor`, `SourceObject`, `SourceAcl`, `SourceDelta`, attachments, per-source queues, and an at-least-once, deduplicated (idempotency-keyed) webhook ingestion pipeline with persisted raw events.

### Business Value
This is the unlock for every additional source (Notion, Confluence, Jira, Drive, SharePoint, CRM) and the prerequisite for ACL fidelity (Phase 5). It converts ingestion from "demo data with hardcoded defaults" into a reliable, observable, resumable platform capability. Webhooks that currently dequeue but are never consumed become durable. It also defines the contract that becomes the Phase 12 SDK — the pattern is the product.

### Technical Rationale
Today `crawler.ts`/`crawlers/*.ts` hardcode channels, repos, and labels (the zero-workspace seed). Webhook routes call the LLM synchronously in the request path (slow, lossy, load-shed unsafe). There is no cursor persistence, no delta sync, no attachment handling, and no source-ACL capture. A connector contract makes new providers a catalog entry, not bespoke code, and lets workers become generic (`crawl_provider`) rather than switch-statement dispatchers. Dedupe uses the Phase 1 idempotency ledger (key = source+external_id+event_ts).

### Features Included
- **Connector contract** (`connectors/types.ts`): `listObjects()`, `fetchObject(id)`, `fetchAcl(objectId)`, `getDeltaCursor()`, `ack(objectId)`, rate-limit-aware pagination.
- **Connector registry** (`connectors/registry.ts`) with per-provider registration and capability flags; crawler/worker dispatch through the registry.
- **Sync cursor store** (`connectors/syncState.ts`): persisted per-workspace/per-provider deltas for incremental sync and resumable backfill.
- **Durable webhook pipeline:** signature verification → normalize → persist immutable `raw_source_events` → enqueue → worker consumes → dedupe (idempotency key = source+external_id+event_ts) → extract. Webhook routes return `202 {event_id}` and never call the LLM inline.
- **Attachment handling** (`connectors/attachmentFetcher.ts`): download + content-hash + store to MinIO/S3 (ADR-T6 `storageProvider`), leave parse to Phase 3.
- **Source ACL capture:** each ingested object retains a normalized `SourceAcl` (owner, viewers, teams) that feeds Phase 5.
- **Refactor existing crawlers** (Slack, GitHub, Linear, Zendesk, Gmail, Database) onto the connector interface, removing hardcoded demo defaults; config per-connection from `integration_credentials`/`webhook_subscriptions`.
- **Connector contract tests as a conformance suite** — the same suite gates Phase 12 SDK authors.

### Files to Modify
- `server/src/routes/ingestion.ts` — webhook routes → pipeline + async `202`; `/run` dispatches through registry.
- `server/src/routes/connectors.ts` — signature + workspace resolution refactor.
- `server/src/services/ingestion/webhookService.ts` — event persistence + dedupe.
- `server/src/services/crawler.ts` — iterate registered connectors; remove zero-workspace defaulting.
- `server/src/workers/ingestionWorker.ts` — generic dispatch via registry; new `webhook-events` consumer.
- `server/src/services/crawlers/*.ts` — thin adapters over the connector contract.

### Files to Create
- `server/src/connectors/{types,registry,syncState,slackConnector,githubConnector,linearConnector,zendeskConnector,gmailConnector,databaseConnector,attachmentFetcher}.ts`
- `server/src/ingestion/webhookPipeline.ts`
- `server/supabase/031_connector_sync_tables.sql`
- Tests: `server/test/connectors/{registry,slackConnector,githubConnector,cursorResume,webhookDurability}.test.ts`

### Database Changes
- `raw_source_events` (append-only webhook/event ledger).
- `sync_cursors` (workspace_id, provider, cursor_json, updated_at, checksum).
- `source_attachments` (object_key, content_hash, size, mime, storage_uri, fetched_at).
- `source_acls` extension: (source_document_id, principal_type, principal_id, permission, inherited, raw_acl, imported_at).
- `webhook_subscriptions` gains `enabled`, `consumer` refs; dedupe indexes.

### API Changes
- Webhook endpoints return `202 { event_id, status: "queued" }` (breaking for callers that expected synchronous `sop`/`message`).
- New `GET /api/ingestion/events/:event_id` (status + resulting artefacts).
- `POST /api/ingestion/run` preserved, registry-dispatched.
- New `GET /api/ingestion/connectors` (registry capabilities).

### Background Workers
- BullMQ `webhook-events` consumer queue (dedupe → ACK → extract), separate from `crawl_*`.
- Crawl jobs become registry-dispatched and cursor-resumable; per-provider rate limits via `queue/rateLimiter.ts`.

### Infrastructure Changes
- Object storage (MinIO locally; S3/GCS in cloud) — service from Phase 0; storage interface + env (`STORAGE_ENDPOINT`, `STORAGE_BUCKET`, keys).

### Tests Required
- Connector contract conformance (list/fetch/ack/cursor) on mocked HTTP.
- Pagination + rate-limit (429/Retry-After) handling.
- Cursor resume / incremental sync: second run processes only deltas.
- Webhook dedupe: same event delivered twice → one processing (idempotency-key assertion).
- Signature verification across providers; revoked-token/deleted-object graceful handling.
- Regression: existing `crawlers/*.test.ts` behavior preserved via registry.

### Documentation Updates
- `ARCHITECTURE.md`: connector model, event pipeline, capability matrix.
- `README.md`: `event_id` async semantics, connector authoring guide.
- `AGENTS.md`: worker/queue overview.

### Risks
- Refactoring working crawlers touches extraction inputs — fixture-based gold tests + `CRAWLER_V2` flag.
- Async webhooks break demo curl examples and client — update docs + `IngestionStatusWidget` to poll.
- Attachment storage adds an infra dependency — behind env flag; absent storage degrades to embedded raw payload with clear warning.

### Dependencies
- Phases 0–1. Inbound: Phase 3 (uses connectors' source objects), Phase 5 (uses `source_acls`), Phase 12 (SDK over this contract).

### Acceptance Criteria
- A clean install runs `crawl_slack`/`crawl_github`/… generically with workspace-level config, no hardcoded demo IDs.
- Two identical webhook deliveries produce exactly one extracted thread (dedupe proven by test).
- Everything resumable: killing a crawl mid-way and re-running processes only remaining objects (cursor test).
- Attachments land in storage with content hash; parse pipeline (Phase 3) consumes them.
- All existing crawler test suites pass unmodified.

### Estimated Complexity
High.

### Estimated Engineering Effort
8 eng-weeks (~2 eng × 4 wks).

---

## Phase 3 — Knowledge Corpus: Source Documents, Chunks & Claims

### Objective
Replace "SOP blobs + raw threads" as the unit of knowledge with an immutable **source document → chunk → claim → evidence** corpus, and make extraction emit versioned claims with confidence and provenance, not just coarse SOPs. This is the actual "Brain" substrate (ADR-T15).

### Business Value
Every differentiator downstream — chunk-level retrieval, per-claim citations, contradiction/staleness detection, entity resolution, workflow mining, and audit-grade provenance — depends on this layer. It separates this product from "RAG over documents" demos: the corpus becomes queryable, attributable, and mutable through governance, not a pile of LLM transcripts.

### Technical Rationale
`sourceObjects.ts` already persists `source_documents` + `document_chunks`, but retrieval still oscillates between `document_chunks`, `skills_sops`, and fabricated similarities; `sop_citations` links SOP→raw thread only; extraction emits `ExtractedSOP` with a floating `confidence_score` that is never stored. The fix: chunk persistence becomes the architectural default, store extracted claims with evidence offsets and confidence, link SOP steps back to claims/chunks, and give every artefact a hash + lineage. The graph stays relational (ADR-T4) with the entity resolver writing canonical entities/relationships.

### Features Included
- **Document pipeline** (`ingestion/documentPipeline.ts`): raw source object/attachment → parse → chunk (`ingestion/chunker.ts`) → embed → persist, invoked by webhooks, crawlers, and uploads.
- **Chunk-first storage:** consolidate writes so every document's chunks (and embeddings) are the retrieval unit; SOP records become projections over claims/chunks.
- **Claim extractor** (`knowledge/claimExtractor.ts`): LLM-driven, schema-validated decomposition of chunks into atomic operational claims (`claim_text`, `source chunk offset`, `claim_type`, `confidence`, `status`, `contradiction_flags`).
- **Claim → SOP linkage:** SOP steps reference `claim_evidence` rows; `sop_citations` gains chunk/claim references (additive).
- **Entity resolver** (`knowledge/entityResolver.ts`): canonical Person/System/Team/Role/Entity resolution with aliases, replacing the one-shot `GraphEntityTriple` inserts.
- **Upload ingestion** (`routes/documents.ts`): file upload endpoint (PDF/DOCX/XLSX/images) → parse → chunk → extract; OCR stub for Phase 12 (returns structured `ocr_required` status, not errors).
- **Consistent provenance:** every corpus row carries `source_document_id`, `content_hash`, `raw_metadata`, `workspace_id`.

### Files to Modify
- `server/src/ingestion/sourceObjects.ts` — unify chunk write path (embedding batching, retry); keep ACL writes.
- `server/src/services/extractor.ts` — emit claims + evidence + canonical entities; persist `confidence_score`; remove graph insert side-effect (moves to resolver).
- `server/src/routes/ingestion.ts` — call document pipeline; store confidence; keep `202`.
- `server/src/workers/ingestionWorker.ts` — add `parse` + `extract` job stages.
- `server/src/services/embeddings.ts` — chunk-embedding batch helpers (provider swap in Phase 4).
- `server/src/services/crawlers/*.ts` — attachments → document pipeline.
- `server/src/services/graph/graphService.ts` — accept `source_document_id` provenance from resolver.
- `server/src/routes/sops.ts` — claims endpoint; keep app shape for Phase 4.
- `server/src/services/retrieval/hybridSearch.ts` — read chunks as the primary candidate set; stop falling back to fabricated `skills_sops` similarities here.

### Files to Create
- `server/src/ingestion/documentPipeline.ts`, `server/src/knowledge/{claimExtractor,claimStore,entityResolver}.ts`
- `server/src/routes/documents.ts`
- `server/src/services/parsers/{docxParser,spreadsheetParser,ocrGateway}.ts`
- `server/supabase/036_knowledge_corpus.sql` (originally planned as `031`; 031 was taken by `usage_meters_detail`, so the corpus migration landed as 036 — the runner discovers by filename order, so numbering is the only coupling)
- Tests: `server/test/knowledge/{claimExtractor,claimProvenance,entityResolver}.test.ts`, `server/test/integration/chunkIngestion.integration.test.ts`, `server/test/routes/documents.test.ts`

### Database Changes
- `document_chunks`: add `source_object_key`, `embedding_model`, `embedding_version`, index `(workspace_id, source_document_id)`.
- `knowledge_claims` (id, workspace_id, source_document_id, chunk_id, claim_text, claim_type, confidence numeric, status, ai_generated, reviewed_by, created_at).
- `claim_evidence` (claim_id, chunk_id, char_start, char_end, source_document_id, provenance_json).
- `entities` + `entity_aliases` + `entity_relationships` (canonical, with confidence + temporal validity) — supersedes ad-hoc `graph_edges` inserts for claim-derived facts.
- `sop_citations` additive columns: `chunk_id`, `claim_id` (nullable).

### API Changes
- `POST /api/documents` (multipart upload, returns `document_id`, artefacts via status endpoint).
- `GET /api/sops/:id/claims` (claims + evidence + confidence per SOP).
- `GET /api/sops/search` begins returning chunk-level candidates (schema change; see Breaking Changes).
- `GET /api/documents/:id/status` for async parse/extract.

### Background Workers
- New `extraction` queue stages: `parse` → `chunk` → `embed` → `claims` → `resolve`, each resumable by cursor/content-hash; DLQ retained.

### Infrastructure Changes
- Object storage expanded to uploaded documents (Phase 0 MinIO/S3). No compute topology change.

### Tests Required
- Claim extraction precision/recall on gold fixtures.
- Evidence offset correctness; chunk → claim → SOP provenance walks.
- Empty/large/binary-only documents do not produce phantom SOPs.
- Upload endpoint: text PDF, DOCX, XLSX, oversized, unsupported MIME, password-protected PDF (graceful).
- Corpus invariant: every SOP step maps to ≥1 claim with evidence.
- Duplicate source object handling (same content hash → no duplicate chunks).

### Documentation Updates
- `ARCHITECTURE.md`: corpus data model (documents/chunks/claims/entities) + ER diagram.
- `README.md`: document upload + claims API.
- `COMPANY_BRAIN_CRITICAL_REVIEW.md`: corpus items done.

### Risks
- Embedding cost/throughput grows (chunks ≫ SOPs) — batch embedding, content-hash caching, per-workspace quotas (Phase 4/9).
- Extraction latency increases — parallelize claims per chunk; async pipeline already in place.
- Search candidate source change is the visible breaking change — corpus writes first, search flip behind `RETRIEVAL_V2` in Phase 4.

### Dependencies
- Phases 0–2. Inbound: Phase 4 (retrieval over corpus), Phase 5 (ACLs on corpus), Phase 6 (agents consume claims), Phase 13 (memory/freshness on claims).

### Acceptance Criteria
- Every webhook/crawl/upload ingestion creates source document + chunks + claims with confidence and evidence (integration test).
- `GET /api/sops/:id/claims` returns grounded claims for every step.
- No code path falls back to fabricated `skills_sops` similarity for a document that has chunks.
- Corpus invariant tests pass in CI without external infra for unit tiers.
- Existing SOP approval/versioning flows still work (regression suite green).

### Estimated Complexity
High.

### Estimated Engineering Effort
10 eng-weeks (~2–3 eng × 4 wks).

---

## Phase 4 — Production Retrieval, Grounded RAG & Eval Platform

### Objective
Ship a retrieval stack a CTO can trust: real embedding model, chunk-level hybrid search (dense + FTS + graph fusion), real cross-encoder reranking, per-claim citations with a grounding guardrail, and a **standing retrieval eval platform wired into CI** (nDCG/recall/cite-accuracy gates). This replaces the v1.0 arrangement where evals were a sub-bullet of the flywheel phase; they are now a first-class deliverable here because retrieval quality is the buyer-visible core (ADR-T7).

### Business Value
Retrieval quality is the customer-visible differentiator: "did the assistant find the right SOP and prove it?" Real embeddings + reranking provide the step-change from demo to product, and citation enforcement is the trust mechanism that makes agents usable in high-risk operations. A persistent eval platform (not a one-off script) keeps quality from regressing as the corpus grows — the exact failure mode of early RAG products.

### Technical Rationale
Current gaps verified in code: `generateEmbeddings` pads a local Ollama 768-dim model to "1536" and falls back to a deterministic pseudo-vector (phase-0-hardened); `hybridSearch` uses `ILIKE` for sparse despite FTS indexes existing; reranking is term-overlap arithmetic, not a cross-encoder; `groundingGuardrail` runs an LLM judge that can fail closed and stops at response level, not claim level; there is no retrieval eval corpus. This phase replaces each weak link behind flags, keeping the old path until the new one clears thresholds.

### Features Included
- **Embedding provider abstraction** (`embeddingProvider.ts`): hosted embedding API (OpenAI `text-embedding-3`, Voyage, Cohere, or OpenRouter-hosted) as primary; Ollama optional non-prod fallback; `embedding_model` + `embedding_version` recorded on every vector row; no pseudo-vectors outside unit tests (ADR-T2).
- **Embedding backfill worker:** re-embed existing SOPs/chunks idempotently by `embedding_version`, resumable, rate-limited; content-hash cache to avoid re-embedding unchanged chunks.
- **Sparse leg → Postgres FTS** over `document_chunks.content` + `skills_sops` (title/trigger), with `ts_rank` scores fed to RRF.
- **Cross-encoder reranking** (`rerankService.ts`): hosted rerank model (Cohere `rerank-v3` / OpenRouter bge-reranker) with lexical fallback; interface allows self-hosting later.
- **Chunk-first hybrid search** (`retrievalService.ts`): candidates = chunks; result = {chunk, source_document, sop projection, score, rank legs, graph_context}; output enriched with ACL fields consumed by Phase 5.
- **Citation/grounding** (`citationBuilder.ts`): each synthesized answer step must cite claim IDs + chunk offsets; `groundingGuardrail` reworked to per-claim verification with deterministic chained-citation fallback when the LLM judge is unavailable; no silent fail-open/fail-closed without log + metric.
- **Retrieval eval platform** (`evals/*`): curated queries with expected chunk/SOP gold sets; nDCG@10 + recall@10 + cite_accuracy computed via `npm run test:eval:retrieval`; thresholds enforced in CI on seeded corpus; eval result history stored for drift tracking (feeds Phase 13).
- **Result caching:** Redis cache for canonical, workspace-scoped queries (short TTL) to control provider cost/latency.

### Files to Modify
- `server/src/services/embeddings.ts` — delegate to provider; record model/version.
- `server/src/services/aiProvider.ts` — move OpenAI-compatible embed call into provider file.
- `server/src/services/retrieval/hybridSearch.ts` — chunk-first pipeline + FTS leg (behind `RETRIEVAL_V2`).
- `server/src/services/retrieval/reranker.ts` → adapter to cross-encoder service.
- `server/src/services/retrieval/graphFusion.ts` — feed real entity/claim results; fix workspace scoping on edges.
- `server/src/services/retrieval/groundingGuardrail.ts` — claim-level verification + metrics.
- `server/src/services/eval/hallucinationEvaluator.ts` — deterministic alternative + logging.
- `server/src/routes/sops.ts` — search response shape + answer endpoint.
- `server/src/services/freshness.ts` — conflict detection uses chunk embeddings + claim store.

### Files to Create
- `server/src/services/embeddingProvider.ts`, `retrieval/retrievalService.ts`, `retrieval/rerankService.ts`, `retrieval/citationBuilder.ts`
- `server/src/workers/embeddingBackfillWorker.ts`
- `server/evals/retrieval/*.jsonl`, `server/src/evals/retrievalEvalRunner.ts`
- `server/src/routes/search.ts` (result-cache-aware search endpoint)
- `server/supabase/031_fts_and_search_metadata.sql`
- Tests: `server/test/eval/retrievalEvals.test.ts`, `server/test/retrieval/{chunkRetrieval,citationBuilder,rerankFallback}.test.ts`

### Database Changes
- FTS generated columns or triggers on `document_chunks.content` (+ extending `023` indexes).
- `document_chunks`: `embedding_model`, `embedding_version`; partial `WHERE embedding_model = …` index.
- `search_events` (query, workspace_id, results_jsonl, latency, user_id, created_at) — powers feedback in Phase 13.
- `citation_checks` (answer_id, claim_id, grounded boolean, score, checked_at) for audit.

### API Changes
- `GET /api/sops/search` — **breaking**: returns `{ results: [{ chunk_id, source_document_id, sop_id?, title, content, score, rrf_score?, dense/sparse/fusion ranks, citations: [claim_id] }] }`. Old flat shape removed after one release cycle with client in lockstep.
- New `POST /api/sops/answer` — grounded synthesis endpoint with forced citations that runs the grounding guardrail.

### Background Workers
- `embedding_backfill` queue (re-embed, resumable, versioned, content-hash deduped).
- Optional nightly `retrieval_eval` runner posting scores to the metrics backend.

### Infrastructure Changes
- No topology change; requires outbound HTTPS to embeddings/rerank providers (egress allowed) and secret keys in env (Phase 8 owns secrets wiring; here env vars suffice).

### Tests Required
- Eval suite thresholds (nDCG@10 ≥ X, recall@10 ≥ Y, cite_accuracy ≥ Z) against seeded corpus; CI fails on regression or zero-results.
- No-fake-similarity test: with embeddings provider offline, production path returns empty rather than pseudo vectors (explicit contract).
- Grounding: ungrounded claim blocked; grounded passes; judge outage → deterministic fallback + metric.
- Reranker: candidate reordering relative to RRF on fixture; fallback path parity.
- FTS leg: proper term/rank behavior vs ILIKE.

### Documentation Updates
- `ARCHITECTURE.md`: retrieval pipeline (chunks, FTS, cross-encoder, citations, evals).
- `README.md`: search API examples, grounding semantics, eval commands.
- `AGENTS.md`: `npm run test:eval:*` commands and thresholds.

### Risks
- Embedding provider cost/latency — content-hash cache, batch, quotas, result caching.
- New search shape breaking external integrations — version the API (`/api/v2/sops/search`) with `v1` retained for one release.
- Rerank latency — cap candidate count (RRF top-50) before rerank; cache canonical queries.
- Model quality shifts — pin model versions via `embedding_version`; daily eval drift alert (Phase 9).

### Dependencies
- Phase 3 (corpus). Inbound: Phase 5 (ACL filtering into candidate generation), Phase 13 (feedback learning consumes `search_events`, evals reused).

### Acceptance Criteria
- Retrieval eval thresholds pass and are enforced by CI on seeded corpus.
- Search returns chunk-grounded results with citations for all results; zero fabricated similarity in production.
- Backfill worker re-embeds existing corpus to the pinned model without duplicates; resume-safe.
- `POST /api/sops/answer` blocks ungrounded claims and logs `citation_checks`.
- Old retrieval path disabled in prod behind removed flag after rollout window.

### Estimated Complexity
High.

### Estimated Engineering Effort
9 eng-weeks (~2–3 eng × 3–4 wks).

---

## Phase 5 — Authorization, Source ACLs, Key Management & Audit Substrate

### Objective
Make multi-tenancy and data authorization real: a real policy decision point (ReBAC), source-level ACL mirroring, ABAC wired into every route (CIDR-correct from Phase 0), and encryption key management without a hardcoded dev key. This phase also establishes the **append-only audit-log substrate** early so that Phases 6/7 executions are observable from day one (pulling forward what v1.0 deferred to Phase 10).

### Business Value
Enterprise adoption is blocked on two things: (1) provable cross-tenant isolation and source-ACL fidelity — "can users see only what they may see from Slack/Drive/Confluence?" — and (2) secrets handling that passes security review. This phase converts security from "scaffolding" to a defensible, audit-demonstrable capability and unblocks safe agent execution (Phase 6).

### Technical Rationale
Verified gaps: `openfgaClient.ts` is an in-memory Set with a TTL cache and **no server calls**; `getUserAccessibleDocumentIds` iterates all tuples; `abacMiddleware.ts` uses substring IP matching (Phase 0 fixed the matcher; here it becomes enforced) and isn't mounted on main routes; `kmsEncryption.ts` uses a hardcoded default key (interface from Phase 0); `hybridSearch` falls back to "role-based filter" when allowedDocIds is null — exactly the leak risk buyers fear. Phase 5 delivers a real PDP behind a clean interface (ADR-T3), ingests source ACLs from connectors, wires middleware, and replaces flat-file key handling with KMS-backed envelope encryption.

### Features Included
- **AuthorizationService interface** (`authorizationService.ts`) with two implementations:
  1. **PG-backed PDP** (`pgAuthorization.ts`) — default: RLS + `source_document_acls`/`document_permissions` + `entity_group_memberships`, `check(user, action, object)`, `listAccessible(candidateIds)`.
  2. **OpenFGA PDP** (`openfgaPdp.ts`) — real `@openfga/sdk` calls against the Phase 0 OpenFGA service (store/model lifecycle + tuple reads), behind `AUTHZ_BACKEND=openfga`.
  Both share the same decision model, cache policy (short TTL, fail closed on PDP outage), and metrics.
- **Source ACL mirror** (`connectors/aclMapper.ts` + `security/aclSync.ts`): every ingested object's `SourceAcl` (Phase 2) materializes into `source_document_acls`/group memberships; retrieval, graph traversal, and MCP tools resolve through the PDP.
- **Middleware wiring:** `enforceABAC` (CIDR-correct) + `enforceAuthorization` mounted on all tenant routes; `jwtAuth` enriched with `clearance_level`; legacy role-only fallbacks removed from `hybridSearch`/`graphFusion`/MCP.
- **Key management** (`keyProvider.ts` implementation): Vault/KMS-based KEK sourcing with **envelope encryption** (random DEK per credential, DEK encrypted by KEK); key version rotation with `secret_versions`; **no hardcoded fallback in production** (ADR-T2 alignment).
- **Secret rotation service** (`secretRotation.ts`): scheduled rotation for integration credentials with dual-encrypt/decrypt windows.
- **Append-only audit substrate** (`security/auditLedger.ts`): every sensitive action (auth decisions, approvals, executions, secrets, ACL changes) written to `audit_logs` — RLS-append-only + hash-chained from day one; Phases 6/7 log through it.
- **Fail-closed everywhere:** PDP outage → 403 (tested), with metric + log.

### Files to Modify
- `server/src/services/security/openfgaClient.ts` — replace in-memory store with PDP client (ADR-T3).
- `server/src/middleware/abacMiddleware.ts` — CIDR-correct `enforceABAC` (matcher from Phase 0) now enforced.
- `server/src/middleware/jwtAuth.ts` — clearance + PDP context propagation.
- All tenant routes (`ingestion.ts`, `sops.ts`, `integrations.ts`, `webhooks.ts`, `connectors.ts`, `documents.ts`) — mount `enforceAuthorization`.
- `server/src/services/retrieval/hybridSearch.ts`, `graphFusion.ts`, `graph/graphService.ts` — authorized candidate filtering + workspace scoping.
- `server/src/services/security/kmsEncryption.ts` — delegate to `keyProvider`.
- `server/src/services/integrations/secrets.ts`/`http_adapters.ts` — credential binding via vault.
- `server/src/services/mcp.ts` — MCP tools resolve through PDP.

### Files to Create
- `server/src/services/security/{authorizationService,pgAuthorization,openfgaPdp,aclSync,keyProvider,secretRotation,secretVault}.ts`
- `server/src/connectors/aclMapper.ts`, `server/src/security/auditLedger.ts`
- `server/src/middleware/enforceAuthorization.ts`
- `server/supabase/031_authorization_and_secrets.sql`
- Tests: `server/test/security/{crossTenantLeak,aclRetrieval,pdpFailClosed,secretRotation,cidrAbac,auditImmutability}.test.ts`, `server/test/connectors/aclMapper.test.ts`

### Database Changes
- `entity_group_memberships`, `source_document_acls` consolidated, `decision_cache` (optional), `secret_versions`, `key_metadata`.
- `audit_logs` (id, ts, actor, action, resource_type, resource_id, workspace_id, before/after jsonb, hash_chain_prev, signature) with append-only enforcement.

### API Changes
- `GET /api/admin/authorization/groups`, `POST /api/admin/authorization/grants` (admin-scoped).
- Env: `KMS_PROVIDER`, `KMS_*`/`VAULT_*`, `AUTHZ_BACKEND`, `OPENFGA_URL`/`OPENFGA_STORE_ID`.
- **Breaking:** routes require PDP context; legacy mock tokens now structurally rejected; some admin reads return 403 until grants exist.
- MCP: SOP access filtered by PDP, not trust-role alone.

### Background Workers
- `acl_sync` queue: materialize `SourceAcl`s idempotently.
- `secret_rotation` scheduled worker.

### Infrastructure Changes
- OpenFGA service (Phase 0) enabled when `AUTHZ_BACKEND=openfga`; Vault/KMS connectors (interface from Phase 0, wiring here).

### Tests Required
- Cross-tenant leak suite: member of workspace A cannot read/retrieve/graph/search workspace B artefacts under any code path.
- ACL retrieval: deny non-member, allow owner/viewer/team; nested groups.
- PDP outage → 403 fail-closed, metric emitted, no role-only fallback.
- Secret rotation: rotate mid-flight, decrypt keeps working for old blob; audit trail intact.
- CIDR ABAC: correct allow/deny including IPv6/masked ranges.
- Audit immutability: direct DB writes blocked; chain verifiable.
- MCP: low-trust agent retrieving an SOP gated by ACL even if approved.

### Documentation Updates
- `ARCHITECTURE.md`: authorization model, ACL flow, key hierarchy, audit ledger.
- `README.md`: authz backends + setup, KMS setup, admin grants API.
- `docs/security.md` (new): threat model, fail-closed guarantees, rotation runbook.

### Risks
- Wiring authz into every route can break existing flows — `AUTHZ_ENFORCED` permissive-audit mode first, then enforce.
- OpenFGA adds an ops dependency — default to PG PDP; OpenFGA optional (ADR-T3).
- Key rotation in a live system is delicate — rotate DEKs only; KEK rotation scripted with overlap window.
- ACL sync from immature connectors may be incomplete — degrade to "infer from workspace membership + source-level defaults" with visibility.

### Dependencies
- Phases 0–3 (matchers, infra, ACL capture, corpus ACL targets). Inbound: Phase 6 (tool/execution authorization + audit), Phase 10 (compliance builds on audit/ACL), Phase 14 (safety gates rely on authorization).

### Acceptance Criteria
- Cross-tenant leak suite passes on CRUD, search, graph, MCP, analytics, and documents.
- ACL mirror test: Slack/Drive-style ACL payloads materialize correctly; retrieval excludes denied chunks.
- PDP failure returns 403 and never falls through to role-only access.
- Production refuses default KMS key; rotation runs with dual-window; no plaintext secrets in DB (CI secret scan).
- Audit ledger append-only and hash-chained; Phase 6 executions land in it.

### Estimated Complexity
High.

### Estimated Engineering Effort
10 eng-weeks (~2–3 eng × 4 wks).

---

## Phase 6 — Durable Agent Runtime & Policy Engine

### Objective
Replace the fragile in-memory/Redis orchestration with a durable, auditable, idempotent agent runtime: run ledger, step state-machine, idempotency keys (ledger from Phase 1), dry-run, bound approvals, retries, compensation hooks, and a declarative policy engine replacing keyword-based auditing.

### Business Value
Safe action execution is the acceptance barrier for both internal ops teams and enterprise buyers. A runtime that survives restarts, never double-executes, requires approval for high-risk actions, and leaves an audit trail (via the Phase 5 substrate) converts "agent theater" into a governed automation platform. This is the direct enabler for MCP-driven automation customers pay for.

### Technical Rationale
`orchestrator.ts` keeps state via `persistentStore.ts` (Redis ephemeral) plus generated `wf_` ids; `executePlan` has a single HTTP retry and no idempotency; `auditor.ts` is keyword/risk-rule matching; Temporal exists but only wraps a research step and isn't the source of truth; approval tickets are consumed without a run-binding; crashes lose state. The durable runtime (ADR-T5) makes **Temporal the execution orchestrator** with a **Postgres run store** as the authoritative ledger, and keeps BullMQ for ingestion only.

### Features Included
- **Run ledger** (`runStore.ts`): `agent_runs`, `agent_steps`, `tool_invocations` — statuses, inputs/outputs (redacted), timestamps, resumable checkpoints in Postgres (crash-safe, queryable) (ADR-T15).
- **Durable workflow** (`agentWorkflow.ts` rewrite): each agent step is a Temporal Activity with retry policy and compensation hooks; HITL approval via Temporal signals bound to run+step; workflow recovery after process/Temporal restart (ADR-T5).
- **Idempotency** (`idempotency.ts`, ledger from Phase 1): every tool action carries an `idempotency_key`; adapters send `Idempotency-Key` headers where supported; replay-safe execution (ADR-T13).
- **Dry-run mode:** no-op simulation + preview persisted as `run.mode='dry_run'`; promoted to real run only with approval.
- **Policy engine** (`policyEngine.ts`): declarative, versioned rules (JSON/TS DSL) — risk classification, action allow/deny, approval requirements, quotas, blast-radius caps — replacing `auditor.ts` keyword checks; rules are data and auditable.
- **Approval binding:** `pending_approvals` gains `run_id`/`step_id` binding; consumption atomic and tied to plan+context hash.
- **Compensation** (`compensations.ts`): per-step `on_failure`/compensating action registry (reverse refund, reopen ticket) tied to steps; recorded in ledger.
- **Escalation:** human review queue + timeout → auto-escalation with readiness signal.

### Files to Modify
- `server/src/agents/orchestrator.ts` — thin entry that starts durable workflow.
- `server/src/agents/persistentStore.ts` — migrate to `runStore`; Redis for hot cache only.
- `server/src/agents/stateMachine.ts` — align states with ledger.
- `server/src/agents/auditor.ts` — replace with policy-engine evaluation.
- `server/src/agents/executor.ts` — typed tool registry + idempotency + compensation.
- `server/src/agents/planner.ts` — plan contracts with typed step schemas + policy metadata.
- `server/src/workflows/agentWorkflow.ts` + activities — durable activities, signals, retries.
- `server/src/workers/temporalWorker.ts` — always-on for agent execution.
- `server/src/services/mcp.ts` — `run_orchestrated_workflow`, `execute_sop_step` gain idempotency + run-aware approval.
- `server/src/services/integrations/http_adapters.ts` — idempotency headers, structured error taxonomy.
- `server/src/routes/sops.ts` — workflow resume/status endpoints.

### Files to Create
- `server/src/agents/{runStore,policyEngine,policyRules,toolRegistry,idempotency,compensations,humanEscalation}.ts`
- `server/src/routes/agentRuns.ts`
- `server/supabase/031_durable_agent_runtime.sql`
- Tests: `server/test/agents/{durableRuntime,resumeAfterRestart,idempotency,compensation,policyEngine,approvalBinding}.test.ts`

### Database Changes
- `agent_runs`, `agent_steps`, `tool_invocations`, `idempotency_keys` (from Phase 1, extended), `compensations`.
- `pending_approvals` + `run_id`, `step_id`, `context_hash`, `expires_at`.

### API Changes
- `POST /api/agent-runs` {query, mode, idempotency_key?} → run_id.
- `GET /api/agent-runs/:id` (ledger view), `POST /api/agent-runs/:id/resume` {approval_id?}.
- `GET /api/agent-runs/:id/steps`, `GET /api/agent-runs/:id/audit`.
- **Breaking:** `POST /api/sops/workflow` returns run_id-first envelope; Redis-backed state replaced by ledger.

### Background Workers
- Temporal becomes the durable runner (single source of execution); BullMQ kept for ingestion/crawl only (ADR-T5).
- Optional `run_cleanup` worker archiving completed runs.

### Infrastructure Changes
- Temporal namespace/task-queue sizing (service from Phase 0); run-ledger tables on Supabase.

### Tests Required
- Resume after simulated process/Temporal restart completes pending steps exactly-once.
- Duplicate approval consumption: second consume rejected; context_hash mismatch rejected.
- Retry policy: transient retried, terminal → compensating action executed once.
- Dry-run produces preview and does not invoke external adapters.
- Policy-engine fixture rules (refund cap, DB mutation, secret access) authorize/deny correctly; versioned rules roll back.
- Audit: every step/tool invocation recorded with inputs/outputs redacted per sensitivity.

### Documentation Updates
- `ARCHITECTURE.md`: durable runtime diagrams (state machine, Temporal signals, compensation).
- `README.md`: agent-runs API, dry-run demo path, policy authoring guide.
- `COMPANY_BRAIN_CRITICAL_REVIEW.md`: execution safety items.

### Risks
- Migrating orchestration to Temporal is a behavior-changing rewrite — keep `runWorkflow` behind `DURABLE_RUNTIME` until parity proven.
- Compensation for real systems is bespoke — ship compensations for the registry we control (Slack/GitHub/Stripe/Postgres); mark others "unsupported/requires human".
- Policy-engine false positives/negatives — versioned rules + eval fixtures + dry-run-first.

### Dependencies
- Phase 5 (authorization + audit for tool calls). Inbound: Phase 7 (tool execution/binding), Phase 13 (memory/eval/feedback on runs), Phase 14 (runtime safety).

### Acceptance Criteria
- A workflow pauses at approval, resumes exactly once, survives restart, produces a full ledger + audit trail (test).
- Same `idempotency_key` → single external invocation (verified against mocked adapters).
- High-risk actions require approval bound to run+context; consumption atomic.
- Compensation executes for registered steps on terminal failure; unregistered steps surface for human review.
- Legacy in-memory orchestrator decommissioned after flag flip window.

### Estimated Complexity
High.

### Estimated Engineering Effort
10 eng-weeks (~2–3 eng × 4 wks).

---

## Phase 7 — Executable Skill Platform

### Objective
Make the skill layer real: versioned, released skill packages with schemas, credential bindings, permission scopes, dry-run, and actual authenticated execution — ending the "compiled_skill_dispatched" fiction and making OpenAPI specs, SOP ASTs, and sandbox tools genuinely executable and safe.

### Business Value
Skills are how customers reuse operational knowledge as automation. Currently `register_openapi_spec` returns `compiled_skill_dispatched` metadata without executing; adapters simulate in dev. Executable, gated, audited skills turn the FastMCP surface into a product customers can wire into agents — the platform's monetizable core.

### Technical Rationale
`openApiCompiler.ts` produces `CompiledSkill` descriptors; `mcp.ts` registers them with a stub executor; `http_adapters.ts` handles only slack/github/stripe/postgres and simulates without credentials. Phase 7 delivers a **skill registry** (package lifecycle), a **tool binder** (credentials + scopes resolved at runtime through Phase 5's vault), and a **generic HTTP executor** that turns compiled OpenAPI operations into real requests with arg validation, secret-redaction, idempotency (Phase 6), and audit (Phase 5). SSRF guard from Phase 0 is mandatory.

### Features Included
- **Skill registry** (`skillRegistry.ts`): `skills`, `skill_versions`, `skill_credentials`, `skill_permissions` — draft → validated → approved → released lifecycle; rollback to prior release.
- **Package builder** (`packageBuilder.ts`): compiles SOP ASTs, OpenAPI specs, and sandbox tools into uniform skill packages (inputs, outputs, scopes, risk, idempotency, compensation, eval link).
- **OpenAPI executor** (`openApiExecutor.ts`): resolves base URL + security schemes (apiKey/bearer/oauth2 via `integration_credentials`), validates args, substitutes path/query/body, dispatches through the redacting, SSRF-guarded HTTP client, logs via `tool_invocations`.
- **Credential binding** (`toolBinder.ts`): maps skill-required scopes → stored encrypted credentials; **no env-var fallback in production**; scope check at call time.
- **Policy-gated execution:** every skill invocation runs through Phase 5 authorization + Phase 6 policy (destructive methods require approval/dry-run; dry-run default for `DELETE`).
- **Skill evaluator** (`skillEvaluator.ts`): fixture-driven dry-run evals used in CI; skill scored before release.

### Files to Modify
- `server/src/services/skills/openApiCompiler.ts` — emit full operation metadata (security, bodies, path templates, server URLs).
- `server/src/services/skills/openApiAutoDiscoverer.ts` — persist discovered specs to skill registry.
- `server/src/services/mcp.ts` — compile-time tools bound via registry; `register_openapi_spec` creates a versioned skill (still gated) that executes via the executor when approved.
- `server/src/services/skills/{sopCompiler,sandboxEngine,secureSandboxEngine,e2bSandboxEngine}.ts` — untangle engine selection.
- `server/src/services/integrations/http_adapters.ts` — retire simulated dev adapters in prod paths; unify through executor interface.
- `server/src/services/integrations/secrets.ts` — route through Phase 5 vault.

### Files to Create
- `server/src/skills/{skillRegistry,packageBuilder,toolBinder,policyCompiler,skillEvaluator}.ts`
- `server/src/services/skills/openApiExecutor.ts`, `redactingHttpClient.ts`
- `server/src/routes/skills.ts`
- `server/supabase/031_skill_registry.sql`
- Tests: `server/test/skills/{openApiExecutor,skillLifecycle,toolBinder,destructiveGate,skillEvaluator}.test.ts`, `server/evals/skills/*.jsonl`

### Database Changes
- `skills`, `skill_versions`, `skill_credentials`, `skill_permissions`.

### API Changes
- `GET /api/skills`, `GET /api/skills/:id`, `POST /api/skills/:id/release`, `POST /api/skills/:id/dry-run`, `POST /api/skills/:id/execute`.
- `POST /api/sops/auto-discover-tools` — persists; returns `skill_id`.
- MCP: `register_openapi_spec` returns skill refs; tools composed at session time from released skills; destructive ops gated + dry-run by default.
- **Breaking:** previously "registered" tools become registry-ref'd (must be released + credentials bound before execution).

### Background Workers
- Optional `skill_eval` worker for scheduled regression on released skills.

### Infrastructure Changes
- Outbound HTTPS to arbitrary service APIs (SSRF guard from Phase 0: explicit allowlisted host patterns per skill; no private-net targets by default).

### Tests Required
- OpenAPI executor against a live mock HTTP server: GET/POST/path-param/query/body/auth; header redaction verified.
- Destructive methods blocked without approval; dry-run default verified.
- Credential binding: missing scope → 403; wrong credential never sent; no env-var fallback in prod.
- Skill lifecycle: draft → validate → release → rollback.
- Skill eval fixtures protect against regression; CI enforces thresholds.
- SSRF guard: private-range hosts rejected.

### Documentation Updates
- `README.md`: skill registry + release flow + MCP usage; replace compiled-only claims.
- `ARCHITECTURE.md`: skill pipeline + security model.
- `AGENTS.md`: skill/eval commands.

### Risks
- Real HTTP execution introduces SSRF and blast radius — strict allowlists, dry-run, policy gates, redaction are mandatory.
- Breaking MCP tool behaviors — keep placeholders while gated; changelog.
- Credential sprawl — scope-based binding prevents over-permissioning; rotation via Phase 5.

### Dependencies
- Phases 5–6 (vault + authz + runtime). Inbound: Phase 13 (feedback on skill outcomes), Phase 14 (safety filters on skill tool use).

### Acceptance Criteria
- A released OpenAPI skill performs a real authenticated request against an approved target with redaction verified.
- No production code path simulates success for unconfigured credentials.
- Destructive calls gated by policy + dry-run; SSRF guard tested.
- Skill registry lifecycle + rollback works; eval thresholds enforced in CI.

### Estimated Complexity
High.

### Estimated Engineering Effort
8 eng-weeks (~2 eng × 4 wks).

---

## Phase 8 — Deployable Infrastructure & Release Pipeline

### Objective
Make Company Brain actually deployable and scalable: complete the Helm chart (helpers, secrets, ingress, HPA, migrations job, PDBs, service accounts, network policies), add Dockerfiles, and a CI/CD pipeline that builds and ships images. Process entrypoints already exist (Phase 0); here they become a production cluster.

### Business Value
Enterprise deployments, auto-scaling, and SLO-backed operations require a working Helm chart and release pipeline. This phase is what "production deployment" literally means — and it backs every stability claim the roadmap makes.

### Technical Rationale
Verified gaps: `server/src/index.ts` is now split (Phase 0) but `deploy/helm/company-brain` still has no `_helpers.tpl` (chart likely fails to render), no secret refs, no HPA resource despite `autoscaling` values, no migrations job, no ingress, readiness probes pointing at `/metrics` (wrong), and no per-process worker commands. There are no Dockerfiles despite chart image refs. The client `Nitro` build and `tsx watch` dev are undocumented for prod.

### Features Included
- **Dockerfiles:** server multi-stage (deps → build → slim runtime; non-root; distroless-style); client baked via SSR or static assets behind CDN; demo-oauth-proxy.
- **Helm chart completion:** `_helpers.tpl`; secrets via external-secrets/`secretKeyRef`; per-process deployments with `command` selection; real liveness/readiness probes (readiness JSON `/health` per process); FastMCP :8080 service; `hpa.yaml` honored; `migrations-job.yaml` running `npm run migrate` pre-rollout; PDB, serviceAccount, networkPolicy (matches Phase 0 SSRF posture), ingress/TLS; resources tuned.
- **Migration-on-deploy:** Helm Job runs the Phase 1 runner before API roll-out; blocking rollback on failed migrations.
- **CI/CD:** GitHub Actions build + push images (SBOM + trivy scan), render/validate Helm, deploy to dev/staging/prod via environment gates; image digests pinned.
- **Local parity:** `docker compose` gains `migrations` service + optional MinIO/Temporal/OpenFGA/Vault from Phase 0.
- **Secrets wiring:** env vars become `secretKeyRef` through a dedicated Secrets manifest; rotate-safe via versioned secret names.

### Files to Modify
- `deploy/helm/company-brain/values.yaml` + templates (deployment, workers, service, ingress).
- `docker-compose.yml`, `.github/workflows/*`.

### Files to Create
- `Dockerfile` (server), `client/Dockerfile`, `demo-oauth-proxy/Dockerfile`, `.dockerignore`.
- `deploy/helm/company-brain/templates/{_helpers.tpl,secrets.yaml,hpa.yaml,migrations-job.yaml,pdb.yaml,serviceaccount.yaml,networkpolicy.yaml,ingress.yaml,mcp-service.yaml}`.
- `.github/workflows/{build-and-push.yml,deploy.yml}`.
- `scripts/helm-render-check.mjs`, `scripts/verify-secrets.mjs`.

### Database Changes
- None structural. (Migrations executed by the Helm Job; runner from Phase 1.)

### API Changes
- Port/endpoint topology: REST :5001, MCP :8080, metrics :9090 (dedicated, separate from readiness).
- **Breaking:** `PROCESSES`-based boots are the only supported boot (formalized from Phase 0).

### Background Workers
- Each worker a separate deployment: `ingestion-worker` (BullMQ), `temporal-worker`, `crawler` (singleton timer — no duplicate crawls across replicas). BullMQ workers scale horizontally safely.

### Infrastructure Changes
- Image registry + CI build pipeline; per-environment Helm values; ingress/TLS; HPA on API; managed Redis/Postgres/Supabase hooks; storage backend from Phase 0/2.

### Tests Required
- Helm render validation in CI (`helm template` + assertions).
- Process-boot smoke: each entrypoint starts only its workload; `/health` reflects correct deps.
- Migration Job ordering: failure blocks rollout.
- Image security: trivy/grype low-severity threshold; non-root runtime.
- Deployment smoke (staging): REST + MCP reachable; worker consumes a queued job.
- Rollback test: deploying prior image restores services (blue-green/PB documented).

### Documentation Updates
- `README.md`: deployment guide (values, secrets, per-process), migration-on-deploy, rollback runbook.
- `deploy/helm/company-brain/README.md`, `ARCHITECTURE.md` deployment diagrams.

### Risks
- Startup races (workers before migrations) — migrations Job ordering; worker retry-on-schema-miss.
- Helm complexity — render tests + staging deploy.
- Secrets sprawl — centralize in one manifest + external-secrets option.

### Dependencies
- Phases 0–1 (entrypoints, runner). Inbound: Phase 9 (telemetry export on this topology), Phase 10 (DR/multi-region on this topology).

### Acceptance Criteria
- `helm template` renders; chart deploys to staging; migrations Job runs before API; probes correct; HPA/PDB/ingress/networkPolicy present.
- Each process isolated; crawler timer only in its deployment.
- Image build pipeline with SBOM/scan gates; digests pinned.
- Rollback by re-deploying previous image documented and exercised in staging.

### Estimated Complexity
High (breadth) / Medium (depth).

### Estimated Engineering Effort
8 eng-weeks (~2 eng × 4 wks, plus DevOps).

---

## Phase 9 — Observability, Reliability & Cost Controls

### Objective
Ship the Datadog-grade observability story promised by the Phase 0 scaffold: OpenTelemetry export, structured logs with correlation, SLOs, alerts, load/chaos testing, and per-workspace cost controls for LLM/storage spend.

### Business Value
SRE-grade visibility is table-stakes for enterprise ops and required for the audit story. Cost control for LLM calls and embeddings becomes a competitive advantage (multi-tenant pricing viability). Observability feeds Phase 13 (feedback/eval) with real usage data.

### Technical Rationale
Phase 0 installed the OTel SDK + correlation IDs + structured logger; here they get exporters, dashboards, SLOs, and fry-cost wiring. The `usage_meters` from Phase 0 grow into budget enforcement. No SLOs or dashboards exist today.

### Features Included
- **OpenTelemetry export:** OTLP to SigNoz/Lightstep/DD/AWS X-Ray/Tempo; spans across Express, BullMQ, Temporal, MCP, DB I/O; context propagation.
- **Structured logging** (`logger.ts`): JSON logs with `req_id`, `trace_id`, `workspace_id`, `agent_id`; redaction of secrets/PII; console pretty in dev.
- **SLOs & alerts:** API availability, search latency, ingestion staleness, extraction success; alert rules shipped as code; error budgets surfaced on `/metrics`.
- **Dashboards:** Grafana dashboard JSONs (API, workers, queue depth, embeddings cost per workspace, MCP tool usage).
- **Load & chaos testing:** k6 load scripts for REST + MCP; chaos experiments (kill workers, latency injection) documented; recovery validated.
- **Cost controls:** per-workspace budgets/meters (Phase 0 `usage_meters`) for LLM tokens and embedding queries; enforcement hooks at the provider gate; spend report endpoint; alert on overrun (ADR-T12).

### Files to Modify
- `server/src/middleware/telemetry.ts`, `observability.ts` — OTLP exporter path.
- `server/src/services/aiProvider.ts`/`embeddingProvider.ts` — budget enforcement.
- `server/src/workers/*` — propagate context to spans.
- `server/src/logger.ts`, `deploy/helm/company-brain/values.yaml`, `server/package.json`.

### Files to Create
- `server/src/services/{costMeter,finalize,sloRegistry}.ts`
- `server/test/load/k6/{rest-api.js,mcp.js}`, `.github/workflows/load-test.yml`
- `deploy/monitoring/grafana/*.json`, `deploy/monitoring/alerts/*.yaml`
- `docs/observability.md`, `docs/cost-controls.md`

### Database Changes
- `usage_meters` growth into `budget_limits` (workspace_id, resource, soft/hard limit, period).

### API Changes
- `GET /api/usage` (admin): per-resource cost/usage.
- `GET /metrics` (OTel Prometheus exposition); `/health` unchanged.
- Env: `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL`, `COST_BUDGETS`.

### Background Workers
- None new; existing workers fully instrumented.

### Infrastructure Changes
- OTLP backend dependency (self-hosted SigNoz or cloud); optional Grafana deployment; serviceMonitor for Prometheus scraping.

### Tests Required
- Trace/span export integration (mock OTLP collector) verifying span tree from HTTP → worker → DB.
- Correlation ID: multi-hop request carries consistent `req_id`.
- Log redaction: secrets/auth headers absent from structured logs.
- SLO evaluation + alert template render.
- Load test gates: p95 latency + error rate thresholds; chaos (worker kill) recovery.

### Documentation Updates
- `docs/observability.md`, `docs/cost-controls.md`.
- `ARCHITECTURE.md`: telemetry architecture.
- `AGENTS.md`: observability commands.

### Risks
- OTLP exporter overhead — sampling control; metric cardinality capping.
- Cost enforcement blocking legitimate use — soft-meters first, hard behind flag.
- Dashboard drift — generated ConfigMaps with golden tests.

### Dependencies
- Phases 0, 1, 8 (scaffold, topology, deployment). Inbound: Phase 10 (metrics for DR/RTO), Phase 13 (usage/feedback data).

### Acceptance Criteria
- Traces + metrics exported to a collector in staging; dashboards populated.
- Structured logs carry correlation + workspace ids; redaction test passes.
- Load test meets p95 SLO; chaos scenario recovered within RTO.
- Cost meters/budgets attribute spend per workspace; budget alerts fire in test.

### Estimated Complexity
Medium.

### Estimated Engineering Effort
6–8 eng-weeks (~2 eng × 3–4 wks).

---

## Phase 10 — Multi-Region, Disaster Recovery & Data Residency

### Objective
Add the reliability and compliance backbone an enterprise buyer expects: multi-region deployment posture, defined RPO/RTO with tested restore/failover drills, per-workspace data residency controls, and retention/legal-hold mechanics with an RPO/RTO guarantee.

### Business Value
v1.0 had no DR phase at all — a disqualifier for regulated buyers and a hidden deployment risk. This phase converts "single Supabase project" into a survivable, region-sticky platform and pre-builds the retention/DSAR metadata that Phase 11 compliance enforcement consumes.

### Technical Rationale
Rollback strategy in v1.0 claimed "PITR restore drill documented per quarter" but no phase owned it. Supabase provides PITR; the app must own backup verification, restore drills, per-workspace region pinning, and retention. Retention metadata written at ingestion time (ADR-T14) is consumed here.

### Features Included
- **DR posture:** defined RPO/RTO targets; automated restore drill (quarterly) to a sandbox verifying search + ingestion + MCP smoke; failover runbook for managed-DB region failure.
- **Multi-region readiness:** region-tagged deployments; managed-DB cross-region replication where supported; storage (MinIO/S3) region-sticky per workspace.
- **Data residency:** per-workspace region pin (tenant data must not cross borders); residency attestation endpoint for compliance; DLP/classification metadata from Phase 3 drives separation.
- **Retention:** `retention_policies` + scheduled archival/deletion with legal-hold override; DSR deletion path designed here, enforced in Phase 11.
- **Backup integrity:** periodic restore-to-sandbox verification of Postgres + Redis + storage; runbook versioned.

### Files to Modify
- `server/src/config/supabase.ts` — region-aware client selection.
- `deploy/helm/company-brain/values.yaml` — region tags, DR values.
- `scripts/` — new drill scripts.

### Files to Create
- `server/src/services/retention.ts`, `server/src/services/residency.ts`
- `server/src/routes/admin/retention.ts`, `server/src/routes/admin/residency.ts`
- `scripts/restore-drill.mjs`, `scripts/failover-drill.mjs`
- `server/supabase/031_retention_and_residency.sql`
- Tests: `server/test/ops/{retention,residency,restoreDrill}.test.ts`
- `docs/dr-runbooks/`

### Database Changes
- `retention_policies`, `retention_run_logs`, `legal_holds`, `residency_pins` (workspace_id, allowed_regions).

### API Changes
- `GET /api/admin/residency/status`, `POST /api/admin/retention/policies`.
- **Breaking (operational):** region-pinned workspaces reject ingestion from other regions.

### Background Workers
- `retention_scheduler` (daily), `restore_drill` (quarterly).

### Infrastructure Changes
- Multi-region managed-DB/storage config where vendor-supported; region-tagged ingress.

### Tests Required
- Restore drill: latest snapshot restores and passes smoke gates.
- Failover drill: regional outage → service recovers within RTO (staging).
- Residency: pinned workspace data never leaves region.
- Retention: policies applied; legal-hold overrides; no silent deletion.

### Documentation Updates
- `README.md`: DR + residency guide.
- `COMPANY_BRAIN_CRITICAL_REVIEW.md`: reliability items.

### Risks
- Supabase multi-region support varies by plan — abstract behind client selection; document single-region + PITR posture where unsupported; never over-claim.
- Restore drills cost time — run in staging; automation makes it cheap.
- Retention deletion errors are irreversible — legal-hold checks + audit before delete (Phase 5 substrate).

### Dependencies
- Phases 5 (audit), 8, 9. Inbound: Phase 11 (DSAR/retention enforcement), Phase 13 (memory must respect retention).

### Acceptance Criteria
- Restore + failover drills pass in staging with measured RTO.
- Region pinning test passes; residency attestation endpoint returns correct state.
- Retention policies apply with legal-hold override; deletions audited.

### Estimated Complexity
Medium-High.

### Estimated Engineering Effort
6 eng-weeks (~2 eng × 3 wks + SRE assistance).
---

## Phase 11 — Compliance & Enterprise Administration (SSO/SCIM)

### Objective
Deliver the compliance and administration surface enterprises require: append-only tamper-evident audit ledger (substrate from Phase 5, enforcement here), data retention/GDPR DSAR workflow (metadata from Phase 10), PII/DLP scanning, SSO (SAML/OIDC) + SCIM, an admin console, and SOC2-ready evidence.

### Business Value
This is the purchasing-blocker layer for regulated industries and Fortune 500 procurement (SOC2, GDPR, data residency, role provisioning). Because the audit substrate, retention metadata, and residency controls already exist (Phases 5/10), this phase is assembly + enforcement, not green-field.

### Technical Rationale
Current state: `execution_logs` is the only audit surface (and schema-inconsistent); no retention, DSR, DLP, SSO/SCIM; `provision_user.ts` is a script. Phase 11 institutionalizes controls on top of the Phase 5 ledger and Phase 10 retention/residency mechanics.

### Features Included
- **Append-only audit ledger enforcement** (`auditLedger.ts`): every sensitive action (auth decisions, approvals, executions, secrets, ACL changes, admin ops) written to `audit_logs` — RLS-append-only, hash-chained, exportable to SIEM. Substrate written in Phase 5; this phase enforces coverage + exports.
- **Retention engine** (`retention.ts`): retention policies (sources, workspaces, classes) enforced; scheduled archival/deletion with legal-hold override; DSR deletion path.
- **GDPR/DSAR** (`gdpr.ts`): data-subject request lifecycle (search across corpus → redact/export → delete); right-to-erasure within retention minimums.
- **DLP** (`dlp.ts`): PII/secret classification at ingestion (Phase 3 hooks), per-workspace DLP policies, quarantine with admin review.
- **SSO (SAML/OIDC) + SCIM:** IdP abstraction (`idp.ts`) mapping external identities → workspace roles; Supabase as identity store of record or OIDC-connected; SCIM endpoints for user/group lifecycle.
- **Admin console:** `/api/admin` (workspaces, users, roles, ACLs, usage, audit, retention, DLP, residency) + minimal UI screens.
- **SOC2 evidence packs:** export of audit/reviews/incidents + control mapping doc.

### Files to Modify
- `server/src/middleware/auth.ts` — IdP-aware authentication + SSO session handling.
- `server/src/scripts/provision_user.ts` — replaced by SCIM/admin provisioning.
- `server/src/config/supabase.ts` — RLS on audit tables.
- `client/` — admin screens, auth token flow via SSO session.

### Files to Create
- `server/src/security/{auditLedger,retention,dlp,gdpr,scim}.ts`, `server/src/config/idp.ts`
- `server/src/routes/{admin,retention,dsr}.ts`
- `client/src/routes/admin.tsx`
- `server/supabase/031_compliance.sql`
- Tests: `server/test/security/{auditImmutability,retention,dsr,dlp,scim}.test.ts`
- `docs/compliance/{soc2-readiness,gdpr}.md`

### Database Changes
- `audit_logs` (Phase 5) now coverage-complete; `retention_policies`, `dsr_records`, `legal_holds`, `dlp_classifications`, `scim_users`/`scim_groups` mappings.

### API Changes
- New admin/scim/dsr/retention endpoints (admin-auth).
- **Breaking:** SSO-first flow while Supabase email flow remains in permissive mode during rollout.

### Background Workers
- `retention_scheduler` (daily), `dlp_scanner` (new corpus entries), `dsr_worker` (async export/delete), `audit_archival`.

### Infrastructure Changes
- IdP tenant (Okta/AzureAD/Google Workspace); SCIM endpoints behind ingress; SIEM export sink (optional).

### Tests Required
- Audit immutability: direct DB writes blocked; chain verifiable; every mutation creates a log.
- Retention: policies applied; legal-hold overrides; deletion safe.
- DSR: export produces requested datasets; delete honors minima + audit retained.
- DLP: PII fixtures flagged/quarantined; bypass paths (search/agent) tested.
- SCIM: create/update/disable user + group propagation to workspace roles.
- SSO: SAML/OIDC fixture (mock IdP) → session → RBAC.

### Documentation Updates
- `docs/compliance/*`; `README.md` SSO/SCIM setup, admin console, retention/DSR usage.
- `COMPANY_BRAIN_CRITICAL_REVIEW.md` compliance items.

### Risks
- Audit-write-everything can be expensive — land in stages (auth/approvals/executions first).
- DLP false positives create noise — high-precision patterns + admin review queue.
- SSO rollout can break existing users — dual-mode transition; per-workspace IdP opt-in.

### Dependencies
- Phases 5 (authz/audit substrate), 9 (telemetry), 10 (retention/residency). Inbound: Phase 13 memory must respect DLP/retention; Phase 14 safety relies on SSO/RBAC.

### Acceptance Criteria
- Audit ledger append-only, tamper-evident, coverage-complete (test proves chain + block).
- Retention/DSR/DLP flows pass; legal-hold override works.
- SSO + SCIM provision a user end-to-end with role claims; SCIM disable revokes access within TTL.
- Admin console exposes workspaces, usage, audit, retention, DLP, residency; correctly gated.

### Estimated Complexity
High.

### Estimated Engineering Effort
10 eng-weeks (~2–3 eng × 4 wks).
---

## Phase 12 — Connector SDK GA & Reference Connector Program

### Objective
Pack the Phase 2 connector contract into a published SDK so connectors become a parallelizable, ecosystem effort rather than a serial engineering burden. GA the SDK with a conformance test suite, a scaffolder, and a small set of **reference connectors** (Notion, Confluence-class, Jira, Google Drive, SharePoint, Salesforce/HubSpot) plus document/OCR fuels.

### Business Value
v1.0 scheduled 14–18 eng-weeks for connector breadth — the single largest maintenance risk a reviewer flags. SDK-GA first converts connectors into independently shippable units (internal, partners, customers), unblocks enterprise accounts, and lets the corpus reach the diversity that makes the Brain valuable — without a serial multi-quarter connector queue.

### Technical Rationale
The Phase 2 contract + registry + sync cursors are the SDK; this phase productizes them. Everything the audit listed as missing (Notion, Confluence, Jira, Drive, SharePoint, CRM, full MIME, attachments, OCR) is `registry entry + OAuth install + delta cursor + ACL mapper` once the contract exists. The focus is the *pattern* + reference implementations; breadth follows as a program.

### Features Included
- **Connector SDK package** (`connectors-sdk/`): published `@companybrain/connectors` with types, registry client, sync-state client, attachment fetcher, ACL mapper, contract-test harness, and `create-connector` scaffolder.
- **Reference connectors** (each: OAuth install, cursor, fetch, ACL, attachments): Notion (block model), Confluence (CQL/spaces), Jira (workflows), Google Drive (change tokens), Microsoft SharePoint/OneDrive via Graph (drive/items/ACLs — site/group-level ACL fidelity first), Salesforce + HubSpot (records→entities/policies).
- **Deepen existing:** Slack (private channels, files, edits/deletes as invalidations), Gmail (full MIME, attachments, delta sync), GitHub (App token exchange, org/repo enumeration, PR review threads, Actions), Zendesk (pagination/ACL depth), Database (introspection, CDC-lite).
- **Document fuels:** OCR for scanned PDFs/images (`ocrGateway` becomes real), DOCX/PPTX, spreadsheet semantics, audio transcription (consent flag), all → Phase 3 corpus.
- **SDK governance:** conformance suite gates every connector (contract, ACL fidelity, rate limits, DLP tags) before marked stable.

### Files to Modify
- `server/src/connectors/registry.ts` — register SDK-authored providers.
- `server/src/routes/integrations.ts` — provider install wiring.
- `server/src/connectors/aclMapper.ts` — extend for new ACL sources.
- `server/src/services/parsers/*` — route new formats.
- `client/src/components/IntegrationsModal.tsx` — catalog expansion.

### Files to Create
- `connectors-sdk/src/{types,registry,client,syncState,attachmentFetcher,aclMapper,contractTests,scaffolder}.ts`, `connectors-sdk/package.json`
- `server/src/connectors/{notion,confluence,jira,drive,sharepoint,graphAclMapper,salesforce,hubspot}Connector.ts`
- `server/src/services/parsers/{ocrEngine,transcriptionService,spreadsheetEnhancer,slideParser}.ts`
- Per-provider `server/test/connectors/*` + `golden/` datasets
- `server/supabase/031_connector_configs.sql` (if config columns needed)

### Database Changes
- `sync_cursors` per provider (reused); `connector_configs` (oauth/tenant/app refs) if needed; no structural corpus changes.

### API Changes
- `GET /api/integrations/:provider/status`, `POST /api/integrations/:provider/connect` genericized.
- New providers additive; non-breaking.

### Background Workers
- Per-provider crawl/backfill queues (registry-dispatched); shared attachment parse queue.

### Infrastructure Changes
- Storage expansion; connector OAuth app registration docs; Microsoft Entra app setup docs.

### Tests Required
- SDK contract conformance per provider with gold fixtures; ACL payload fixtures per provider.
- Delta sync: cursor resumes; change/nextPageToken flows (Drive, Graph).
- OCR pipeline: scanned PDF → text; image → chunks; failure → `ocr_required` not crash.
- Attachment ingestion: binary → object storage → parse → corpus (idempotent).
- Transcription: consent flag enforced; diarization optional off.

### Documentation Updates
- `docs/connectors/*.md` per provider; `README.md` connector catalog + SDK authoring guide.
- `ARCHITECTURE.md`: connector matrix updated.

### Risks
- OAuth/tenant variability across providers — config tests + SDK abstractions.
- Microsoft Graph/SharePoint ACL complexity — conservative site/group-level mapping first.
- OCR/transcription infra cost — provider-neutral gateway; pay-as-you-go cloud OCR by default.

### Dependencies
- Phase 2 (framework), Phase 3 (corpus), Phase 5 (ACL mappings), Phase 11 (DLP over new sources). Inbound: Phase 13 memory/freshness over expanded corpus.

### Acceptance Criteria
- SDK published; a greenfield connector authored against it passes contract tests (dogfooded by a reference connector).
- Notion, Confluence, Jira, Drive, SharePoint, Salesforce/HubSpot pass contract + gold tests and produce chunks + ACLs end-to-end in staging.
- OCR converts a scanned PDF into text chunks in integration test.
- Slack files/edits-deletes and Gmail MIME/attachments flows tested; edits trigger invalidation/re-extract.

### Estimated Complexity
High (breadth, SDK-leveraged).

### Estimated Engineering Effort
10 eng-weeks (SDK + 2–3 reference connectors) + ongoing program.

---

## Phase 13 — AI Quality Flywheel: Evals, Memory & Freshness

### Objective
Build the self-improving AI layer: a standing evaluation platform in CI (eval component pulled forward into Phase 4; this phase scales it across extraction/grounding/policy/skills), a multi-type memory architecture (episodic/semantic/procedural), automated freshness with source-change invalidation and contradiction detection, model routing + prompt registry, and feedback learning.

### Business Value
This is the moat: quality that compounds. Evals prove correctness (sales + internal trust), memory gives longitudinal intelligence (unlike stateless RAG), and freshness/contradiction detection protects customers from acting on stale or conflicting procedures. The flywheel yields the differentiated workflow-graph/skill-generation loop competitors lack — validatable in production numbers.

### Technical Rationale
Current state: prompts are inline; `modelRouter.ts` exists but is disconnected from `aiProvider.ts`; freshness is age-based only; there is a single evaluator with one threshold; agents lack researcher/reviewer/clarifier roles; feedback isn't captured; memory types are finite. Phase 13 operationalizes the loop: measure (evals + feedback) → improve (prompts/router) → what changed (freshness) → remember (memory). It runs after corpus (P3), retrieval (P4), runtime (P6), and telemetry (P9) exist.

### Features Included
- **Evaluation platform (scaled):** case datasets (extraction, retrieval, grounding, policy, skills), runners + LLM-judge + human review queue; regression gates in CI; eval result history for drift tracking. Reuses Phase 4 eval runner; adds extraction/policy/skill suites.
- **Prompt registry** (`prompts/registry.ts`): versioned prompt templates with parameters, rollout, A/B, rollback; used by extractor, planner, policy, interview, judge.
- **Model routing integration** (`modelRouter.ts` ↔ `aiProvider.ts`): task-class → model tier (fast/quality/cost) with per-workspace policy; latency/cost meters from Phase 9; deterministic fallback chain.
- **Memory architecture** (`services/memory/*`): episodic (agent runs, actions, events — from Phase 6 ledger), semantic (chunks/claims/entities — Phase 3/4), procedural (SOPs/skills — Phase 7); memory manager agent writes episodic summaries and surfaces precedent to planners.
- **Freshness automation** (`freshness.ts` upgrade): source-change invalidations (webhook/edit events → re-extract), claim-level staleness, contradiction detection (claims with conflicting preconditions) with review queue.
- **Agent roles** (`agents/` additions): `researcher` (multi-source synthesis), `reviewer` (post-execution verification), `clarifier` (resolve ambiguity before planning), `memoryManager`; all on the durable runtime.
- **Feedback learning** (`feedbackStore.ts`, `feedbackLearning.ts`): explicit thumbs + implicit signals (click-through, re-ask, approval/rejection) into `search_events`; periodic relevance re-scoring + retrieval eval updates.
- **Client upgrades:** citation-aware answer rendering, feedback controls, memory explorer (optional), freshness dashboard.

### Files to Modify
- `server/src/services/aiProvider.ts` — router integration.
- `server/src/services/{modelRouter,freshness,extractor}.ts` — routing, invalidation, prompt-registry consumption, confidence calibration.
- `server/src/agents/{orchestrator,planner,auditor,executor}.ts` — new roles through durable runtime.
- `server/src/workflows/agentWorkflow.ts` + activities — research/review/clarify.
- `server/src/services/retrieval/retrievalService.ts` — memory re-scoring hook + feedback log.
- `client/` — citation/feedback UI.

### Files to Create
- `server/src/evals/{runner,datasets/*}.{ts,jsonl}`, `server/src/prompts/{registry,*}.ts`
- `server/src/services/{feedbackStore,feedbackLearning}.ts`, `server/src/services/memory/{episodicMemory,semanticMemory,proceduralMemory,memoryManager}.ts`
- `server/src/agents/{researcher,reviewer,clarifier}.ts`
- `server/src/routes/{feedback,evals}.ts`
- `server/supabase/031_memory_and_feedback.sql`
- Tests: `server/test/eval/{extractionEvals,policyEvals,flywheel}.test.ts`, `server/test/memory/*.test.ts`
- `docs/{evals,memory,model-routing}.md`

### Database Changes
- `feedback_events`, `eval_runs`/`eval_cases` (Phase 4 extended), `memory_episodic`, `prompt_versions`/`prompt_rollouts`, `model_policies`, `claim_refresh_state`.

### API Changes
- `POST /api/feedback` (explicit/implicit), `POST /api/eval/runs`, `GET /api/eval/runs/:id`, `GET /api/agents/summary` (admin/agent gated).
- Answer endpoint returns citations + confidence + memory annotations.

### Background Workers
- `eval_runner` (CI + scheduled), `freshness_invalidator` (event-driven), `feedback_aggregator`, `memory_writer` (episodic summarizer).

### Infrastructure Changes
- Eval corpus storage; model/provider keys per routing policy. No topology change.

### Tests Required
- Eval CI gates: extraction precision/recall, retrieval nDCG/recall, grounding, policy, skill suites with thresholds; regression detected.
- Freshness: source edit → claim/SOP invalidation → re-extract → version bump chain.
- Contradiction: conflicting preconditions detected and queued.
- Clarifier: ambiguous query → clarification round before planning (parity test).
- Feedback learning: simulated feedback re-scores retrieval fixture and passes NDCG gate.
- Model routing: task class maps to correct model; fallback chain under provider outage.

### Documentation Updates
- `docs/{evals,memory,model-routing}.md`; `ARCHITECTURE.md` memory pipeline; `README.md`.

### Risks
- Eval datasets overfit/rot — version datasets; human review; periodic recalibration.
- LLM-judge reliability — narrow judges + deterministic checks + human-in-the-loop.
- Freshness invalidation storms — batch + debounce; per-source policy.
- Memory bloat — retention policies (Phase 10) apply to episodic summaries.

### Dependencies
- Phases 3–7 (corpus, retrieval, authz, runtime, skills), Phase 9 (telemetry/usage), Phase 10 (retention constraints). Inbound: Phase 14 (safety guards on memory/feedback surfaces).

### Acceptance Criteria
- Full eval regression suite runs in CI with thresholds enforced; zero-fabrication guard retained.
- Freshness: an edit/deletion event invalidates impacted claims/SOPs and version-bumps through the pipeline, tested.
- Memory: episodic summaries accessible to planners; semantic retrieval re-scored by feedback improves NDCG on goldset.
- Clarifier/reviewer roles operational in durable runtime with audit.
- Model routing enforces cost tiers; fallback verified under simulated outage.

### Estimated Complexity
High (continuous).

### Estimated Engineering Effort
14 eng-weeks initial + ongoing (2 eng part-time via eval/feedback loops).

---

## Phase 14 — AI Safety & Red-Teaming

### Objective
Instrument the platform against the failures that sink agent products in enterprise and on investor/regulator review: prompt injection, PII leakage, unsafe action generation, grounding failures, and uncalibrated confidence. Deliver safety gates inside the runtime (Phases 6/7) and a red-teaming program for the retrieval/extraction surfaces (Phases 4/13).

### Business Value
For a platform that *executes* actions against customer systems, safety is the acceptance barrier. Every reviewer (OpenAI/Anthropic safety teams included) will probe: can a prompt-injected Slack message cause a destructive tool call? Can adversarially phrased queries exfiltrate PII? Phase 14 answers this with engineering, not policy theater, and produces the evidence the audit/SOC2 story needs.

### Technical Rationale
Current pipeline is safety-less: extraction prompt is inline and trusts source text; grounding guardrail is response-level and fail-closed-prone; policies are keyword rules; there is no rate limiting on MCP tools, no prompt-injection eval, no PII masking, no confidence calibration. Phase 14 adds layered controls enforced at runtime boundaries + adversarial test suites so safety is a CI-tested property.

### Features Included
- **Prompt-injection defense:** source-vs-instruction separation in extraction and answer pipelines; instruction-hierarchy system prompts; detection + quarantine of suspicious source payloads feeding the extractor.
- **PII/secret redaction at boundaries:** redaction (already structured-log level) extended to LLM context assembly, tool inputs/outputs, and memories — so secrets never reach model or logs (leverages Phase 5 audit redaction).
- **Unsafe-action validation:** policy engine (Phase 6) extended with blast-radius + destructive-method rules; skills (Phase 7) require dry-run by default (already spec'd); new "always-approve-list" exemption audit.
- **Grounding enforcement (from Phase 4):** claim-level grounding already required for answers, but this phase hardens post-execution verification (reviewer role) so ungrounded claims cannot drive execution.
- **Rate limiting + abuse control:** MCP tool rate limits, per-agent budgets, quota caps wired into `http_adapters` (anticipates Stripe/Datadog reviewer questions on abuse).
- **Red-teaming program:** adversarial eval suite (prompt-injection fixtures, PII-exfiltration prompts, conflicting-claim attacks, sandbox escapes) as `server/evals/safety/*` + scheduled `npm run test:eval:safety` gate in CI; results feed a safety dashboard.
- **Confidence calibration:** per-claim confidence calibration vs. human review outcomes (feeds Phase 13 feedback) so "confidence 0.4" stops being arbitrary.
- **Incident & disclosure runbook:** documented safety incident response, rollback-to-previous-flag state, and customer disclosure template.

### Files to Modify
- `server/src/services/extractor.ts` — instruction hierarchy + source-trust separation.
- `server/src/agents/policyEngine.ts` — blast-radius/destructive rules + exemption audit.
- `server/src/services/retrieval/groundingGuardrail.ts` — post-execution verification hook.
- `server/src/services/integrations/http_adapters.ts` — rate limits + quota caps + PII redaction.
- `server/src/services/mcp.ts` — per-agent budgets + rate limiting.
- `server/src/services/aiProvider.ts` — PII masking at context assembly.

### Files to Create
- `server/src/security/promptGuard.ts`, `server/src/security/piiRedactor.ts`
- `server/src/agents/safetyRules.ts` (evaluated by policy engine)
- `server/src/services/rateLimitPolicy.ts`
- `server/evals/safety/*.jsonl`, `server/src/evals/safetyEvalRunner.ts`
- `server/test/safety/{promptInjection,piiExfiltration,groundingEnforcement,unsafeAction}.test.ts`
- `docs/ai-safety.md`, `docs/incident-response.md`
- `.github/workflows/safety-eval.yml`

### Database Changes
- `safety_scan_results` (payload_hash, verdict, vector, tap rules); `rate_limit_policies`; confidence calibration table (claim_id, human_verdict).

### API Changes
- **Breaking (behavioral):** ungrounded answers blocked (already Phase 4), suspicious-source payloads quarantined, high-risk actions require explicit approval even for high-trust roles unless on an audited allowlist.
- MCP: per-agent rate limits enforced.

### Background Workers
- `safety_scanner` (background prompt-injection/PII scan for new corpus payloads), `rate_limit_enforcer` (from policies).

### Infrastructure Changes
- None essential; optional safety-dashboard surfaces in Grafana (Phase 9) and admin (Phase 11).

### Tests Required
- Prompt injection: crafted Slack/email payloads do not alter system behavior; quarantine path tested.
- PII: no secret in LLM context/log/tool output fixture; redaction test at every boundary.
- Unsafe action: DELETE/refund-style actions blocked absent approval even for high-trust role unless allowlisted (audited).
- Rate limits: over-quota agent paused with metric.
- Grounding-after-execution: reviewer blocks ungrounded execution (integration with Phase 6).

### Documentation Updates
- `docs/ai-safety.md`, `docs/incident-response.md`.
- `ARCHITECTURE.md`: safety boundaries diagram.
- `COMPANY_BRAIN_CRITICAL_REVIEW.md`: safety items.

### Risks
- Paranoia can block legitimate flows — layered gates with auditable allowlists; dry-run default; canary workspaces.
- LLM-judge-based detection has false positives — deterministic rules first, model-assisted second.
- Red-teaming can look like theater — publish metrics (injection-block rate, PII-gate rate) in the safety dashboard.

### Dependencies
- Phases 4 (grounding), 5 (authorization/audit), 6 (policy engine/runtime), 7 (skills). Inbound: none strictly; Phase 13 feedback/evals must respect safety verdicts.

### Acceptance Criteria
- Safety eval suite passes in CI; injection-block and PII-gate rates reported.
- Destructive actions blocked/dry-run by default with audited allowlist; rate-limit + budget gates enforced.
- Confidence calibration table maintained from human reviews.
- Safety incident runbook exercised once in staging.

### Estimated Complexity
Medium-High (focused depth).

### Estimated Engineering Effort
6 eng-weeks (~2 eng × 3 wks, ongoing red-team cycles).

---
## 3. Parallelization & Dependencies

### Dependency graph

```
Phase 0 ─── Phase 1 ────────────────┐
   │             │                   │
   │             ├──▶ A(2 ▶ 3 ▶ 4) ─┤──▶ 12
   │             ├──▶ B(5) ─────────┴──┐
   │             ├──▶ C(6 ▶ 7) ────────┼──▶ 13
   │             └──▶ D(8 ▶ 9 ▶ 10) ───┘──▶ 11
   └──────────────▶ E(4 eval / 13 flywheel / 14 safety) cross-track
```

Exact:
- **Phase 0** blocks all. No track starts before process isolation + infra substrate + no-fake-success foundation exists.
- **Phase 1** blocks all feature tracks. Migration runner + hermetic tests + CI + trust gates (secret/dependency scans, idempotency ledger) are prerequisites for any trustworthy feature work.
- **Track A (2→3→4)** strict sequence: connectors must exist to feed the corpus; corpus must exist before retrieval matters. Phase 12 continues on the same contract.
- **Track B (5)** begins after Phase 1 in parallel with Track A (authz touches retrieval only at integration seams). Phase 11 joins B after Phase 5, feeds on Phase 10's retention/residency.
- **Track C (6→7)** begins after Phase 1; Phase 6 needs Phase 5's authz seams at the integration boundary (develop against the interface before enforcement flips on). Phase 13 runs after 4, 6, 9 are live.
- **Track D (8→9→10)** begins after Phase 1; Phase 8 completes deployment on Phase 0's entrypoints; Phase 9 exports Phase 0's telemetry; Phase 10 makes DR/residency real on Phase 8/9 topology.
- **Track E (cross-track):** eval platform scaffolds in Phase 4; flywheel (13) activates after corpus + runtime + telemetry; safety (14) runs after the runtime/policy engine and can overlap 13.

### Which phases can be developed in parallel
- Phases 2, 5, 6, 8 (all independent after Phase 0 + 1 done-gates), respecting their tracks.
- Phase 3 and Phase 5 (corpus vs authz) — integrate at retrieval/ACL boundary only (ADR-T3 scope agreed at kickoff).
- Phase 4 and Phase 6 (retrieval vs runtime) — agents consume the retrieval interface; both behind flags.
- Phase 7 and Phase 9 (skills vs observability) — instrument together.
- Phase 12 individual connectors to each other.
- Phase 14 safety boundary work with Phase 13 feedback (share guardrails).

### Which phases block others
- Phase 0 → all. Phase 1 → all feature tracks.
- Phase 2 → 3, 12. Phase 3 → 4. Phase 4 → 13 (eval reuse), 14 (grounding).
- Phase 5 → 6 (safe execution), 11 (compliance on ACL/audit substrate), and the authorized half of 7.
- Phase 6 → 7 (tool runtime), 14 (policy engine).
- Phase 8 → 9, 10, 11 (deployment-dependent).
- Phase 9 → 11 (reporting/audit plumbing), partial on 13.
- Phase 10 → 11 (retention/residency metadata), 13 (memory retention).
- Phases 4 + 6 + 9 → 13. Phase 5 + 6 + 7 → 14.

---

## 4. Breaking Changes Inventory

| Phase | Surface | Change | Client/partner impact | Mitigation |
|---|---|---|---|---|
| 0 | Boot/topology | single-process `npm start` → per-process entrypoints; `PROCESSES` env; mock tokens removed | Deploy scripts, health checks, any prod consumer of mock keys | `PROCESSES` env; staged rollout; docs |
| 2 | Webhook API | sync response → `202 {event_id}` | Curl demo + UI assumed sync | Version endpoint; UI polls event status |
| 3 | Search/analytics | SOP-level → chunk+claim-level artefacts | Dashboard data mapping | `mapBackendSopToFrontend` updated in lockstep |
| 4 | Search response | flat SOP list → `{chunks, citations, sources}` | All search consumers incl. MCP | `v2` endpoint + `RETRIEVAL_V2` flag; old shape 1 release |
| 4 | Vector model | embedding columns re-embedded | corpus cost | backfill worker, version-aware |
| 5 | Authz | routes require PDP context; mock tokens rejected structurally; `KMS_*`/`AUTHZ_BACKEND` env | provisioned workspaces | `AUTHZ_ENFORCED` permissive→strict; migration guide for `provision_user.ts` |
| 6 | Workflow API | `runWorkflow` → ledger-backed runs; `run_id` envelope | Agent console, MCP `run_orchestrated_workflow` | `DURABLE_RUNTIME` flag; compatibility envelope |
| 7 | MCP skills | compiled-but-inert → real execution; registry/release required | agent consumers | gated registry; changelog + placeholder while unbound |
| 10 | Operations | residency-pinned workspaces reject cross-region ingestion | multi-region customers | explicit residency attestation; docs |
| 11 | Auth | SSO-first flow; Supabase email flow permissive-mode window | user login UX | dual-mode; per-workspace IdP opt-in |
| 13 | Search/answers | answer envelope adds citations/memory annotations | answer renderers | additive fields; non-breaking |
| 14 | Behavior | high-risk actions require approval even for high-trust roles unless allowlisted; suspicious payloads quarantined | agent/automation consumers | audited allowlists; dry-run default; per-role opt-in |

**Client lockstep:** every breaking server change ships with a matching `client` change in the same release.

---

## 5. Migration Strategy

1. **Additive-only migrations.** Never edit applied files. Every schema change = new file `NNN_*.sql` after `028`. Existing installs untouched; new installs apply the full sequence in order.
2. **Runner-owned apply.** Phase 1 `migrator.ts` reads `server/supabase/*.sql` in order, records `schema_migrations(version, applied_at, checksum)`, applies each in a transaction. Re-runs of applied, unchanged migrations are no-ops (ADR-T1).
3. **Expand → migrate/backfill → contract.**
   - *Expand:* add nullable columns/tables (e.g., `chunk_id`, `claim_id`, run/step tables) — old code ignores them.
   - *Migrate/backfill:* idempotent, resumable workers move/derive data (chunk embeddings in Phase 4, claims in Phase 3, ACL sync in Phase 5, run ledger in Phase 6). Cursors/version columns define progress.
   - *Contract:* after two releases, retir the old column/path (e.g., legacy `skills_sops.embedding` fallback). Dropping is scheduled, not immediate.
4. **Dual-write during transitions.** Where old code must keep working (retrieval, agent execution), write both representations until the flag flips.
5. **Read-path shadowing.** New retrieval/runtime runs in shadow mode against the same corpus; outputs diffed; switch to real only after eval thresholds.
6. **Feature-flag lifecycle.** `RETRIEVAL_V2`, `CRAWLER_V2`, `AUTHZ_ENFORCED`, `DURABLE_RUNTIME`, `SKILL_EXEC_V2`, `AUTH_IDP_*`, `SAFETY_ENFORCED`. Pattern: develop behind flag → soak → flip → (one phase later) delete legacy.
7. **Per-phase migration numbering** (post-`028`, see §7 of `IMPLEMENTATION_ORDER.md` for the canonical list):
   | Phase | Migrations |
   |---|---|
   | 0 | `029_foundation_hardening.sql` (AGE RPC drop, graph indexes, `usage_meters`, `schema_migrations` compat notes) |
   | 1 | `030_schema_repairs.sql` + migrations runner + `idempotency_keys` |
   | 2 | `031_connector_sync_tables.sql` |
    | 3 | `036_knowledge_corpus.sql` (extends through `038`: corpus + `037_sop_confidence` + `038_entity_confidence_times_seen`) |
   | 4 | `031_fts_and_search_metadata.sql` (extend into `032`) |
   | 5 | `031_authorization_and_secrets.sql` (extend into `032`) |
   | 6 | `031_durable_agent_runtime.sql` (extend into `032`) |
   | 7 | `031_skill_registry.sql` (extend into `032`) |
   | 9/10 | `032`+ — partitioning (`partitioning_and_scale.sql`), retention/residency SQL |
   | 11 | `032_compliance.sql` |
   | 12 | `032_connector_configs.sql` (if needed) |
   | 13 | `033_memory_and_feedback.sql` |
   | 14 | `033_safety.sql` (if needed) |

   **Note:** Phase 0/1 consolidation means the previously unused `029`–`031` slots are free. All new migrations must be numbered strictly after the highest applied file in the repo at authoring time; the runner + schema-contract test make collisions visible in CI.

---

## 6. Rollback Strategy

Each phase is independently revertible:

1. **Code rollback = version control + image digest.** Every phase ends at a deployable commit with pinned image digest (formalized in Phase 8).
2. **Feature-flag abort.** Risky subsystems (retrieval, authz enforcement, durable runtime, skill exec, IdP, safety) can be switched off by env flag without redeploy — legacy path retained for one release window.
3. **Database rollback = additive isolation.** Because migrations are additive, rolling back code never requires destructive SQL. "Removal" is a scheduled soft-delete/archival, never in a rollback path.
4. **Backfill jobs are re-runnable & reversible.** Workers keyed by version/cursor can pause/re-run; a bad backfill is corrected by re-running with fixed logic.
5. **Migrations Job ordering.** Phase 8/10 migrations Job runs before rollout and blocks on failure (incl. DR drills restoring a valid migration state).
6. **Backups & PITR.** Point-in-time recovery for Supabase/Postgres + Redis snapshots; restore drill automated quarterly (Phase 10 owns the drill).
7. **Compliance systems are non-reversible by design.** Audit ledger append-only; retention/DLP errors are restorable from the curation/archive store, never from deletion logs.
8. **Per-phase runbook.** Each phase lists its abort + revert steps in its doc (added as phases ship); CI provides a smoke rollback test.

---

## 7. Feature-Flag Index

| Flag | Purpose | Introduced (Phase) | Retired |
|---|---|---|---|
| `RETRIEVAL_V2` | chunk-first retrieval + FTS + citations | 4 | after 4 soaks |
| `CRAWLER_V2` | registry-dispatched connectors | 2 | after 2 |
| `AUTHZ_ENFORCED` | strict PDP enforcement (was permissive-audit) | 5 | retained (default on) |
| `DURABLE_RUNTIME` | Temporal+ledger agent runtime | 6 | after 6 |
| `SKILL_EXEC_V2` | executable skill platform | 7 | after 7 |
| `AUTH_IDP_*` | SSO/OIDC first-flow | 11 | retained per workspace |
| `SAFETY_ENFORCED` | red-team safety gates (ungrounded block, quarantine, allowlist approval) | 14 | retained (default on) |
| `EMBEDDING_PROVIDER` | hosted embeddings vs local | 4 | retained |
| `RESIDENCY_ENFORCED` | region-pin enforcement | 10 | retained per workspace |

---

## 8. Roadmap Principles Re-Check

- **Production readiness** → Phases 0, 8, 9, 10, 11; hardening is sequenced as foundation, not tail.
- **Scalability** → Phase 0 process isolation; per-track queues; resumable backfills; partitioning/replicas (9); DR (10).
- **Maintainability** → Phase 1 test/CI/trust gates; connector contract (2) + SDK (12); prompt registry (13); versioned skills (7).
- **Enterprise adoption** → Phase 5 authz/audit, Phase 10 DR/residency, Phase 11 compliance/SSO, Phase 12 connectors.
- **Developer productivity** → Phase 1 harness; migration runner; per-process entrypoints; eval commands.
- **Long-term architecture** → ADR-driven substrate (corpus/claims/run-ledger/skill-registry/memory) not bolted-on.
- **AI capability** → Phases 3–4 (corpus+retrieval), 6–7 (runtime+skills), 13 (flywheel), 14 (safety).
- **Customer value** → each phase ships usable functionality; no simulated success at the end of the roadmap.

---

## 9. Milestones & Success Signals

| Milestone | Gate | Reviewer-facing proof |
|---|---|---|
| M0 | Phase 0 + 1 done | Process-isolated boots; migrations idempotent; CI + security/dependency scans green; no fake vectors/AGE/mock tokens |
| M1 | Phase 2 + 3 done | Real connector framework + immutable corpus with claims/provenance; webhook durability proven |
| M2 | Phase 4 + 5 done | Chunk-grounded retrieval with eval thresholds; cross-tenant leak suite green; real KMS; append-only audit |
| M3 | Phase 6 + 7 done | Durable, idempotent, policy-gated agent runtime; skills actually execute with SSRF guard + redaction |
| M4 | Phase 8 + 9 + 10 done | Deployable helm/CD; OTel SLOs; load/chaos gates; DR restore/failover drills; residency + retention live |
| M5 | Phase 11 + 12 + 13 + 14 done | SOC2/GDPR surface; SSO/SCIM; connector SDK + reference program; eval-driven flywheel; safety gates + red-team metrics |
