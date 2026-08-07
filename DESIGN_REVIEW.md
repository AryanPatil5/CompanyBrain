# Company Brain — Design Review (Principal Engineer Assessment)

**Reviewer:** Principal Engineer (simulated)
**Date:** 2026-08-05
**Verdict:** The roadmap has the right *nouns* but the *architecture, sequencing, and risk mitigation* are insufficient for a platform targeting YC/OpenAI/Anthropic/Microsoft/Palantir/Stripe/Datadog scrutiny. Major restructuring required.

---

## 1. CRITICAL ARCHITECTURAL FLAWS (Must Fix Before Any Feature Work)

### 1.1 Single-Process Monolith Masquerading as Microservices
**Problem:** `server/src/index.ts` boots Express, FastMCP, BullMQ worker, Temporal worker, AND crawler timer in one Node process.
**Impact:** One OOM/crash kills ingestion, API, MCP, AND workflows. Horizontal scaling impossible. Resource contention (CPU for LLM calls vs. I/O for crawlers). No independent deployments.
**Root Cause:** Convenience over architecture. "Dev simplicity" became production constraint.
**Fix:** **Phase 0 (new)** — Split entrypoints: `api.ts`, `mcp.ts`, `ingestion-worker.ts`, `crawler-worker.ts`, `temporal-worker.ts`. Shared library only. Dockerfiles per process. Helm deployments per component. This unblocks ALL tracks.

### 1.2 Apache AGE: Dead Code in Production Path
**Problem:** Migration 022 enables AGE; `executeCypher` RPC exists; but `graphService.ts` uses relational `graph_nodes`/`graph_edges` exclusively. AGE adds extension upgrade risk, backup complexity, zero value.
**Impact:** Operational debt; misleading architecture diagrams; Supabase version lock-in.
**Fix:** **ADR-T4 already says retire it.** Do it in Phase 0. Drop extension, remove RPC, fix `graphService` to use recursive CTEs with proper indexes. Add graph algorithm library (topological sort, shortest path, PageRank) in TypeScript — no DB extension needed.

### 1.3 Pseudo-Vectors in Production Retrieval Path
**Problem:** `embeddings.ts` falls back to deterministic pseudo-vectors when Ollama unavailable. These have ZERO semantic similarity. Code paths don't guard against this.
**Impact:** Retrieval returns random results silently. Evals can't catch it (no infra in CI). Customer demo fails mysteriously.
**Fix:** **Phase 0** — Hard fail if embedding provider unavailable in production. `EMBEDDING_PROVIDER` required env. Unit tests use fixed fixture vectors; integration tests require real provider. Remove pseudo-vector code entirely from `src/`.

### 1.4 OpenFGA: In-Memory Theater
**Problem:** `openfgaClient.ts` is a `Set` with TTL cache. `getUserAccessibleDocumentIds` iterates ALL tuples. No PDP server.
**Impact:** Authorization is effectively disabled. Cross-tenant leaks inevitable. Enterprise PoC fails security review.
**Fix:** **Phase 1 (not 5)** — Deploy OpenFGA (or SpiceDB) as sidecar in compose/Helm. Wire real SDK. PG-backed PDP as fallback (ADR-T3). Fail-closed on PDP outage. Cross-tenant test suite mandatory in CI.

### 1.5 No Idempotency in Execution — Double-Charge Risk
**Problem:** `executePlan` has one HTTP retry, no idempotency keys. Stripe/Slack/GitHub adapters don't send `Idempotency-Key`. `toolSelfHealer` retries blindly.
**Impact:** Network blip = double refund, double message, double PR comment. Unacceptable for "executable skills."
**Fix:** **Phase 1 (not 6)** — Idempotency key generator + `idempotency_keys` table with unique constraint. Every adapter MUST accept idempotency key. `http_adapters.ts` enforces it. Compensation registry for non-idempotent actions.

