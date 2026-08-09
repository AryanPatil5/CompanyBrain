import { installHarness } from '../harness/index.js';
import { startTraceSpan, recordMetric, getPrometheusMetricsString } from '../../src/middleware/telemetry.js';

export async function runTelemetryTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running OpenTelemetry & Prometheus Test Suite  ');
  console.log('=================================================');

  // Test 1: OpenTelemetry Trace Span Generation & End Lifecycle
  try {
    const span = startTraceSpan('Test Execution Span', { target: 'unit_test' });
    if (!span.id || !span.startTime) {
      console.error('❌ TELEMETRY TEST FAILED: Span creation failed!', span);
      return false;
    }

    span.end('ok');
    if (!span.endTime || span.attributes.status !== 'ok') {
      console.error('❌ TELEMETRY TEST FAILED: Span lifecycle end error!', span);
      return false;
    }
    console.log(`✅ TELEMETRY TEST PASSED: Successfully created and finalized OpenTelemetry trace span (${span.id}).`);
  } catch (err: any) {
    console.error('❌ TELEMETRY TEST EXCEPTION (Trace Spans):', err.message);
    return false;
  }

  // Test 2: Record Metrics & Prometheus Format Output Verification
  try {
    recordMetric('ingestion_queue_latency_ms', 150, { job: 'crawl_slack' });
    recordMetric('agent_execution_duration_ms', 850, { activity: 'planStepActivity' });
    recordMetric('llm_token_usage_total', 300, { model: 'gemini-2.0-flash' });

    const prometheusStr = getPrometheusMetricsString();

    if (
      !prometheusStr.includes('ingestion_queue_latency_ms_sum') ||
      !prometheusStr.includes('agent_execution_duration_ms_sum') ||
      !prometheusStr.includes('llm_token_usage_total')
    ) {
      console.error('❌ TELEMETRY TEST FAILED: Prometheus output format missing required metrics!', prometheusStr);
      return false;
    }

    console.log('✅ TELEMETRY TEST PASSED: Successfully recorded metrics and formatted valid Prometheus /metrics output.');
  } catch (err: any) {
    console.error('❌ TELEMETRY TEST EXCEPTION (Prometheus Format):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTelemetryTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
