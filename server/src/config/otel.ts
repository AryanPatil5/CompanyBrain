// OpenTelemetry configuration for Phase 0 (ADR-T8 scaffold).
// - No-op when OTEL_ENABLED is not 'true' (zero SDK overhead in dev/tests).
// - OTLP HTTP exporter when enabled (OTEL_EXPORTER_OTLP_ENDPOINT overridable).
// - initializeOpenTelemetry() is idempotent; shutdownOpenTelemetry() flushes
//   and closes the SDK gracefully. Metrics/Prometheus remain Phase 9.

import type { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { SERVICE_VERSION } from '../services/health.js';
import { logger } from '../logger.js';

let sdk: NodeSDK | null = null;
let started = false;

export function isOpenTelemetryEnabled(): boolean {
  return process.env.OTEL_ENABLED === 'true';
}

/**
 * Initialize the OpenTelemetry SDK exactly once. With OTEL_ENABLED unset this
 * is a no-op; when enabled, the SDK is loaded lazily and an OTLP trace
 * exporter is registered for the configured endpoint.
 */
export function initializeOpenTelemetry(): void {
  if (started) return;
  started = true;

  if (!isOpenTelemetryEnabled()) {
    return;
  }

  void loadAndStart();
}

async function loadAndStart(): Promise<void> {
  try {
    const [{ NodeSDK }, { OTLPTraceExporter }, { Resource }, { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
    ]);

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';

    sdk = new NodeSDK({
      resource: new Resource({
        [SEMRESATTRS_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || logger.serviceName(),
        [SEMRESATTRS_SERVICE_VERSION]: SERVICE_VERSION,
        [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
    });

    sdk.start();
    logger.info('OpenTelemetry SDK started', { endpoint });
  } catch (err) {
    logger.error('Failed to initialize OpenTelemetry SDK', { error: (err as Error).message });
    sdk = null;
  }
}

/**
 * Gracefully shut down the OpenTelemetry SDK (flush + close). Safe to call
 * when the SDK was never started.
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  const current = sdk;
  sdk = null;
  if (current) {
    try {
      await current.shutdown();
      logger.info('OpenTelemetry SDK shut down');
    } catch (err) {
      logger.error('OpenTelemetry SDK shutdown failed', { error: (err as Error).message });
    }
  }
}

/**
 * Get the active OpenTelemetry SDK instance (null when disabled/not started).
 */
export function getOpenTelemetrySdk(): NodeSDK | null {
  return sdk;
}

/**
 * Get a named tracer once the SDK has started (null when disabled). The SDK
 * registers itself as the global provider at start(), so trace.getTracer()
 * returns a working tracer when OTEL_ENABLED=true.
 */
export function getTracer(name = 'company-brain'): ReturnType<typeof trace.getTracer> | null {
  if (!sdk) return null;
  return trace.getTracer(name);
}

// Backward-compatible instance shape for any code referencing the old stub.
export const otelSdk = {
  start: (): void => {
    initializeOpenTelemetry();
  },
  shutdown: async (): Promise<void> => {
    await shutdownOpenTelemetry();
  },
};
