# Company Brain — Implementation Order

> **Goal:** Sequence the 15 phases from `MASTER_ROADMAP.md` to maximize engineering velocity and minimize risk, define development tracks, the critical path, resource allocation, done-gates, and how breaking changes / migrations / rollbacks are executed in practice.
> **Status:** v2.0 — aligned to the restructured roadmap (2026-08-05). Phases renumbered 0–14; Phase 0 (foundation hardening + process topology) added; old P10→11 (compliance), old P11→12 (connector SDK), old P12→13 (flywheel), and new Phase 14 (AI safety).
> **Companion docs:** `MASTER_ROADMAP.md` (the what), `ARCHITECTURE_DECISIONS.md` (the why).

---

## 1. Execution Model

### Tracks, squads, and parallelism

| Track | Focus | Phases | Staffing | Starts when |
|---|---|---|---|---|
| **T0 · Foundation** | Process topology, schema integrity, migrations harness, CI, tests | Phases 0 → 1 | 3–4 eng (everyone) | Day 1 |
| **A · Knowledge & Retrieval** | Connectors, corpus, retrieval | Phases 2 → 3 → 4, then 12 | 2–3 eng | After Phase 1 done-gate |
| **B · Security & Tenancy** | Authorization, ACLs, KMS, audit, compliance | Phases 5, then 11 | 2 eng | After Phase 1 done-gate |
| **C · Agents & Skills** | Durable runtime, skill platform, AI flywheel, safety | Phases 6 → 7, then 13, 14 | 2 eng | After Phase 1 done-gate |
| **D · Operations** | Deploy, observability, DR/residency | Phases 8 → 9 → 10 | 2 eng (+ DevOps on contract) | After Phase 1 done-gate |
| **E · AI Quality (cross-track)** | Eval platform, flywheel, safety | Phase 4 scaffold; 13, 14 | shares C + QA | After Phases 4/6 |

Rules:
- **Exact one Phase 0 + Phase 1 delivery** for everyone, then four parallel tracks.
- **Tracks never share files mid-phase.** Where they must coordinate (retrieval×authz, runtime×authz, skills×runtime), they agree on interfaces first via ADR, use feature flags, and integrate only at defined seams.
- **A "done-gate" is required** before a track's downstream phase starts (see §4).

### Critical path

```
Phase 0 ─▶ Phase 1 ─▶ Track A: 2 → 3 → 4 ──────────▶ 12
                       └────────────────────────────▶ 13 (via 4+6+9)
```

The **critical path** is `0 → 1 → 2 → 3 → 4 → (13)`. Everything customer-visible (retrieval quality, citations, evals) funnels through it. Keep the A-track resourced and unblocked above all; Phase 0/1 are on the critical path and must not slip.

---

## 2. Phase-by-Phase Execution Order

### Milestone 0 — Kickoff (Week 0–1)
- Read-only alignment: engineer onboarding on `COMPANY_BRAIN_CRITICAL_REVIEW.md`, `ARCHITECTURE.md`, `MASTER_ROADMAP.md`, `IMPLEMENTATION_ORDER.md`.
- Agree the ADRs marked **"decide at kickoff"** in `ARCHITECTURE_DECISIONS.md` (T3, T5, T2 model/dimensions, T15 scope-of-substrate).
- Create the feature-flag inventory table; add flags to `.env.example`.
- Establish branch/protection rules + the Phase 1 CI pipeline skeleton.

---

### Phase 0 — Foundation Hardening & Process Topology (T0, Week 1–3)
Sequence inside the phase:
1. Root task runner (`Makefile`/`justfile`) + boot refactor: split `server/src/index.ts` into entrypoints (`api`, `mcp`, `crawler`, `ingestion-worker`, `temporal-worker`) selected by `PROCESSES`.
2. Retire Apache AGE: drop `execute_cypher_query` RPC (`029_foundation_hardening.sql`), remove AGE from helm/compose, add graph traversal + workspace-scoping indexes, TS graph-algorithm library.
3. Kill pseudo-vectors in production: embedding provider required; no fallback outside unit tests; provider health on `/health`.
4. Remove mock tokens/demo credentials from prod code paths; `AUTHZ_ENFORCED` skeleton in audit mode.
5. Fix CIDR ABAC (real IPv4/IPv6 matcher) + SSRF guard on `http_adapters`/storage/future executor.
6. Infra substrate: MinIO, Temporal (+UI), optional OpenFGA, Vault/`keyProvider` in compose/Helm.
7. Observability scaffold (OTel registration, correlation IDs, structured logger + redaction) + cost-meter scaffold (`usage_meters`, `costMeter` interface).
8. **Done-gate** (§4 P0): multi-process boot green; no AGE/pseudo-vector/mock-token in prod path; security tests pass; `/health` reports dependency status.