### 1.6 Schema Drift: Code References Tables/Columns That Don't Exist
**Problem:** `crawled_sources.workspace_id` in RLS policy but column missing. `execution_logs` written with columns not in migration 003. `document_chunks` referenced before migration 027. Migration 028 exists to fix ordering.
**Impact:** Fresh deploy fails. CI can't validate. Developers hand-edit Supabase dashboard.
**Fix:** **Phase 0** — Migration runner + contract test (code↔schema). `029_schema_repairs.sql` additive only. Never edit applied migrations.

---

## 2. MISSING PHASES (Critical Gaps)

| Missing Phase | Why Critical | Where It Belongs |
|---------------|--------------|------------------|
| **Phase 0: Infrastructure & Process Split** | Unblocks all parallel tracks; fixes single-process, AGE, pseudo-vectors, schema drift | **Before Phase 1** |
| **Phase 1.5: Security Hardening & Pen Test Prep** | AuthZ (Phase 5) useless without threat model, secret scanning, SSRF guards, rate limiting | **After Phase 1, Before Phase 2** |
| **Phase 3.5: Graph Analytics & Workflow Mining** | "Company Brain" needs graph algorithms (ownership, dependencies, centrality), not just storage | **After Phase 3, Before Phase 4** |
| **Phase 7.5: AI Safety & Red-Teaming** | Prompt injection, PII leakage, unsafe action generation — enterprise blocker | **After Phase 7, Before Phase 10** |
| **Phase 9.5: Multi-Region DR & Data Residency** | Enterprise requirement (GDPR, SOC2, BAA) | **After Phase 9, Before Phase 10** |
| **Phase 11: Connector SDK & Marketplace** | Phase 11 (14-18 weeks for connectors) is unrealistic; need extensibility framework first | **Replace Phase 11** |
| **Phase 12: Continuous Eval Flywheel** | Current Phase 12 is vague "ongoing"; needs concrete phases: eval platform → feedback loop → model routing → auto-retrain | **Split into 12a/12b/12c** |

---

## 3. UNNECESSARY / OVER-ENGINEERED PHASES

### Phase 11: Enterprise Connector Expansion (14-18 weeks)
**Problem:** Building 7+ connectors sequentially is waterfall. Each connector is independent.
**Fix:** **Connector SDK in Phase 2**. Ship Notion as reference implementation. Other connectors become parallel workstreams (external contributors, partners). Phase 11 becomes "Connector SDK GA + 3 reference connectors."

### Phase 12: AI Quality Flywheel (12+ ongoing)
**Problem:** "Ongoing" is not a phase. No milestones, no gates.
**Fix:** Split:
- **12a: Eval Platform & CI Gates** (Phase 4 parallel) — Retrieval/extraction evals, thresholds, regression detection
- **12b: Feedback Capture & Preference Learning** (Phase 7 parallel) — User corrections → golden sets → prompt optimization
- **12c: Model Routing & Cost Optimization** (Phase 9 parallel) — Task classification → tiered models → budget enforcement

---

## 4. INCORRECT ORDERING (Dependency Violations)

| Current Order | Correct Order | Reason |
|---------------|---------------|--------|
| Phase 8 (Process Isolation) → Week 5+ | **Phase 0** (Week 1) | Single-process blocks horizontal scaling, independent deploys, resource isolation |
| Phase 9 (Observability) → Week 13+ | **Phase 1** (Week 2) | Can't debug distributed system without OTel, correlation IDs, structured logs |
| Phase 5 (AuthZ) → Week 5+ | **Phase 2** (Week 3) | Connectors (Phase 2) emit ACLs; AuthZ must exist to consume them |
| Phase 1 (Schema/Migrations) → Week 1-4 | **Phase 0.5** (Week 1-2) | Migration runner needed for ALL subsequent schema changes |
| Phase 6 (Durable Runtime) → Week 9+ | **Phase 3** (Week 4) | Temporal needed for durable ingestion (Phase 2 webhook pipeline) |
| Phase 3 (Corpus) → Week 9+ | **Phase 2** (Week 3) | Corpus is the substrate; retrieval (Phase 4) and agents (Phase 6) depend on it |

