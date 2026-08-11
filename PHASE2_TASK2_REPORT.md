# Phase 2 – Task 2: Connector Framework Acceptance Fixes — Final Report

Status: **DONE** — final acceptance fixes only. No connector-contract redesign, no new
Phase 2 features, no migration.

## Exact scope

This pass closes the Phase 2 Task 2 acceptance gaps without touching the connector
contract (`server/src/connectors/types.ts`), the registry, or the builtin connector
internals:

1. **Real regression coverage for the ingestion worker's `crawl_provider` processor
   path.** The hermetic harness stubs `Worker.prototype.run` to a no-op (see
   `server/test/harness/redisStub.ts`), so the production job processor was never
   executed in CI — the BullMQ dispatch path was only covered up to the enqueue
   boundary. The processor was extracted into an exported `processIngestionJob()`
   (the exact function BullMQ invokes inside `createIngestionWorker()`), and the
   suite now invokes it directly with a controlled fake job. Verified:
   - `CRAWLER_V2=false` preserves the legacy behavior — `crawl_provider` is rejected
     loudly in the processor with the "CRAWLER_V2 is not enabled" message, no
     connector is touched, and a legacy `crawl_slack` job still runs the legacy
     switch (returns the crawler's `skipped` result).
   - `CRAWLER_V2=true` with an unknown provider rejects **before dispatch** — a typed
     `ConnectorError('not_found')` is thrown and no connector method
     (`isConfigured`/`sync`/`listObjects`) is ever invoked.
   - `CRAWLER_V2=true` with a registered `github` provider reaches
     `dispatchConnectorSync` with the exact `workspaceId`/`provider` from the job
     payload (recording connector proves `connector.sync` was invoked with them).
   - The job payload contract is correct end to end: `workspace_id` is never
     substituted with a default, `provider` is trimmed before dispatch, and
     `incremental` passes through to the dispatch options; the processor returns the
     dispatch result unchanged.
2. **Existing registry and conformance tests kept green** (no assertions removed,
   no behavior changed).
3. **Suite-count metadata corrected** from the stale `50` to the actual `55` suites in
   the maintained metadata/docs (see below). Unrelated historical text untouched.
4. **This report.**

## Files changed (this pass)

| File | Change | Why |
|---|---|---|
| `server/src/workers/ingestionWorker.ts` | Extracted the inline BullMQ processor into exported `processIngestionJob(job)`; `createIngestionWorker()` now passes it to the Worker. Body byte-identical. | Exposes the real processor as a hermetic-testable seam (harness stubs `Worker.prototype.run`, so the processor was otherwise dead code in CI). |
| `server/test/workers/ingestionQueue.test.ts` | Added "Test 4" crawl_provider processor regression block: 13 checks across the four contracts above. | Real regression coverage for the production dispatch path without live Redis. |
| `AGENTS.md` | `npm test` comment: `50 suites` → `55 suites`. | Maintained metadata; actual runner count. |
| `.github/workflows/ci.yml` | `test` job step name: `50 suites` → `55 suites`. | Maintained metadata describing the CI test job. |
| `CI_TESTING_REPORT.md` | Workflow-job table (`test` row): `50 suites` → `55 suites`. | Maintained metadata describing the current CI test job. Historical verification records ("50/50 … EXIT=0", "50 passed, 1 failed") were left untouched as period-accurate history. |
| `PHASE2_TASK2_REPORT.md` | This file. | Required deliverable. |

Pre-existing Phase 2 Task 2 working-tree changes (connector contract/registry/github
adapter, `routes/ingestion.ts` dispatch, `register.ts`, `run-all.ts` suite entries,
`ARCHITECTURE.md`/`README.md`/`.env.example` updates) were NOT modified in this pass.

## Acceptance criteria checklist

- [x] Real regression test executes the production `crawl_provider` processor logic
      (no longer stubbed to a no-op) in the hermetic run.
- [x] `CRAWLER_V2=false` legacy behavior preserved and asserted.
- [x] `CRAWLER_V2=true` + unknown provider rejected before dispatch (typed
      `not_found`, zero connector invocation) and asserted.
- [x] `CRAWLER_V2=true` + registered `github` reaches `dispatchConnectorSync` with the
      correct `workspaceId`/`provider` and asserted.
- [x] Job payload contract asserted (`job_name`/`workspace_id`/`requested_by`/
      `provider`/`incremental`; no default-workspace substitution).
- [x] Existing registry and conformance suites kept green.
- [x] Suite-count references updated `50` → `55` in `AGENTS.md`,
      `.github/workflows/ci.yml`, and the maintained metadata in `CI_TESTING_REPORT.md`.
- [x] No connector-contract redesign, no new Phase 2 features, no migration created.
- [x] `server/src/connectors/github/*` internals untouched.
- [x] `npm run build` passes.
- [x] `npm run lint` passes.
- [x] `git diff --check` clean.

## Verification — exact command results

### `npm run build --prefix server`
```
> server@1.0.0 build
> tsc
```
Result: **PASS** (no errors, no warnings).

### `npm run lint --prefix server`
```
> server@1.0.0 lint
> eslint src test
```
Result: **PASS** (0 errors, 0 warnings).

### `npx tsx test/connectors/registry.test.ts`
Result: **PASS** — `Connector registry suite: 47 passed, 0 failed.`

### `npx tsx test/connectors/conformance.test.ts`
Result: **PASS** — `Connector conformance suite: 35 passed, 0 failed.`

### `npm test --prefix server`
Result: **PASS** — `Summary: 55 passed, 0 failed across 55 suites` (total runtime ~11s).
The `workers/ingestionQueue` suite (now including the crawl_provider processor
regression block, 13 checks) is part of the 55.

### `git diff --check`
Result: **PASS** (exit 0, no whitespace errors).

## Worker dispatch is now directly tested

Previously the hermetic harness stubbed `Worker.prototype.run` to `Promise.resolve()`
(`server/test/harness/redisStub.ts`), so the job processor — including the
`crawl_provider` case and its `CRAWLER_V2` gate — was never executed by `npm test`.
Only the enqueue boundary (route + registry) was covered. This pass extracts the
processor as `processIngestionJob(job)` and drives it with a controlled fake `Job`
(the same shape `POST /api/ingestion/run` enqueues), so the real dispatch logic is
executed and asserted in CI with no live Redis.

## Remaining non-blocking risks

- **`createIngestionWorker()` constructor noise:** constructing a `Worker` under the
  hermetic harness emits logged `Connection is closed` errors from the stubbed Redis
  backend before the `error` handler attaches. Purely log noise (the suite and the
  harness tolerate it); a follow-up could attach the error listener before the
  backend connects, but that is outside this acceptance-fix scope.
- **Phased-connector dispatch via the builtin GitHub connector** in the worker is
  still exercised indirectly: `registry.test.ts` proves the builtin connector
  resolves and truthfully refuses an uninstalled workspace, and `conformance.test.ts`
  exercises the real `githubConnector.sync()` error taxonomy. The new processor test
  uses a recording github-shaped connector to assert dispatch *arguments*; wiring the
  worker test to the real builtin connector would need a seeded installation + sync
  fixture and is a natural follow-up, not a gap in the acceptance criteria.
- **Historical suite counts** in `CI_TESTING_REPORT.md` (verification records) and
  `server/test/HERMETIC_TESTING_REPORT.md` still read `50`/`50/50`; they are
  period-accurate records of Phase 1 Task 3/4 runs and were deliberately not
  rewritten.
- **No commit/push** — per instruction, changes are left in the working tree.
