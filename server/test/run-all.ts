/**
 * Hermetic CI test runner for `npm test`.
 *
 * Installs the deterministic harness (env, in-memory Redis/BullMQ stubs,
 * fetch router with canned LLM/embeddings, in-memory Supabase) and then runs
 * every hermetic test suite with a hard per-suite timeout. No live network,
 * no Redis, no Postgres/Supabase, no Docker, no paid LLM calls.
 *
 * Excluded suites (documented in the Phase 1 Task 3 report):
 *   - test/integration/chunkIngestion.integration.test.ts  (live Supabase, jest)
 *   - test/db/migrations.test.ts                           (live Postgres)
 *   - test/graph/graphAlgorithms.test.ts                   (jest DSL, no runner)
 *   - test/infra/processBoot.test.ts                       (imports missing test/bootstrap.ts)
 *   - test/e2e/companyBrain.e2e.test.ts                    (wired inside the guardrails monolith)
 */
import { installHarness } from './harness/index.js';

interface SuiteEntry {
  name: string;
  file: string;
  run: string;
  timeoutMs: number;
}

const SUITES: SuiteEntry[] = [
  {
    name: 'guardrails-monolith (mcp-guardrails.test.ts: tests 1-58)',
    file: './mcp-guardrails.test.js',
    run: 'runMcpGuardrailsTestSuite',
    timeoutMs: 600_000,
  },
  { name: 'connectors/github/auth', file: './connectors/github/auth.test.js', run: 'runAuthTest', timeoutMs: 120_000 },
  { name: 'connectors/github/client', file: './connectors/github/client.test.js', run: 'runClientTest', timeoutMs: 120_000 },
  { name: 'connectors/github/mapper', file: './connectors/github/mapper.test.js', run: 'runMapperTest', timeoutMs: 120_000 },
  { name: 'connectors/github/webhook', file: './connectors/github/webhook.test.js', run: 'runWebhookTest', timeoutMs: 120_000 },
  { name: 'connectors/github/sync', file: './connectors/github/sync.test.js', run: 'runSyncTest', timeoutMs: 120_000 },
  { name: 'connectors/registry', file: './connectors/registry.test.js', run: 'runRegistryTest', timeoutMs: 120_000 },
  { name: 'connectors/conformance', file: './connectors/conformance.test.js', run: 'runConnectorConformanceTest', timeoutMs: 120_000 },
  { name: 'infra/costMeter', file: './infra/costMeter.test.js', run: 'runCostMeterTests', timeoutMs: 120_000 },
  { name: 'infra/health', file: './infra/health.test.js', run: 'runHealthTests', timeoutMs: 120_000 },
  { name: 'infra/logger', file: './infra/logger.test.js', run: 'runLoggerTests', timeoutMs: 120_000 },
  { name: 'infra/otel', file: './infra/otel.test.js', run: 'runOtelTests', timeoutMs: 120_000 },
  { name: 'retrieval/groundingGuardrail', file: './retrieval/groundingGuardrail.test.js', run: 'runGroundingGuardrailTest', timeoutMs: 120_000 },
  { name: 'skills/e2bSandboxEngine', file: './skills/e2bSandboxEngine.test.js', run: 'runE2BSandboxEngineTest', timeoutMs: 120_000 },
  { name: 'skills/sopCompiler', file: './skills/sopCompiler.test.js', run: 'runSopCompilerTest', timeoutMs: 120_000 },
  { name: 'agents/temporalOrchestrator', file: './agents/temporalOrchestrator.test.js', run: 'runTemporalOrchestratorTest', timeoutMs: 120_000 },
  { name: 'agents/stateMachine', file: './agents/stateMachine.test.js', run: 'runStateMachineTest', timeoutMs: 120_000 },
  { name: 'agents/persistentStore', file: './agents/persistentStore.test.js', run: 'runPersistentStoreTest', timeoutMs: 120_000 },
  { name: 'agents/multiAgentOrchestrator', file: './agents/multiAgentOrchestrator.test.js', run: 'runMultiAgentOrchestratorTest', timeoutMs: 120_000 },
  { name: 'workflows/agentWorkflow', file: './workflows/agentWorkflow.test.js', run: 'runAgentWorkflowTest', timeoutMs: 120_000 },
  { name: 'workers/ingestionQueue', file: './workers/ingestionQueue.test.js', run: 'runIngestionQueueTest', timeoutMs: 120_000 },
  { name: 'middleware/abacMiddleware', file: './middleware/abacMiddleware.test.js', run: 'runAbacMiddlewareTest', timeoutMs: 120_000 },
  { name: 'middleware/jwtAuth', file: './middleware/jwtAuth.test.js', run: 'runJwtAuthTest', timeoutMs: 120_000 },
  { name: 'middleware/observability', file: './middleware/observability.test.js', run: 'runObservabilityTest', timeoutMs: 120_000 },
  { name: 'middleware/openfgaMiddleware', file: './middleware/openfgaMiddleware.test.js', run: 'runOpenFGAEngineTest', timeoutMs: 120_000 },
  { name: 'middleware/telemetry', file: './middleware/telemetry.test.js', run: 'runTelemetryTest', timeoutMs: 120_000 },
  { name: 'parsers/documentParser', file: './parsers/documentParser.test.js', run: 'runDocumentParserTest', timeoutMs: 120_000 },
  { name: 'parsers/layoutParser', file: './parsers/layoutParser.test.js', run: 'runLayoutParserTest', timeoutMs: 120_000 },
  { name: 'parsers/pdfExtraction', file: './parsers/pdfExtraction.test.js', run: 'runPdfExtractionTest', timeoutMs: 120_000 },
  { name: 'retrieval/graphFusion', file: './retrieval/graphFusion.test.js', run: 'runGraphFusionTest', timeoutMs: 120_000 },
  { name: 'retrieval/hybridSearch', file: './retrieval/hybridSearch.test.js', run: 'runHybridSearchTest', timeoutMs: 120_000 },
  { name: 'graph/vectorEntityResolver', file: './graph/vectorEntityResolver.test.js', run: 'runVectorEntityResolverTest', timeoutMs: 120_000 },
  { name: 'graph/dlacGraphFusion', file: './graph/dlacGraphFusion.test.js', run: 'runDlacGraphFusionTest', timeoutMs: 120_000 },
  { name: 'graph/temporalGraphService', file: './graph/temporalGraphService.test.js', run: 'runTemporalGraphServiceTest', timeoutMs: 120_000 },
  { name: 'graph/entityDisambiguator', file: './graph/entityDisambiguator.test.js', run: 'runEntityDisambiguatorTest', timeoutMs: 120_000 },
  { name: 'graph/ontologyCompiler', file: './graph/ontologyCompiler.test.js', run: 'runOntologyCompilerTest', timeoutMs: 120_000 },
  { name: 'graph/apacheAgeGraph', file: './graph/apacheAgeGraph.test.js', run: 'runApacheAgeGraphTest', timeoutMs: 120_000 },
  { name: 'security/kmsEncryption', file: './security/kmsEncryption.test.js', run: 'runKmsEncryptionTest', timeoutMs: 120_000 },
  { name: 'security/keyProvider', file: './security/keyProvider.test.js', run: 'runKeyProviderTest', timeoutMs: 120_000 },
  { name: 'security/dlacVectorSearch', file: './security/dlacVectorSearch.test.js', run: 'runDlacVectorSearchTest', timeoutMs: 120_000 },
  { name: 'infra/cidrAbac', file: './infra/cidrAbac.test.js', run: 'runCidrAbacTest', timeoutMs: 120_000 },
  { name: 'infra/ssrfGuard', file: './infra/ssrfGuard.test.js', run: 'runSsrfGuardTest', timeoutMs: 120_000 },
  { name: 'infra/helmCharts', file: './infra/helmCharts.test.js', run: 'runHelmChartsTest', timeoutMs: 120_000 },
  { name: 'skills/sandboxEngine', file: './skills/sandboxEngine.test.js', run: 'runSandboxEngineTest', timeoutMs: 120_000 },
  { name: 'skills/secureSandboxEngine', file: './skills/secureSandboxEngine.test.js', run: 'runSecureSandboxEngineTest', timeoutMs: 120_000 },
  { name: 'skills/toolSelfHealer', file: './skills/toolSelfHealer.test.js', run: 'runToolSelfHealerTest', timeoutMs: 120_000 },
  { name: 'skills/openApiAutoDiscoverer', file: './skills/openApiAutoDiscoverer.test.js', run: 'runOpenApiAutoDiscovererTest', timeoutMs: 120_000 },
  { name: 'skills/openApiCompiler', file: './skills/openApiCompiler.test.js', run: 'runOpenApiCompilerTest', timeoutMs: 120_000 },
  { name: 'eval/hallucinationEvaluator', file: './eval/hallucinationEvaluator.test.js', run: 'runHallucinationEvaluatorTest', timeoutMs: 120_000 },
  { name: 'routes/webhooks', file: './routes/webhooks.test.js', run: 'runWebhooksRouteTest', timeoutMs: 120_000 },
  { name: 'connectors/webhookDurability', file: './connectors/webhookDurability.test.js', run: 'runWebhookDurabilityTest', timeoutMs: 120_000 },
  { name: 'services/auditLogger', file: './services/auditLogger.test.js', run: 'runAuditLoggerTest', timeoutMs: 120_000 },
  { name: 'services/modelRouter', file: './services/modelRouter.test.js', run: 'runModelRouterTest', timeoutMs: 120_000 },
  { name: 'services/embeddingProvider', file: './services/embeddingProvider.test.js', run: 'runEmbeddingProviderTests', timeoutMs: 120_000 },
  { name: 'db/schemaContract', file: './db/schemaContract.test.js', run: 'runSchemaContractTest', timeoutMs: 120_000 },
  { name: 'services/idempotency', file: './services/idempotency.test.js', run: 'runIdempotencyTest', timeoutMs: 120_000 },
  { name: 'routes/documents', file: './routes/documents.test.js', run: 'runDocumentsRouteTests', timeoutMs: 120_000 },
  { name: 'workers/documentJob', file: './workers/documentJob.test.js', run: 'runDocumentJobTests', timeoutMs: 120_000 },
  { name: 'workers/claimsBackfill', file: './workers/claimsBackfill.test.js', run: 'runClaimsBackfillTests', timeoutMs: 120_000 },
  { name: 'workers/embeddingBackfill', file: './workers/embeddingBackfill.test.js', run: 'runEmbeddingBackfillTests', timeoutMs: 120_000 },
  { name: 'services/docxParser', file: './services/docxParser.test.js', run: 'runDocxParserTests', timeoutMs: 120_000 },
  { name: 'services/spreadsheetParser', file: './services/spreadsheetParser.test.js', run: 'runSpreadsheetParserTests', timeoutMs: 120_000 },
  { name: 'services/ocrGateway', file: './services/ocrGateway.test.js', run: 'runOcrGatewayTests', timeoutMs: 120_000 },
  { name: 'services/noFabricatedFallback', file: './services/noFabricatedFallback.test.js', run: 'runNoFabricatedFallbackTests', timeoutMs: 120_000 },
  { name: 'storage/storageProvider', file: './storage/storageProvider.test.js', run: 'runStorageProviderTest', timeoutMs: 120_000 },
  { name: 'knowledge/claimExtractor', file: './knowledge/claimExtractor.test.js', run: 'runClaimExtractorTests', timeoutMs: 120_000 },
  { name: 'knowledge/claimStore', file: './knowledge/claimStore.test.js', run: 'runClaimStoreTests', timeoutMs: 120_000 },
  { name: 'knowledge/claimProvenance', file: './knowledge/claimProvenance.test.js', run: 'runClaimProvenanceTests', timeoutMs: 120_000 },
  { name: 'knowledge/entityResolver', file: './knowledge/entityResolver.test.js', run: 'runEntityResolverTests', timeoutMs: 120_000 },
  { name: 'routes/sopClaims', file: './routes/sopClaims.test.js', run: 'runSopClaimsRouteTests', timeoutMs: 120_000 },
  { name: 'knowledge/webhookClaimsE2E', file: './knowledge/webhookClaimsE2E.test.js', run: 'runWebhookClaimsE2ETests', timeoutMs: 120_000 },
  { name: 'crawlers/crawlerClaimsE2E', file: './crawlers/crawlerClaimsE2E.test.js', run: 'runCrawlerClaimsE2ETests', timeoutMs: 120_000 },
];