---

## 5. HIDDEN DEPENDENCIES (Not Documented)

1. **Temporal Cluster** — Phase 6 assumes Temporal; Phase 8 deploys it. **Fix:** Temporal in Phase 0 compose/Helm.
2. **OpenFGA/SpiceDB** — Phase 5 assumes option; no deploy plan. **Fix:** Deploy in Phase 0 compose/Helm (optional, behind flag).
3. **Object Storage (MinIO/S3)** — Phase 2 needs it; Phase 8 adds compose service. **Fix:** MinIO in Phase 0 compose.
4. **Embedding Provider Costs** — Phase 4 adds hosted embeddings; Phase 9 adds meters. **Fix:** Cost meters in Phase 1 (before scale).
5. **Secret Manager (Vault/AWS Secrets Manager)** — Phase 5 needs KMS; Phase 8 wires secrets. **Fix:** Vault in Phase 0 compose; interface in Phase 1.
6. **Read Replicas / Connection Pooling** — Not in any phase. **Fix:** Phase 1 infra: PgBouncer, read replica config.
7. **CDC / Debezium for Real-Time Sync** — Not planned. **Fix:** Phase 3.5 for change capture from source systems.
8. **API Gateway / Rate Limiting / DDoS Protection** — Not planned. **Fix:** Phase 1 infra: Kong/Envoy or Cloudflare.

---

## 6. SCALABILITY BOTTLENECKS (Not Addressed)

| Bottleneck | Current State | Fix Phase |
|------------|---------------|-----------|
| Single-process API | All workers in one Node | Phase 0 |
| BullMQ concurrency=5 hardcoded | No autoscaling | Phase 0 (config) + Phase 8 (HPA) |
| Supabase connection pooling | None (direct connections) | Phase 1 (PgBouncer) |
| Vector search on primary | No read replica | Phase 1 (replica) + Phase 4 (embedding cache) |
| In-memory OpenFGA iteration | O(n) tuples | Phase 1 (real PDP) |
| Graph traversal recursive CTE | No indexes on `valid_from/until` | Phase 3 (indexes) |
| Embedding generation synchronous | Blocks ingestion worker | Phase 2 (async pipeline) |
| No query result caching | Every search hits DB | Phase 4 (Redis cache layer) |
| No ingestion backpressure | Webhook sync → LLM in request | Phase 2 (async 202 + queue) |

---

## 7. ENTERPRISE READINESS GAPS (Blockers for Target Audience)

| Gap | Current | Required | Phase |
|-----|---------|----------|-------|
| SSO/SAML/OIDC | Supabase Auth only | IdP federation, SCIM | Phase 10 (move to Phase 5) |
| Audit Log Immutability | `execution_logs` mutable | Append-only, cryptographic chaining | Phase 1.5 |
| Data Residency | Single Supabase project | Multi-region, tenant data locality | Phase 9.5 |
| DLP at Ingestion | None | PII detection, quarantine, admin review | Phase 3 (ingestion pipeline) |
| Retention Policies | None | Per-data-class TTL, legal hold | Phase 9.5 |
| BAA/HIPAA | No | Encryption, audit, access controls | Phase 10 |
| SOC2 Artifacts | No | Automated evidence collection | Phase 10 |
| Disaster Recovery | No backup test | RPO/RTO defined, tested quarterly | Phase 9.5 |
| Capacity Planning | No metrics | SLOs, burn-rate alerts, auto-scale | Phase 9 |
| Tenant Isolation Proof | No cross-tenant test | CI gate: leak test on every PR | Phase 1 |

---

## 8. SECURITY CONCERNS (Critical)