---

### Phase 1 — Cornerstone (T0, Week 4–6)
Sequence inside the phase:
1. `npm run build` both sides (establish baseline green via tsc).
2. Write migration runner (`server/src/db/migrator.ts`) + `schema_migrations`.
3. Author `030_schema_repairs.sql` (crawled_sources.workspace_id, execution_logs alignment, indexes). Validate on ephemeral PG (apply twice).
4. Add infra-aware test bootstrap; convert the hung/false-pass suites; split `test:unit` vs `test:integration`.
5. Add server lint + typecheck; client typecheck.
6. Wire CI (lint + typecheck + build + unit + migration-on-ephemeral-PG + dependency/secret scans).
7. Harden boot (guarded workers, no infinite ioredis retry); fix `check-environment.mjs`.
8. **Done-gate** (§4 P1): CI green on main; `npm test` <60s; migrate-twice idempotent.

---

### Parallel Tracks A, B, C, D start together (Week 7)

#### Phase 2 — Connector framework (Track A)
- Sequence: types/registry → sync-state → webhook pipeline + dedupe → refactor crawlers onto registry → attachments + storage → ACL payload capture.
- Flag: `CRAWLER_V2`; legacy crawlers remain importable until flip.
- Coordination with Track B: `SourceAcl` shape agreed in kickoff (ADR-T3) so Phase 5 can ingest.
- JS/Node version pinning and error-taxonomy in connector contract (dev productivity).

#### Phase 5 — Authorization, ACLs, KMS, audit substrate (Track B)
- Sequence: interface + PG-PDP → OpenFGA OPTION → ACL sync worker → middleware wiring (permissive/audit mode) → strict mode → KMS key provider + rotation → append-only audit ledger substrate → cross-tenant tests.
- Interface with Track A at retrieval ACL seam; Track C at tool-authorization seam.
- Keep `AUTHZ_ENFORCED` in audit mode until retrieval/chunk ACL ground-truth exists (from Phase 2/3 ACL data).

#### Phase 6 — Durable agent runtime (Track C)
- Sequence: run store → state machine → activity-ization → idempotency → approval binding → policy engine → compensation → dry-run.
- Flag: `DURABLE_RUNTIME`. Legacy `runWorkflow` path retained behind flag.
- Coordinate with Track B: tool authorization checks consume `AUTHZ` interface (dev-time stubs if enforcement still permissive).

#### Phase 8 — Deployable infra + release pipeline (Track D)
- Sequence: `_helpers.tpl` + chart fixes FIRST (render broken today) → image build + registry → secrets/ingress/HPA/migrations-job/probes → CI build+scan → staging deploy → release automation.
- Depends on Phase 0 topology (entrypoints already exist) and Phase 1 migrate runner (`migrations-job`).

---

#### Phase 3 — Knowledge corpus (Track A, after Phase 2 gate)
- Sequence: document pipeline → chunk consolidation → claim extractor + store → entity resolver → uploads + parsers → provenance wiring.
- Integration: retrieval reads chunks (flag `RETRIEVAL_V2` in Phase 4, but writes land here).
- Obsoletes: `skills_sops` as sole artefact; keep writing it for compat.

#### Phase 4 — Production retrieval + eval platform (Track A, after Phase 3 gate)
- Sequence: embedding provider + backfill → FTS leg → rerank service → chunk-first `retrievalService` → citation builder + grounding → eval suite + thresholds → flip `RETRIEVAL_V2`.
- **Eval platform scaffold** (Track E): eval runner + case datasets land here; CI regression gates active from this phase; scaled into Phase 13.
- Coordinated breaking change: `GET /api/sops/search` new shape shipped with matching client update in same release.

