# Phase 1 Task 5 — Production Hardening & Remaining Phase 0 Blockers

Status: complete. Closes the Phase 0 audit blockers assigned to Phase 1 in
`DESIGN_REVIEW.md`, keeps full backward compatibility, and adds regression
guards. All verification below passes on the current tree.

## 1. Schema drift: execution_logs alignment (migration `033_execution_logs_alignment.sql`)

Root cause: migration `003` created `execution_logs` with 7 columns
(id, sop_id, agent_id, tool_name, input_params, outcome, created_at), but the
workers written later (`workers/ingestionWorker.ts`, `workers/githubSyncWorker.ts`)
and `services/auditLogger.ts` insert 8 columns that were never defined —
every insert failed at runtime with `column does not exist`.

Fix (additive, runner-safe):
- `execution_logs` gains `workspace_id`, `step_execution_id`, `target_system`,
  `status`, `input_payload`, `output_payload`, `error_message`, `executed_at`
  + `idx_execution_logs_workspace/status/executed_at`.
- `document_chunks` gains the roadmap composite + FTS indexes
  (`(workspace_id, source_document_id)` and GIN `to_tsvector('english', content)`).
- `skills_sops.is_stale` — code (`freshness.ts`, `mcp.ts`) filters
  `.eq('is_stale', ...)` on `skills_sops`, but the column had only ever been
  added to `sop_versions` (003). Added to `skills_sops` (default false).

## 2. Idempotency ledger (ADR-T13 pulled forward; `034_idempotency_keys.sql` + `src/services/idempotency.ts`)

- Table `idempotency_keys(key pk, workspace_id, operation, status
  pending/completed/failed, result_ref, created_at/updated_at/expires_at)` +
  status/workspace indexes + RLS (service role full, workspace read own).
- Service: `idempotencyKeyFor(parts)` (sha256, webhook-style dedupe),
  `generateIdempotencyKey()` (uuid), `acquireIdempotency` (insert-as-pending;
  replay on duplicate — the PK is the concurrency enforcement point;
  expired-pending rows are reset), `completeIdempotency`, `getIdempotency`.
- Failure semantics: best effort / fail-open, 2s timeout via the existing
  `withTimeout` from `services/health.ts` (same pattern as the cost meter).
- HTTP surface: `http_adapters.ts` `fetchWithRetry` accepts an
  `idempotencyKey` → sends `Idempotency-Key` header; threaded through
  `slackPostMessageAdapter`, `githubCommentAdapter`, `stripeAdapter`, and
  `dispatchStepExecution` (optional 5th param — backward compatible).

## 3. Boot hardening: bounded ioredis reconnect (`src/queue/ingestionQueue.ts`)

`retryStrategy` was absent → infinite reconnect with default 1s backoff.
Now exponential `100 * 2^(times-1)` capped at 5s, giving up after 10 attempts
with a structured warn log; process stays alive and `/health` reports the
dependency unavailable (existing health contract, never crashes).

## 4. `scripts/check-environment.mjs` rewrite

Previously probed Ollama (not in docker-compose) and only checked Redis +
Postgres. Now: Redis 6379, Postgres 5432, Supabase HTTPS reachability from
`server/.env` `SUPABASE_URL`, `.env` presence + required keys
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VAULT_SECRET_KEY`,
`OPENROUTER_API_KEY`) + documented optional keys. Read-only, exit 0/1.

## 5. Schema contract regression test (`test/db/schemaContract.test.ts`)

Hermetic (no live DB): statically parses `server/supabase/*.sql` for tables +
columns (create-table and multi-column `alter table ... add column`), scans
`server/src` for `supabase.from(...)` chains (select/filter/order/insert/
update/upsert), and asserts:
- every referenced table exists (136 refs, 28 tables),
- every statically identifiable column resolves,
- `execution_logs` exposes every column the workers write (drift guard),
- `idempotency_keys` exists with its contract columns.

Parser handles PostgREST embedded relations (`rel!inner(a,b)`), dotted filter
paths (`rel.col`), nested payload objects, string/template-literal stripping,
and quote-aware chain termination. Real drift found during bring-up:
`skills_sops.is_stale` (fixed in 033 above); everything else was parser
false-positive (nested `snapshot`/`input_params` payloads, `endpoint_config`
bodies, `join('; ')` truncation).

## 6. Supporting changes

- `test/harness/fakeSupabase.ts`: added `.not(col, op, val)` — required by
  `embeddings.ts` `.not('embedding','is',null)`; previously the remote
  fallback path only passed because the filter was silently dropped.
- `test/services/idempotency.test.ts` (16 checks): key derivation, fresh
  acquire vs replay, complete + resultRef persistence, expired-pending
  re-acquire, fail-open, cross-workspace dedupe scope.
- Both suites registered in `test/run-all.ts` (52 suites total).
- `docker-compose.yml`: `migrations` profile one-shot service
  (`docker compose --profile migrations run --rm migrations`).
- `README.md`: manual SQL-Editor ordering list replaced by runner docs.
- `server/.env.example`: `DATABASE_URL`, `PG_REPLICA_URL`, `CI*` vars.

## Verification (all green on current tree)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (server) | clean |
| `npm run build` (server tsc emit) | clean |
| `npm test` (hermetic, run-all) | **52/52 suites, 0 failed** (10.8s) |
| `npm run lint` (server) | clean |
| `npm run lint` (client) | 0 errors (7 pre-existing warnings) |
| `npm run build` (client) | clean |
| Migrations on ephemeral pgvector/pgvector:pg16 | 31 applied; re-run idempotent (0 applied, 31 already applied); `\d` spot-checks confirm new columns/indexes |
| `helm lint` + `helm template` | pass |
| gitleaks / npm audit gate | unchanged gates from Tasks 3/4 (no new secrets; no new deps) |

## Remaining limitations (unchanged, documented in `COMPANY_BRAIN_CRITICAL_REVIEW.md`)

- Contract test is static/best-effort: computed or alias-only select columns
  and dynamic payload keys are out of scope; it complements, not replaces,
  the live-PG verification in CI (`test/db/migrations.test.ts`).
- Real Supabase RLS is not exercised by the ephemeral-PG run; the 034
  policies follow the same style as the rest of the ledger.
- Staged-but-uncommitted items from Task 4 (deleted `scripts/migrate.mjs`,
  deleted `028`, rename `030 → 032`) remain untouched by this task.