1. **CIDR Validation Bug** — `clientIp.includes(range)` matches `10.0.0.1` in `10.0.0.1/24` but also `10.0.0.100` in `10.0.0.1`. Use `cidr-match` library.
2. **Hardcoded Dev KMS Key** — `VAULT_SECRET_KEY` has default. Prod must fail boot without real KMS.
3. **Mock Tokens in Prod Code** — `mock-admin-token` works in dev; forbidden in prod but code paths exist. Remove entirely.
4. **SSRF in HTTP Adapters** — No allowlist for target IPs. Internal metadata endpoints accessible.
5. **Webhook Replay** — Signature verified but no replay protection (nonce/timestamp window).
6. **No Secret Scanning in CI** — `.env` patterns, keys in code not blocked.
7. **Dependency Vulnerability Scanning** — No `npm audit` / Snyk in CI.
8. **RBAC on MCP Tools** — Trust roles only; no object-level permissions. Phase 5 fixes but late.

---

## 9. AI ARCHITECTURE WEAKNESSES

1. **No Prompt Registry** — Prompts inline in `extractor.ts`, `planner.ts`, `auditor.ts`. No versioning, no A/B testing, no rollback.
2. **Model Router Disconnected** — `modelRouter.ts` exists but `aiProvider.ts` doesn't use it. Tiered fallback is hardcoded.
3. **Single Extraction LLM** — No ensemble, no self-consistency, no verification pass. Confidence 0.4 arbitrary.
4. **Grounding Guardrail Fail-Closed** — LLM judge error → blocks ALL execution. Should degrade to deterministic citation check + alert.
5. **No Retrieval Eval Corpus** — Phase 4 adds it but late. Need seeded golden queries from Day 1.
6. **Reranker = Term Overlap** — Not cross-encoder. Phase 4 fixes but behind flag; should be default.
7. **FTS Indexes Unused** — Migration 023 creates FTS; `hybridSearch` uses `ILIKE`. Fix in Phase 3.
8. **GraphRAG = String Match** — `graphFusion.ts` does `name ILIKE %entity%`. Not graph-enhanced retrieval.
9. **No Uncertainty Quantification** — Agent never says "I don't know." No clarification loop in executor.
10. **Context Window Management** — No token budgeting, no summarization, no sliding window for long conversations.

---

## 10. KNOWLEDGE GRAPH WEAKNESSES

1. **AGE Dead Code** — Remove in Phase 0.
2. **No Entity Resolution** — Same person = multiple nodes. Need canonicalization (Phase 3).
3. **No Graph Algorithms** — Can't answer "who owns X", "what depends on Y", "critical path". Add in Phase 3.5.
4. **Temporal Edges Unused** — `valid_from/valid_until` on edges but traversal ignores them.
5. **Workspace Scoping Missing** — `getConnectedEntities` queries edges without workspace filter (cross-tenant leak).
6. **Ontology = Allowlist** — `ontologyCompiler.ts` has hardcoded types. No versioned ontology model.
7. **No Provenance on Edges** — `source_document_id` on edges but not used in trust scoring.

---

## 11. MEMORY ARCHITECTURE WEAKNESSES

| Memory Type | Current | Required |
|-------------|---------|----------|
| **Episodic** | `execution_logs` only | Episode reconstruction: task→plan→steps→outcomes→feedback |
| **Semantic** | SOP embeddings only | Chunk/claim/entity embeddings with provenance |
| **Procedural** | Static SOPs | Learned from execution: success patterns, compensation paths |
| **Working** | None | Agent scratchpad, tool results, intermediate reasoning |
| **Consolidation** | None | Nightly job: episodes → claims → ontology updates |
| **Forgetting** | None | Staleness → archive → delete (with legal hold) |

**Fix:** Phase 3 (corpus) + Phase 6 (runtime) + Phase 12c (consolidation flywheel).

---

## 12. MULTI-AGENT ARCHITECTURE ISSUES

1. **Tight Coupling** — `orchestrator.ts` directly calls `planner.ts`, `auditor.ts`, `executor.ts`. No message bus.
2. **No Independent Researcher** — Temporal activity calls search but doesn't synthesize independently.
3. **No Memory Manager Agent** — No agent responsible for writing/reading memory.
4. **No Inter-Agent Protocol** — Direct function calls; can't distribute, can't observe.
5. **No Agent Evaluation** — Can't measure planner quality, auditor precision, executor success rate.
6. **Shared State = Redis Keys** — Ad-hoc, no schema, no TTL discipline.
7. **No Least-Privilege Tool Access** — All agents see all tools. Auditor should only read; executor only write.