---

#### Phase 7 — Executable skills (Track C, after Phase 6 gate)
- Sequence: skill registry + lifecycle → package builder → tool binder → OpenAPI executor + redaction + SSRF guard → destructive gate + dry-run → skill evals.
- Flag: `SKILL_EXEC_V2`.
- Coordinated breaking change: `register_openapi_spec` returns registry refs.

#### Phase 9 — Observability & cost controls (Track D, after Phase 8 gate)
- Sequence: OTLP export → SLOs/alerting → dashboards → load/chaos → cost meters + admin usage endpoint (completes Phase 0 scaffold).

---

#### Phase 10 — DR & data residency (Track D, after Phases 8+9)
- Sequence: RPO/RTO targets + restore drill → failover runbook → multi-region/region-tagged deploys → residency pins + attestation → retention policies + legal hold → backup integrity verification.
- Consumes ADR-T14 retention metadata written at ingestion (Phases 2/3); feeds Phase 11 enforcement.

#### Phase 11 — Compliance & enterprise administration (Track B-lead + D assist, after 5,8,9,10)
- Sequence: audit ledger enforcement + SIEM export → retention engine → DLP → GDPR/DSAR → SSO (SAML/OIDC) + SCIM → admin console → SOC2 packs.
- Depends on 5 (authz substrate + ledger), 8 (deploy + secrets), 9 (telemetry), 10 (retention/residency mechanics).

#### Phase 12 — Connector SDK GA (Track A, after Phase 2 contract)
- Sequence: publish SDK (`@companybrain/connectors`: types, registry client, sync-state, ACL mapper, contract-test harness, scaffolder) → dogfood with reference connectors (Notion, Confluence-class, Jira, Drive, SharePoint, Salesforce/HubSpot) → OCR/transcription fuels → conformance suite gates stable status.
- Each connector independently shippable behind its own config.

#### Phase 13 — AI quality flywheel (cross-track, after 4+6+9)
- Sequence: scale eval platform (extraction/policy/skill suites) → prompt registry → model routing integration (`modelRouter.ts` ↔ `aiProvider.ts`) → feedback capture (read-wrapper on Phase 4 endpoints) → freshness invalidation + contradiction → memory types (episodic/semantic/procedural) → agent roles (researcher/reviewer/clarifier) → feedback-driven re-scoring.
- Scaffold low-risk pieces (feedback capture, eval runner) as soon as Phase 4/6 land; full activation after corpus + durable runtime + telemetry are live.

#### Phase 14 — AI safety & red-teaming (cross-track, after 5+6+7)
- Sequence: prompt-injection defense → PII/secret redaction at boundaries → unsafe-action validation (blast-radius rules on policy engine) → rate limits + quotas → red-team eval suite (`test:eval:safety` CI gate) → confidence calibration → incident runbook.
- Overlaps Phase 13; shares guardrails and the safety dashboard.

---

## 3. What Blocks What — Working Rules

**Strict blockers (cannot start):**
- Phase 1 ⇒ Phase 0 done-gate.
- Phases 2/5/6/8 ⇒ Phase 1 done-gate.
- Phase 3 ⇒ Phase 2 done-gate.
- Phase 4 ⇒ Phase 3 done-gate.
- Phase 7 ⇒ Phase 6 done-gate.
- Phase 9 ⇒ Phase 8 done-gate.
- Phase 10 ⇒ Phases 8, 9 partial gates.
- Phase 11 ⇒ Phases 5, 8, 9, 10 partial gates.
- Phase 12 ⇒ Phase 2 contract + SDK conformance.
- Phase 13 full ⇒ Phases 4, 6, 9 partial gates (scaffolding may start earlier).
- Phase 14 ⇒ Phases 5, 6, 7 partial gates.