interface SuiteResult {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

function normalizeResult(result: unknown): { ok: boolean; detail?: string } {
  if (typeof result === 'boolean') return { ok: result };
  if (result && typeof result === 'object') {
    const r = result as { failed?: number; passed?: number };
    return { ok: r.failed === 0, detail: `passed=${r.passed}, failed=${r.failed}` };
  }
  return { ok: false, detail: `unexpected return value: ${String(result)}` };
}

async function runSuite(entry: SuiteEntry): Promise<SuiteResult> {
  const startedAt = Date.now();
  try {
    const mod: Record<string, unknown> = await import(entry.file);
    const fn = mod[entry.run];
    if (typeof fn !== 'function') {
      return { name: entry.name, ok: false, durationMs: Date.now() - startedAt, detail: `missing export ${entry.run}` };
    }
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`suite exceeded ${entry.timeoutMs}ms hard timeout`)), entry.timeoutMs);
    });
    const result = await Promise.race([fn(), timeout]);
    const normalized = normalizeResult(result);
    return {
      name: entry.name,
      ok: normalized.ok,
      durationMs: Date.now() - startedAt,
      detail: normalized.detail,
    };
  } catch (err: any) {
    return {
      name: entry.name,
      ok: false,
      durationMs: Date.now() - startedAt,
      detail: err?.message ?? String(err),
    };
  }
}