**Fix:** Phase 6 redesign — Agent framework with message bus, capability-based tool access, shared run ledger.

---

## 13. DATA MODEL ISSUES

1. **`skills_sops` as Central Table** — Should be a PROJECTION over claims/chunks. Inverted dependency.
2. **`execution_logs` Schema Mismatch** — Code writes `workspace_id`, `step_execution_id`, `target_system`, `status`, `input_payload`, `output_payload`, `error_message`, `executed_at`; migration 003 has only `sop_id`, `agent_id`, `tool_name`, `input_params`, `outcome`.
3. **No Soft Deletes** — Hard deletes lose audit trail. Add `deleted_at` + `deleted_by` on all entity tables.
4. **JSONB Overuse** — `execution_steps`, `sop_ast`, `endpoint_config`, `properties` — no schema enforcement, query performance issues.
5. **No Partitioning Strategy** — `raw_threads`, `document_chunks`, `execution_logs` will exceed 100GB. Need time-based partitioning.
6. **Embedding on Wrong Table** — `skills_sops.embedding` should be on `document_chunks`.
7. **No Vector Index Maintenance** — HNSW degrades with inserts. Need `REINDEX` schedule or `pgvector` 0.5.1+ incremental.

---

## 14. DEPLOYMENT RISKS

1. **Helm Chart Broken** — `_helpers.tpl` missing. `helm template` fails.
2. **No Dockerfiles** — Can't build images. Multi-stage build needed (dev vs prod).
3. **No Secrets Management** — `.env` in container = leaked secrets. Need Vault/SealedSecrets/External Secrets Operator.
4. **No Ingress/TLS** — No cert-manager, no TLS termination config.
5. **No HPA Config** — Manual replica counts only.
6. **No Migration Job** — Helm hook for `npm run migrate` missing.
7. **No Readiness/Liveness Probes** — K8s can't manage pod lifecycle.
8. **Single Supabase Project** — No failover, no multi-region, vendor lock-in.
9. **No CDN for Client** — Static assets served from API pod.

---

## 15. MIGRATION RISKS

1. **Manual Supabase SQL Editor** — Human error, no audit trail, no rollback.
2. **Migration 028 Exists to Fix Ordering** — Process failure admitted.
3. **No Migration Runner** — Can't automate in CI/CD.
4. **No Down Migrations** — Can't rollback broken migration.
5. **Additive-Only Policy Violated** — Migrations delete columns (e.g., 011 removes workspace bypass).
6. **No Migration Testing in CI** — Broken migrations reach production.
7. **No Schema Contract Test** — Code↔schema drift undetected.

---

## 16. TESTING GAPS

| Gap | Current | Required |
|-----|---------|----------|
| Test Framework | Custom tsx runners | Vitest (unit) + Playwright (e2e) + custom eval runner |
| Hermetic Unit Tests | None (all hit infra) | All unit tests mock external deps; <60s total |
| Integration Tests | Hang without Redis/PG | Infra-gated; skip cleanly; testcontainers in CI |
| Contract Tests | None | API schema (OpenAPI), DB schema (code↔migration) |
| Load Tests | None | k6 scenarios: ingestion, search, MCP, workflow |
| Chaos Tests | None | Pod kill, network partition, DB failover, Redis OOM |
| Security Tests | None | SAST (Semgrep), DAST, dependency scan, secret scan |
| Migration Tests | None | Apply-twice on ephemeral PG in CI |
| Cross-Tenant Leak Tests | None | Mandatory CI gate |
| Eval Regression Tests | None | Retrieval/extraction thresholds in CI |

---

## 17. OPERATIONAL RISKS