**Soft coordination (must reserve interface, not block):**
- Phase 5 builds authz interface while Phase 3 builds corpus → agree ACL/object model in kickoff (ADR-T3).
- Phase 6 consumes retrieval while Phase 4 lands → use `retrievalService` interface; default search behind flag until flip.
- Phase 7 needs credentials from Phase 5 vault → tool binder developed against vault interface (dev-mode local backend).
- Phase 12 connectors must emit `SourceAcl` per Phase 2 contract — enforced by connector contract tests, not by sequencing.
- Phase 13 memory must respect Phase 10 retention; Phase 14 gates must not block Phase 13 legitimate flows (audited allowlists, dry-run default).

**Pre-requisite artifacts every track must produce before its first integration:**
1. IDs/keys consistent across services (workspace_id, external object IDs, event IDs, idempotency keys).
2. Error taxonomy shared (parse/extract/authz/execution error codes).
3. Feature-flag names registered centrally (single inventory in `server/.env.example`).

---

## 4. Done-Gates (Definition of Done per phase)

Every phase (and its sub-milestones) is *done* only when **all** of these hold:

| Gate | Check |
|---|---|
| Build + typecheck | `npm run build` (server + client) green; server `tsc` noEmit green |
| Lint | server eslint + client eslint green |
| Unit tests | hermetic unit tier green (<60s, no infra) |
| Integration tests | infra-gated tier green or cleanly skipped |
| Eval gates | where applicable, `npm run test:eval:*` thresholds met (P4+) |
| Migrations | apply-twice idempotent on ephemeral PG (P1+); new migrations merged, numbered after highest applied |
| Flag state | legacy path still runnable; new path behind flag; flip plan recorded |
| Client parity | any breaking API change has a client PR in the same release |
| Docs | `README.md`/`ARCHITECTURE.md`/`AGENTS.md` reflect the phase; runbook for abort/rollback |
| Deployability | staging deploy of the phase's image verified (P8+ formal; earlier = manual smoke) |

---

## 5. Resource Plan (indicative, 6–8 eng total)

| Role | Focus | Phases | Weeks |
|---|---|---|---|
| 1 | Full-stack (leads Track A) | 0, 1, 2, 3, 4, 12(part) | cont. |
| 1 | Platform/security | 0, 1, 5, 11 | cont. |
| 1 | Agent/LLM | 0, 1, 6, 7, 13, 14 | cont. |
| 1 | Ops/DevOps | 0, 1, 8, 9, 10 | focal |
| +1–2 | Feature dev (fills most-loaded track) | flex | cont. |
| 0.5 | QA/eval (writes fixtures, runs evals, chaos, red-team) | 3,4,6,7,9,12,13,14 | cont. |

Expect roughly: **~133 eng-weeks core delivery** (excluding third-party connector stdlibs) across ~3 quarters with 6–8 FTE equivalent.

---

## 6. Handling Breaking Changes in the Sequence

Protocol (applies to every phase in the "Breaking Changes Inventory" of `MASTER_ROADMAP.md`):

1. **Deprecate + dual-run first** (usually 2 releases): new endpoint/path behind flag; old path logging deprecation warnings.
2. **Land client in the same release** as the server breaking change (today the only consumer is `client/`).
3. **Cutover:** deploy both, flip flag; keep old path for the defined soak window (default 2 weeks, or 1 standard release).
4. **Post-cleanup:** remove legacy path only after soak + no rollback requests; delete flag.
5. **Document:** changelog entry + migration guide (how existing data/consumers move).

Key breaking seams and their expected first version mirror:
- Boot topology (`P0`) — `PROCESSES` env; entrypoints; staged rollout; docs.
- Webhooks async (`P2`) — same release updates `client` IngestionStatusWidget + docs curl examples.
- Search/analytics (`P3`) — `mapBackendSopToFrontend` updated in lockstep.
- Search response (`P4`) — ship `/api/v2/sops/search` + client; retire v1 after soak.
- Authz enforcement (`P5`) — audit mode → enforce; `provision_user.ts` migration doc.
- Workflow envelope (`P6`) — compatibility envelope returns `run_id` first.
- Skills (`P7`) — registry refs; placeholder message retained while credentials unbound.
- Residency (`P10`) — region-pinned workspaces reject cross-region ingestion; attestation docs.
- Auth/SSO (`P11`) — dual-mode window; per-workspace IdP opt-in.
- Safety (`P14`) — high-risk actions require approval unless allowlisted; quarantine; dry-run default.

