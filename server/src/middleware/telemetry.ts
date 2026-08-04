import { Request, Response, NextFunction } from 'express';

export interface TelemetrySpan {
  id: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
  end: (status?: 'ok' | 'error', errorMessage?: string) => void;
}

export interface MetricEntry {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

const activeSpans: TelemetrySpan[] = [];
const metricsStore: MetricEntry[] = [];

/**
 * Creates and starts a new OpenTelemetry-compatible distributed tracing span.
 */
export function startTraceSpan(name: string, attributes: Record<string, any> = {}): TelemetrySpan {
  const id = `span_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const span: TelemetrySpan = {
    id,
    name,
    startTime: Date.now(),
    attributes,
    end: (status = 'ok', errorMessage) => {
      span.endTime = Date.now();
      const duration = span.endTime - span.startTime;
      span.attributes.status = status;
      if (errorMessage) span.attributes.error_message = errorMessage;
      span.attributes.duration_ms = duration;
    },
  };
  activeSpans.push(span);
  return span;
}

/**
 * Records a Prometheus metric counter or histogram value.
 */
export function recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  metricsStore.push({
    name,
    value,
    labels,
    timestamp: Date.now(),
  });
}

/**
 * Formats all recorded telemetry metrics into standard Prometheus scraper text format.
 */
export function getPrometheusMetricsString(): string {
  const metricGroups: Record<string, number> = {
    'ingestion_queue_latency_ms_sum': 0,
    'ingestion_queue_latency_ms_count': 0,
    'agent_execution_duration_ms_sum': 0,
    'agent_execution_duration_ms_count': 0,
    'llm_token_usage_total': 0,
    'http_requests_total': 0,
  };

  for (const m of metricsStore) {
    if (m.name === 'ingestion_queue_latency_ms') {
      metricGroups['ingestion_queue_latency_ms_sum'] += m.value;
      metricGroups['ingestion_queue_latency_ms_count'] += 1;
    } else if (m.name === 'agent_execution_duration_ms') {
      metricGroups['agent_execution_duration_ms_sum'] += m.value;
      metricGroups['agent_execution_duration_ms_count'] += 1;
    } else if (m.name === 'llm_token_usage_total') {
      metricGroups['llm_token_usage_total'] += m.value;
    } else if (m.name === 'http_requests_total') {
      metricGroups['http_requests_total'] += m.value;
    }
  }

  let lines: string[] = [
    '# HELP ingestion_queue_latency_ms Latency of BullMQ ingestion jobs in milliseconds',
    '# TYPE ingestion_queue_latency_ms summary',
    `ingestion_queue_latency_ms_sum ${metricGroups['ingestion_queue_latency_ms_sum']}`,
    `ingestion_queue_latency_ms_count ${metricGroups['ingestion_queue_latency_ms_count']}`,
    '',
    '# HELP agent_execution_duration_ms Execution duration of agent workflow activities in milliseconds',
    '# TYPE agent_execution_duration_ms summary',
    `agent_execution_duration_ms_sum ${metricGroups['agent_execution_duration_ms_sum']}`,
    `agent_execution_duration_ms_count ${metricGroups['agent_execution_duration_ms_count']}`,
    '',
    '# HELP llm_token_usage_total Total count of LLM tokens consumed across multi-agent workflows',
    '# TYPE llm_token_usage_total counter',
    `llm_token_usage_total ${metricGroups['llm_token_usage_total']}`,
    '',
    '# HELP http_requests_total Total count of incoming API HTTP requests',
    '# TYPE http_requests_total counter',
    `http_requests_total ${metricGroups['http_requests_total']}`,
  ];

  return lines.join('\n');
}

/**
 * Express OpenTelemetry Tracing Middleware
 */
export function telemetryMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const span = startTraceSpan(`HTTP ${req.method} ${req.path}`, {
      'http.method': req.method,
      'http.url': req.url,
      'http.user_agent': req.headers['user-agent'] || '',
    });

    recordMetric('http_requests_total', 1, { method: req.method, path: req.path });

    res.on('finish', () => {
      span.end(res.statusCode < 400 ? 'ok' : 'error');
    });

    next();
  };
}