1. **No Structured Logging** — `console.log` + `pino` mixed; no correlation IDs across REST/MCP/Temporal.
2. **No Distributed Tracing** — OTel not implemented. Can't debug cross-service latency.
3. **No SLOs/SLIs** — No reliability targets (latency p99, error rate, availability).
4. **No Alerting** — No PagerDuty/Slack/OpsGenie integration.
5. **No Runbooks** — Incident response is tribal knowledge.
6. **No Cost Monitoring** — LLM/embedding spend unbounded; no per-tenant attribution.
7. **No Backup Verification** — Supabase PITR enabled but restore never tested.
8. **No Capacity Alerts** — Disk, memory, connections, queue depth unmonitored.

---

## 18. TECHNICAL DEBT NOT ADDRESSED IN ROADMAP

| Debt | Roadmap Phase | Status |
|------|---------------|--------|
| Apache AGE removal | Phase 0 (ADR-T4) | Removed in Phase 0 Task 3 (extension, RPC, compose image) |
| Pseudo-vector removal | Phase 4 (provider swap) | But fallback remains in code |
| OpenFGA in-memory replacement | Phase 5 | Too late; needed in Phase 1 |
| ABAC middleware wiring | Phase 5 | Not on all routes |
| Mock token removal | Never | Dev/prod parity broken |
| Single-process split | Phase 8 | Too late (Week 13+) |
| Schema drift fixes | Phase 1 (029 only) | More drift inevitable |
| `modelRouter.ts` integration | Never | Exists but unused |
| `executeCypher` dead code | Phase 0 (ADR-T4) | Removed in Phase 0 Task 3; relational traversal only |
| CIDR substring bug | Never | Security vulnerability |

---

## 19. REVISED PHASE STRUCTURE (Recommendation)

```
W0-1:  Phase 0  — Infrastructure Foundation (process split, compose, Temporal, OpenFGA, MinIO, Vault, OTel, migration runner, CI)
W1-2:  Phase 1  — Schema Integrity & Test Infrastructure (migrations, contract tests, hermetic tests, lint/typecheck)
W2-3:  Phase 1.5— Security Hardening (threat model, SSRF, rate limits, secret scan, CIDR fix, audit log immutability)
W3-5:  Phase 2  — Connector Framework & Corpus Substrate (connectors, chunks, claims, entities, async webhooks, object storage)
W5-7:  Phase 3  — Knowledge Graph & Analytics (entity resolution, graph algorithms, temporal queries, workflow mining)
W7-9:  Phase 4  — Production Retrieval & Eval Platform (hosted embeddings, FTS, cross-encoder, citations, eval CI gates)
W9-11: Phase 5  — Authorization & Multi-Tenancy (PDP, ACL mirror, KMS, SSO/SCIM, cross-tenant tests)
W11-13: Phase 6  — Durable Agent Runtime (Temporal workflows, idempotency, compensation, policy engine, run ledger)
W13-15: Phase 7  — Executable Skill Platform (skill registry, OpenAPI execution, dry-run, sandbox, skill evals)
W15-16: Phase 7.5— AI Safety & Red-Teaming (prompt injection, PII guard, action validation, uncertainty)
W16-18: Phase 8  — Observability & SLOs (OTel, dashboards, alerts, cost meters, load/chaos tests)
W18-20: Phase 9  — Multi-Region DR & Data Residency (replication, failover, retention, legal hold, GDPR)
W20-22: Phase 10 — Compliance & Enterprise Admin (SOC2 packs, BAA, admin console, audit export)
W22+:  Phase 11 — Connector SDK GA + Marketplace (extensibility, 3 reference connectors, partner program)
W22+:  Phase 12a— Eval Platform (done in Phase 4)
W22+:  Phase 12b— Feedback Flywheel (preference learning, prompt optimization)
W22+:  Phase 12c— Model Routing & Cost Optimization (task classification, tiered models, budgets)
```

**Total: ~22 weeks to enterprise-ready (vs 30+ in current plan) with lower risk.**

---

