import { logger } from '../logger.js';
// Per-process health endpoints (Phase 0 Task 2).
// Every process exposes GET /health on its own port. The HTTP layer always
// returns 200 while the process is alive; dependency health is reported
// inside the JSON payload. Dependency checks are individually bounded and
// fail closed without ever crashing the request.

import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { supabase } from '../config/supabase.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version?: string };

export const SERVICE_VERSION = packageJson.version || '0.0.0';
export const PROCESS_STARTED_AT = new Date();

export type DependencyStatus = 'ok' | 'unavailable';
export type DependencyCheck = () => Promise<boolean>;

export interface HealthPayload {
  status: 'ok';
  process: string;
  version: string;
  uptime: number;
  pid: number;
  startedAt: string;
  dependencies: Record<string, DependencyStatus>;
  details?: Record<string, unknown>;
}

export interface HealthServerOptions {
  checks: Record<string, DependencyCheck>;
  details?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Bounds an arbitrary promise so a hung dependency cannot hang the health
 * endpoint. The inner promise's rejection is pre-handled to avoid unhandled
 * rejection warnings when the timeout wins the race.
 */
export function withTimeout<T>(timeoutMs: number, promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Health check timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export function checkRedis(redisUrl?: string, timeoutMs = 2000): Promise<boolean> {
  const url = redisUrl || process.env.REDIS_URL || 'redis://localhost:6379';
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  return withTimeout(timeoutMs, (async () => {
    try {
      await client.connect();
      return (await client.ping()) === 'PONG';
    } catch {
      return false;
    } finally {
      client.disconnect();
    }
  })()).catch(() => false);
}

export function checkPostgres(databaseUrl?: string, timeoutMs = 2000): Promise<boolean> {
  const url =
    databaseUrl ||
    process.env.DATABASE_URL ||
    'postgresql://brain_user:brain_password@localhost:5432/company_brain';
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  return withTimeout(timeoutMs, (async () => {
    try {
      await client.connect();
      const result = await client.query('SELECT 1');
      return result.rows.length === 1;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => {});
    }
  })()).catch(() => false);
}

export function checkSupabase(timeoutMs = 2500): Promise<boolean> {
  return withTimeout(timeoutMs, (async () => {
    try {
      const { error } = await supabase.from('sop_versions').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  })()).catch(() => false);
}

export function checkAIProviderConfigured(): Promise<boolean> {
  const hasProviderKey = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'].some(
    (name) => (process.env[name] || '').trim().length > 0
  );
  const ollamaEnabled = process.env.ENABLE_OLLAMA === 'true';
  return Promise.resolve(hasProviderKey || ollamaEnabled);
}

export async function checkEmbeddingProvider(timeoutMs = 2500): Promise<boolean> {
  try {
    const { getEmbeddingProvider } = await import('./embeddingProvider.js');
    const provider = getEmbeddingProvider();
    return await withTimeout(timeoutMs, provider.healthCheck());
  } catch {
    return false;
  }
}

export async function checkTemporalConnectivity(address?: string, timeoutMs = 2500): Promise<boolean> {
  const temporalAddress = address || process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  try {
    const workerModule: any = await import('@temporalio/worker').catch(() => null);
    if (!workerModule?.NativeConnection) return false;
    return await withTimeout(timeoutMs, (async () => {
      let connection: any;
      try {
        connection = await workerModule.NativeConnection.connect({ address: temporalAddress });
        return true;
      } catch {
        return false;
      } finally {
        if (connection) await connection.close().catch(() => {});
      }
    })());
  } catch {
    return false;
  }
}

export interface QueueCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export async function checkBullMQQueueCounts(
  queue: { getJobCounts(): Promise<Record<string, number>> },
  timeoutMs = 2000
): Promise<QueueCounts | null> {
  const guarded = Promise.resolve().then(() => queue.getJobCounts()).catch(() => null);
  try {
    const counts = await withTimeout(timeoutMs, guarded);
    if (!counts) return null;
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch {
    return null;
  }
}

const processStats = new Map<string, Map<string, unknown>>();

export function setProcessStat(processName: string, key: string, value: unknown): void {
  let map = processStats.get(processName);
  if (!map) {
    map = new Map();
    processStats.set(processName, map);
  }
  map.set(key, value);
}

export function getProcessStats(processName: string): Record<string, unknown> {
  const map = processStats.get(processName);
  return map ? Object.fromEntries(map) : {};
}

export async function buildHealthPayload(
  processName: string,
  checks: Record<string, DependencyCheck>,
  details?: Record<string, unknown>
): Promise<HealthPayload> {
  const entries = Object.entries(checks);
  const results = await Promise.allSettled(entries.map(([, check]) => Promise.resolve().then(check)));
  const dependencies: Record<string, DependencyStatus> = {};
  entries.forEach(([name], index) => {
    const result = results[index];
    dependencies[name] = result.status === 'fulfilled' && result.value === true ? 'ok' : 'unavailable';
  });
  return {
    status: 'ok',
    process: processName,
    version: SERVICE_VERSION,
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT.toISOString(),
    dependencies,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

const healthServers = new Map<string, Server>();

export function startHealthServer(
  processName: string,
  port: number,
  options: HealthServerOptions
): Server {
  const existing = healthServers.get(processName);
  if (existing && existing.listening) return existing;

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/health' && url.pathname !== '/healthz') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    Promise.resolve()
      .then(async () => {
        const details =
          typeof options.details === 'function' ? await options.details() : options.details;
        const payload = await buildHealthPayload(processName, options.checks, details);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      })
      .catch(() => {
        const payload = {
          status: 'ok' as const,
          process: processName,
          version: SERVICE_VERSION,
          uptime: Math.round(process.uptime()),
          pid: process.pid,
          startedAt: PROCESS_STARTED_AT.toISOString(),
          dependencies: {},
        };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
      });
  });

  server.on('error', (err) => {
    logger.error(`[Health] '${processName}' health server error:`, (err as Error).message);
  });

  server.listen(port, () => {
    logger.info(`[INFO] Health endpoint '${processName}' at http://localhost:${port}/health`);
  });

  healthServers.set(processName, server);
  return server;
}

export function stopHealthServer(processName: string): void {
  const server = healthServers.get(processName);
  if (server) {
    server.close();
    healthServers.delete(processName);
  }
}
