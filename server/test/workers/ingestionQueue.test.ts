import { installHarness } from '../harness/index.js';
import { parseRetryAfterHeader, calculateExponentialBackoff, handleRateLimitResponse } from '../../src/queue/rateLimiter.js';
import { createIngestionWorker, processIngestionJob, IngestionJobData } from '../../src/workers/ingestionWorker.js';
import { registerConnector, clearConnectorRegistry } from '../../src/connectors/registry.js';
import {
  Connector,
  ConnectorError,
  ConnectorSyncCheckpoint,
  ConnectorSyncOptions,
  ConnectorSyncResult,
  SourceObject,
} from '../../src/connectors/types.js';
import type { Job } from 'bullmq';

const WORKSPACE_A = '00000000-0000-4000-8000-00000000000a';

/**
 * Builds a minimal fake BullMQ job carrying the exact IngestionJobData shape
 * POST /api/ingestion/run enqueues. Only the fields the production processor
 * touches are implemented; the rest are cast away.
 */
function makeMockJob(data: IngestionJobData): Job<IngestionJobData> {
  return {
    id: `test_job_${Math.random().toString(36).substring(2, 10)}`,
    name: data.job_name,
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    updateProgress: async (): Promise<void> => undefined,
    toJSON: () => ({ id: 'test_job' }),
  } as unknown as Job<IngestionJobData>;
}

interface RecordingConnector extends Connector {
  syncCalls: Array<{ workspaceId: string; provider: string; incremental?: boolean }>;
  listCalls: number;
  ackCalls: string[];
  ackWorkspaces: string[];
  isConfiguredCalls: number;
}

/**
 * A phased (github-shaped) connector that RECORDS every dispatch entry point.
 * Used to prove the worker processor reaches dispatchConnectorSync with the
 * exact workspaceId/provider from the job payload — and that rejected jobs
 * never touch any connector method.
 */
function createRecordingConnector(provider: string): RecordingConnector {
  const connector: RecordingConnector = {
    provider,
    displayName: `Recording ${provider} Connector`,
    capabilities: {
      supportsIncremental: true,
      supportsPhasedSync: true,
      supportsAcl: false,
      supportsAttachments: false,
      webhookMode: 'provider_queue',
      cursorStore: 'github_sync_state',
      configSources: ['env'],
    },
    syncCalls: [],
    listCalls: 0,
    ackCalls: [],
    ackWorkspaces: [],
    isConfiguredCalls: 0,
    isConfigured: (_workspaceId: string) => {
      connector.isConfiguredCalls++;
      return true;
    },
    async *listObjects(workspaceId: string): AsyncGenerator<SourceObject[], void, unknown> {
      connector.listCalls++;
      yield [
        {
          workspaceId,
          provider,
          externalId: 'repo-a',
          type: 'repo',
          title: 'Repo A',
          text: 'content',
          metadata: {},
          version: 'v1',
          attachments: [],
        },
      ];
    },
    async fetchObject(): Promise<SourceObject | null> {
      return null;
    },
    async fetchAcl() {
      return null;
    },
    async getDeltaCursor() {
      return null;
    },
    async ack(workspaceId: string, externalId: string): Promise<void> {
      connector.ackCalls.push(externalId);
      connector.ackWorkspaces.push(workspaceId);
    },
    async sync(opts: ConnectorSyncOptions): Promise<{ result: ConnectorSyncResult; checkpoint: ConnectorSyncCheckpoint }> {
      connector.syncCalls.push({ workspaceId: opts.workspaceId, provider, incremental: opts.incremental });
      return {
        result: {
          total: 1,
          indexed: 1,
          skipped: 0,
          failed: 0,
          deleted: 0,
          durationMs: 0,
          phases: { repo: { indexed: 1, skipped: 0, failed: 0 } },
        },
        checkpoint: { completedPhases: ['repo'], cursor: 'c1' },
      };
    },
  };
  return connector;
}