## 20. ADR CHALLENGES (Specific Disagreements)

| ADR | Current Decision | My Verdict | Better Decision |
|-----|------------------|------------|-----------------|
| T1 | Runner-owned additive migrations | ✅ Keep | Add: contract test + down migration support |
| T2 | Hosted embeddings primary | ✅ Keep | Add: embedding cache by content-hash; batch API |
| T3 | PG PDP default, OpenFGA optional | ⚠️ **Defer OpenFGA** | Start with PG PDP; OpenFGA as Phase 9.5 when graph auth exceeds PG |
| T4 | Relational graph, retire AGE | ✅ Keep | **Do in Phase 0**, not Phase 3/4 |
| T5 | Temporal for agents, BullMQ for ingestion | ✅ Keep | Add: Temporal for durable ingestion webhooks too |
| T6 | S3-compatible object storage | ✅ Keep | Add: Supabase Storage as first-class backend option |
| T7 | Chunk-first retrieval + citations | ✅ Keep | Add: hybrid-k candidate selection; candidate cache |
| T8 | OTel + OTLP export | ✅ Keep | **Do in Phase 0**, not Phase 9 |
| T9 | Per-service packages + root task runner | ✅ Keep | Add: pnpm workspace for shared types (not full monorepo) |
| T10 | Versioned HTTP API | ✅ Keep | Add: MCP tool versioning via registry metadata |
| T11 | Hermetic unit + infra-gated integration | ✅ Keep | **Migrate to Vitest** for unit; keep tsx for eval runners |
| T12 | Per-workspace cost meters | ✅ Keep | **Do in Phase 1**, not Phase 4/9 |
| T13 | Central idempotency ledger + compensation | ✅ Keep | **Do in Phase 1**, not Phase 6 |
| T14 | DLP/retention at ingestion time | ✅ Keep | **Do in Phase 2** (connector ACL + DLP) |
| T15 | Substrate: raw→chunks→claims→entities→projections | ✅ Keep | **This is the north star**; all phases must align |

---

## 21. RESOURCE REALLOCATION

| Track | Current | Recommended | Rationale |
|-------|---------|-------------|-----------|
| Foundation (T0) | 2 eng, Week 1-4 | **3 eng, Week 0-2** | Unblocks everything; highest leverage |
| Knowledge (A) | 2-3 eng, Week 5+ | **3 eng, Week 2+** | Critical path; corpus is the product |
| Security (B) | 2 eng, Week 5+ | **2 eng, Week 2+** | AuthZ needed for connector ACLs |
| Agents (C) | 2 eng, Week 5+ | **2 eng, Week 4+** | Depends on corpus + runtime infra |
| Ops (D) | 2 eng, Week 5+ | **1 eng + DevOps, Week 0+** | Infra work starts Day 1 |
| **Total** | ~8 eng | **~7 eng + DevOps** | Fewer people, better sequencing |

---

## 22. FINAL RECOMMENDATIONS

1. **STOP feature work.** Execute Phase 0 first. No exceptions.
2. **Kill Apache AGE.** Remove extension, RPC, dead code. Today.
3. **Enforce schema contract in CI.** Code↔migration test on every PR.
4. **Hermetic tests or no merge.** Unit tests <60s, zero infra.
5. **Cross-tenant leak test in CI.** Every PR proves isolation.
6. **Cost meters from Day 1.** Per-tenant, per-model, per-operation.
7. **Idempotency from Day 1.** Every external action gets a key.
8. **Observability from Day 1.** OTel, correlation IDs, structured logs.
9. **Connector SDK before connectors.** Framework first, implementations parallel.
10. **Eval platform before retrieval changes.** Golden queries, thresholds, CI gates.

---

**Bottom Line:** The current roadmap produces a "better prototype" in 30 weeks. The revised roadmap produces an **enterprise-deployable platform** in 22 weeks with 20% fewer engineers. The difference is sequencing infrastructure before features, killing dead code early, and treating security/observability/testing as prerequisites not afterthoughts.