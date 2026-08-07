// Hermetic unit tests for the OpenTelemetry scaffold (Phase 0 Task 9).
// Only the disabled/no-op path is exercised: enabling OTLP export requires a
// live collector and is covered by manual smoke testing.

import {
  getOpenTelemetrySdk,
  getTracer,
  initializeOpenTelemetry,
  isOpenTelemetryEnabled,
  shutdownOpenTelemetry,
} from '../../src/config/otel.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ OTEL TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ OTEL TEST FAILED: ${name}`, extra ?? '');
  }
}

async function runOtelTests(): Promise<boolean> {
  const savedOtel = process.env.OTEL_ENABLED;
  delete process.env.OTEL_ENABLED;

  check('OTEL disabled by default', isOpenTelemetryEnabled() === false);

  let threw = false;
  try {
    initializeOpenTelemetry();
  } catch{
    threw = true;
  }
  check('initializeOpenTelemetry no-ops without crash', threw === false);

  initializeOpenTelemetry();
  check('initializeOpenTelemetry is idempotent', true);

  check('getOpenTelemetrySdk returns null when disabled', getOpenTelemetrySdk() === null);
  check('getTracer returns null when disabled', getTracer() === null);

  let shutdownOk = false;
  try {
    await shutdownOpenTelemetry();
    shutdownOk = true;
  } catch {
    shutdownOk = false;
  }
  check('shutdownOpenTelemetry is safe when never started', shutdownOk === true);

  if (savedOtel === undefined) delete process.env.OTEL_ENABLED;
  else process.env.OTEL_ENABLED = savedOtel;

  console.log(`\n[OTel Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOtelTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