---

## 7. Migration & Rollback Drill (recurring)

**Migration drill (every phase, CI-enforced):**
```
docker compose up -d            # postgres+redis+minio+temporal
npm run migrate                 # applier idempotent
npm run migrate                 # second run is a no-op (assert)
npm run test:migrations         # contract test code↔schema
```
Real deployments run the same path as a Helm prerollout Job (P8+).

**Rollback drill (every phase, run once in staging before marking shipped):**
1. Record current image digest + flag state.
2. Deploy previous digest (blue-green).
3. Assert health + one end-to-end flow (search + ingestion + MCP).
4. Confirm no destructive SQL ran; additive tables ignored by prior code.
5. If new data exists and must not be lost, per-phase runbook restores from dual-write copy/backup.

Every new phase ships its one-page abort/rollback note into `deploy/docs/runbooks/`.

---

## 8. Sequencing Risk Register

| Risk | Phase(s) | Response |
|---|---|---|
| Phase 0 scope creep (process split + security + infra) eats P1 budget | 0, 1 | Timebox P0 to foundation-only; push optional items (OpenFGA container, Vault) to flag-enabled backlog |
| Test harness conversion eats P1 budget | 1 | Timebox; convert false-pass suites only; leave deep e2e for later phases |
| Track A is critical path — single point of failure | 2–4 | Always ≥2 eng on A; cross-train on C when empty |
| Authz strict-mode breaks staging flows | 5 | Audit-mode soak; canary workspaces |
| Retrieval quality regression at flag-flip | 4 | Eval gates are the flip gate — never flip below thresholds |
| Runtime rewrite (Temporal) delays P7 | 6 | Keep legacy `runWorkflow` until P7 gate |
| Connector breadth magnifies maintenance | 12 | SDK-first: greenfield connector proves contract; contract tests gate all; reference program parallelizes |
| DR drills are theater | 10 | Automated restore/failover drills with measured RTO in staging; runbook versioned |
| Eval platform becomes permanent scaffolding debt | 13 | Datasets versioned; human review queue; drift tracking |
| Red-team gates block legitimate flows | 14 | Layered gates, audited allowlists, dry-run default, canary workspaces |
| Cost overruns on embeddings/LLM | 4,9,13 | Meters from P0; budgets soft-enforced; model routing caps (P13) |
| Docs drift | all | Doc changes are part of done-gate + CI markdown lint |

---

## 9. Weekly operating rhythm (after P1)

- **Mon:** eval/CI health review (thresholds, flakiness) + flag-state review.
- **Tue/Wed:** track standups on interface seams (A×B retrieval-ACL, B×C tool-authz, C×A retrieval-consumer).
- **Thu:** staging deploy of merged work; migration drill + rollback drill.
- **Fri:** done-gate review; `COMPANY_BRAIN_CRITICAL_REVIEW.md` re-baselined checklist updated.

---

## 10. Summary Sequence (one screen)

```
W0─W2    [T0] Phase 0 foundation hardening + process topology   ─ ALL tracks wait
W3─W6    [T0] Phase 1 cornerstone (migrations, tests, CI)       ─ ALL tracks wait
W7─W11   [A] P2 connectors   [B] P5 authz/KMS/audit   [C] P6 durable runtime   [D] P8 deploy+release
W12─W16  [A] P3 corpus       [B] P5 authz finish      [C] P6→P7 skills         [D] P8→P9 observability
W17─W21  [A] P4 retrieval+eval platform  [B] P11 compliance   [C] P7 finish   [D] P9→P10 DR/residency
W22─W26  [A] P12 connector SDK  [B] P11 compliance   [C/E] P13 flywheel (scaffold→active)  [D] P10 finish
Final    P11 compliance close-out, P13 flywheel active, P14 safety + red-team running
```
Milestones: **M0** = P0+P1 green (trust the code). **M1** = P2+P3 live (trust the data). **M2** = P4+P5 live (trust the retrieval + isolation). **M3** = P6+P7 live (trust the execution). **M4** = P8–P10 live (trust the operations). **M5** = P11–P14 live (enterprise-ready brain, sharp and safe).