async function main(): Promise<void> {
  const overallStart = Date.now();
  console.log('==========================================================');
  console.log('  Company Brain - Hermetic Test Runner (Phase 1 Task 3)   ');
  console.log('==========================================================\n');

  console.log('Installing hermetic harness (env, Redis/BullMQ stubs, fetch router, in-memory Supabase)...\n');
  await installHarness();

  const results: SuiteResult[] = [];
  for (const entry of SUITES) {
    console.log(`\n--- ${entry.name} ---`);
    const result = await runSuite(entry);
    results.push(result);
    console.log(
      result.ok
        ? `  ✔ ${entry.name} PASSED (${(result.durationMs / 1000).toFixed(1)}s)`
        : `  ✘ ${entry.name} FAILED (${(result.durationMs / 1000).toFixed(1)}s)${result.detail ? ` — ${result.detail}` : ''}`
    );
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log('\n==========================================================');
  console.log(`  Summary: ${passed} passed, ${failed} failed across ${results.length} suites`);
  console.log(`  Total runtime: ${((Date.now() - overallStart) / 1000).toFixed(1)}s`);
  if (failed > 0) {
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`    FAILED: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
  console.log('==========================================================\n');

  // Force-exit: leftover intervals/timers (e.g. health check loops, OTel
  // shutdown hooks) must not keep the process alive or mask a hang.
  process.exit(failed > 0 ? 1 : 0);
}

await main();