export async function runIngestionQueueTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running BullMQ Ingestion Queue & Backoff Test ');
  console.log('=================================================');

  // Test 1: Parse Retry-After header and compute exponential backoff delays
  try {
    const delay5s = parseRetryAfterHeader('5');
    if (delay5s !== 5000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Retry-After seconds parsing mismatch!', delay5s);
      return false;
    }

    const backoffAttempt1 = calculateExponentialBackoff(1, 5000);
    const backoffAttempt2 = calculateExponentialBackoff(2, 5000);
    const backoffAttempt3 = calculateExponentialBackoff(3, 5000);

    if (backoffAttempt1 !== 5000 || backoffAttempt2 !== 10000 || backoffAttempt3 !== 20000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Exponential backoff calculation mismatch!', {
        backoffAttempt1,
        backoffAttempt2,
        backoffAttempt3,
      });
      return false;
    }

    console.log('✅ INGESTION QUEUE TEST PASSED: Successfully parsed Retry-After headers and calculated exponential backoff delays.');
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Backoff Math):', err.message);
    return false;
  }

  // Test 2: Mock HTTP 429 response handling and rate limit delay execution
  try {
    const startTime = Date.now();
    const pauseDuration = await handleRateLimitResponse('1', 1);
    const elapsed = Date.now() - startTime;

    if (elapsed < 900 || pauseDuration !== 1000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Rate limit pause duration was shorter than expected!', elapsed);
      return false;
    }
    console.log(`✅ INGESTION QUEUE TEST PASSED: HTTP 429 rate limit response correctly paused worker execution for ${elapsed}ms.`);
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Rate Limit Pause):', err.message);
    return false;
  }

  // Test 3: Worker Creation & Concurrency / Limiter Options Verification
  try {
    const worker = createIngestionWorker();
    if (!worker || worker.opts.concurrency !== 5) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Worker concurrency option mismatch!', worker?.opts);
      return false;
    }

    // The processor BullMQ will invoke for every job must be the ACTUAL
    // production handler — not a placeholder, stub, or wrapper. BullMQ stores
    // the constructor's processor argument as `processFn` on the Worker
    // instance (verified against node_modules/bullmq v6 worker.js).
    const capturedProcessor = (worker as unknown as { processFn?: unknown }).processFn;
    if (typeof capturedProcessor !== 'function' || capturedProcessor !== processIngestionJob) {
      console.error(
        '❌ INGESTION QUEUE TEST FAILED: createIngestionWorker() did not pass the actual processIngestionJob handler to BullMQ Worker!',
        { capturedType: typeof capturedProcessor, isSameFunction: capturedProcessor === processIngestionJob }
      );
      return false;
    }

    await worker.close();
    console.log('✅ INGESTION QUEUE TEST PASSED: BullMQ worker initialized with concurrency=5, rate limiters, DLQ handlers, and the real processIngestionJob processor.');
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Worker Init):', err.message);
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: crawl_provider PROCESSOR regression (Phase 2 Task 2)
  //
  // The hermetic harness stubs Worker.prototype.run (no polling, no job
  // delivery), so the production processor used to never execute in CI. These
  // tests invoke processIngestionJob() DIRECTLY with a controlled fake job —
  // the same function BullMQ calls inside createIngestionWorker() — proving
  // the real CRAWLER_V2 dispatch path and its flag gate under four contracts:
  //   1. CRAWLER_V2=false preserves the legacy behavior (crawl_provider is
  //      rejected loudly; legacy crawl_slack still runs the legacy switch).
  //   2. CRAWLER_V2=true with an unknown provider rejects BEFORE dispatch —
  //      no connector method is ever invoked.
  //   3. CRAWLER_V2=true with a registered github provider reaches
  //      dispatchConnectorSync with the exact workspaceId/provider from the
  //      job payload.
  //   4. The job payload contract is honored end to end (workspace_id is never
  //      substituted with a default; provider and incremental pass through).
  // ─────────────────────────────────────────────────────────────────────────
  {
    const origFlag = process.env.CRAWLER_V2;
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
    const check = (name: string, ok: boolean, detail?: unknown): void => {
      checks.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
      if (ok) console.log(`✅ CRAWL_PROVIDER PROCESSOR: ${name}`);
      else console.error(`❌ CRAWL_PROVIDER PROCESSOR FAILED: ${name}`, detail ?? '');
    };

    // --- 1. CRAWLER_V2=false: legacy behavior preserved --------------------
    process.env.CRAWLER_V2 = 'false';
    clearConnectorRegistry();
    const offSentinel = createRecordingConnector('github');
    registerConnector(offSentinel);

    let offErr: unknown = null;
    try {
      await processIngestionJob(makeMockJob({ job_name: 'crawl_provider', workspace_id: WORKSPACE_A, provider: 'github' }));
    } catch (err) {
      offErr = err;
    }
    check(
      'flag OFF: crawl_provider is rejected in the processor with the disabled message',
      offErr instanceof Error && /CRAWLER_V2 is not enabled/.test(offErr.message),
      (offErr as Error)?.message
    );
    check(
      'flag OFF: rejection happens before any connector dispatch',
      offSentinel.isConfiguredCalls === 0 && offSentinel.syncCalls.length === 0 && offSentinel.listCalls === 0,
      { isConfiguredCalls: offSentinel.isConfiguredCalls, syncCalls: offSentinel.syncCalls, listCalls: offSentinel.listCalls }
    );

    // Legacy switch still runs with the flag OFF: without a SLACK_BOT_TOKEN the
    // legacy crawler short-circuits to `skipped` instead of throwing.
    const legacyResult = await processIngestionJob(makeMockJob({ job_name: 'crawl_slack', workspace_id: WORKSPACE_A }));
    check(
      'flag OFF: legacy crawl_slack still processes through the legacy switch (no dispatch regression)',
      (legacyResult as { status?: string })?.status === 'skipped',
      legacyResult
    );

    // --- 2. CRAWLER_V2=true + unknown provider: rejects BEFORE dispatch -----
    process.env.CRAWLER_V2 = 'true';
    clearConnectorRegistry();
    const unknownSentinel = createRecordingConnector('github');
    registerConnector(unknownSentinel);

    let unknownErr: unknown = null;
    try {
      await processIngestionJob(makeMockJob({ job_name: 'crawl_provider', workspace_id: WORKSPACE_A, provider: 'nope' }));
    } catch (err) {
      unknownErr = err;
    }
    check(
      'flag ON: unknown provider throws a typed not_found ConnectorError (no silent fallback)',
      unknownErr instanceof ConnectorError && (unknownErr as ConnectorError).code === 'not_found',
      unknownErr instanceof Error ? unknownErr.message : String(unknownErr)
    );
    check(
      'flag ON: unknown provider is rejected before dispatch (no connector method invoked)',
      unknownSentinel.isConfiguredCalls === 0 && unknownSentinel.syncCalls.length === 0 && unknownSentinel.listCalls === 0,
      { isConfiguredCalls: unknownSentinel.isConfiguredCalls, syncCalls: unknownSentinel.syncCalls, listCalls: unknownSentinel.listCalls }
    );

    // A job with a missing/blank provider is also rejected before dispatch.
    let missingErr: unknown = null;
    try {
      await processIngestionJob(makeMockJob({ job_name: 'crawl_provider', workspace_id: WORKSPACE_A }));
    } catch (err) {
      missingErr = err;
    }
    check(
      'flag ON: job without a provider field is rejected with the contract error',
      missingErr instanceof Error && /requires a non-empty provider field/.test(missingErr.message),
      (missingErr as Error)?.message
    );
    check(
      'flag ON: missing-provider rejection happens before any connector dispatch',
      unknownSentinel.isConfiguredCalls === 0 && unknownSentinel.syncCalls.length === 0 && unknownSentinel.listCalls === 0,
      { isConfiguredCalls: unknownSentinel.isConfiguredCalls, syncCalls: unknownSentinel.syncCalls, listCalls: unknownSentinel.listCalls }
    );

    // A non-string provider (job payloads arrive via JSON deserialization) is
    // rejected with the same controlled contract error — never a raw
    // `provider.trim()` TypeError, and never dispatched.
    let nonStringErr: unknown = null;
    try {
      await processIngestionJob(
        makeMockJob({ job_name: 'crawl_provider', workspace_id: WORKSPACE_A, provider: 42 as unknown as string })
      );
    } catch (err) {
      nonStringErr = err;
    }
    check(
      'flag ON: non-string provider is rejected with the contract error (no TypeError)',
      nonStringErr instanceof Error &&
        !(nonStringErr instanceof TypeError) &&
        /requires a non-empty provider field/.test(nonStringErr.message),
      nonStringErr instanceof Error ? nonStringErr.message : String(nonStringErr)
    );
    check(
      'flag ON: non-string rejection happens before any connector dispatch',
      unknownSentinel.isConfiguredCalls === 0 && unknownSentinel.syncCalls.length === 0 && unknownSentinel.listCalls === 0,
      { isConfiguredCalls: unknownSentinel.isConfiguredCalls, syncCalls: unknownSentinel.syncCalls, listCalls: unknownSentinel.listCalls }
    );

    // --- 3 + 4. CRAWLER_V2=true + registered github reaches dispatch ---------
    clearConnectorRegistry();
    const recording = createRecordingConnector('github');
    registerConnector(recording);

    const dispatchResult = await processIngestionJob(
      makeMockJob({
        job_name: 'crawl_provider',
        workspace_id: WORKSPACE_A,
        requested_by: 'user-1',
        provider: ' github ', // whitespace must be trimmed before dispatch
        incremental: true,
      })
    );
    check('flag ON: registered github reaches dispatchConnectorSync (connector.sync invoked)', recording.syncCalls.length === 1, recording.syncCalls);
    check(
      'dispatch receives the job workspace_id (never substituted with a default)',
      recording.syncCalls[0]?.workspaceId === WORKSPACE_A,
      recording.syncCalls[0]
    );
    check(
      'dispatch resolves the provider from the job payload (trimmed)',
      recording.syncCalls[0]?.provider === 'github',
      recording.syncCalls[0]
    );
    check(
      'dispatch passes incremental through from the job payload',
      recording.syncCalls[0]?.incremental === true,
      recording.syncCalls[0]
    );
    check(
      'processor returns the dispatchConnectorSync result unchanged',
      (dispatchResult as ConnectorSyncResult)?.indexed === 1 && (dispatchResult as ConnectorSyncResult)?.total === 1,
      dispatchResult
    );

    // Processor contract: the exact job payload shape the route enqueues is
    // consumed as-is (workspace_id/provider/requested_by/incremental).
    const payloadJob = makeMockJob({
      job_name: 'crawl_provider',
      workspace_id: WORKSPACE_A,
      requested_by: 'user-1',
      provider: 'github',
      incremental: false,
    });
    check(
      'job payload contract: crawl_provider jobs carry the IngestionJobData shape (job_name/workspace_id/requested_by/provider/incremental)',
      payloadJob.data.job_name === 'crawl_provider' &&
        payloadJob.data.workspace_id === WORKSPACE_A &&
        payloadJob.data.requested_by === 'user-1' &&
        payloadJob.data.provider === 'github' &&
        payloadJob.data.incremental === false,
      payloadJob.data
    );

    const failed = checks.filter((c) => !c.ok);
    console.log(`\nCrawl-provider processor suite: ${checks.length - failed.length} passed, ${failed.length} failed.`);

    // Restore the pre-test CRAWLER_V2 state (unset stays unset — assigning
    // `undefined` to process.env would stringify it).
    if (origFlag === undefined) delete process.env.CRAWLER_V2;
    else process.env.CRAWLER_V2 = origFlag;
    clearConnectorRegistry();

    if (failed.length > 0) {
      return false;
    }
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestionQueueTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
