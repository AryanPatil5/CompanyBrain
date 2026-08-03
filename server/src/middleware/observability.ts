import { Request, Response, NextFunction } from 'express';

interface MetricsRegistry {
  httpRequestsTotal: Record<string, number>;
  httpRequestDurationSumMs: number;
  httpRequestCount: number;
  agentExecutionsTotal: Record<string, number>;
  tokenUsageTotal: {
    google: { input: number; output: number };
    openrouter: { input: number; output: number };
    ollama: { input: number; output: number };
    [key: string]: { input: number; output: number };
  };
  startedAt: string;
}

const metrics: MetricsRegistry = {
  httpRequestsTotal: {},
  httpRequestDurationSumMs: 0,
  httpRequestCount: 0,
  agentExecutionsTotal: {
    COMPLETED: 0,
    FAILED: 0,
    AWAITING_APPROVAL: 0,
  },
  tokenUsageTotal: {
    google: { input: 0, output: 0 },
    openrouter: { input: 0, output: 0 },
    ollama: { input: 0, output: 0 },
  },
  startedAt: new Date().toISOString(),
};

/**
 * Express middleware tracking HTTP request rates, status codes, and execution latencies.
 */
export function observabilityMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const routePath = req.route?.path || req.path || 'unknown';
      const key = `${req.method}:${routePath}:${res.statusCode}`;

      metrics.httpRequestsTotal[key] = (metrics.httpRequestsTotal[key] || 0) + 1;
      metrics.httpRequestDurationSumMs += durationMs;
      metrics.httpRequestCount += 1;
    });

    next();
  };
}

/**
 * Records multi-agent state transition executions (COMPLETED, FAILED, AWAITING_APPROVAL).
 */
export function recordAgentExecution(status: string) {
  const normalizedStatus = status.toUpperCase();
  metrics.agentExecutionsTotal[normalizedStatus] = (metrics.agentExecutionsTotal[normalizedStatus] || 0) + 1;
}

/**
 * Records token consumption metrics by provider and token type (input/output).
 */
export function recordTokenUsage(provider: string, inputTokens: number, outputTokens: number) {
  const pKey = provider.toLowerCase();
  if (!metrics.tokenUsageTotal[pKey]) {
    metrics.tokenUsageTotal[pKey] = { input: 0, output: 0 };
  }
  metrics.tokenUsageTotal[pKey].input += inputTokens;
  metrics.tokenUsageTotal[pKey].output += outputTokens;
}

/**
 * Returns a formatted snapshot of real-time system metrics.
 */
export function getMetricsSnapshot() {
  const avgLatencyMs = metrics.httpRequestCount > 0
    ? Number((metrics.httpRequestDurationSumMs / metrics.httpRequestCount).toFixed(2))
    : 0;

  return {
    uptime_seconds: Math.floor((Date.now() - new Date(metrics.startedAt).getTime()) / 1000),
    http: {
      total_requests: metrics.httpRequestCount,
      average_latency_ms: avgLatencyMs,
      requests_by_endpoint: metrics.httpRequestsTotal,
    },
    agents: {
      executions: metrics.agentExecutionsTotal,
    },
    llm: {
      token_usage: metrics.tokenUsageTotal,
    },
    collected_at: new Date().toISOString(),
  };
}
