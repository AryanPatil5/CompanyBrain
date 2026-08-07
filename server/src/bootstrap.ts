// bootstrap.ts
// Phase 0 (ADR-T9): process-topology boot. Dispatches to entrypoint workloads
// selected by the PROCESSES env var. Each process can run independently via its
// entrypoint (server/src/entrypoints/*.ts) or together in one process for dev.

import dotenv from 'dotenv';
import type { Server } from 'node:http';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { isProduction, getKeyProvider } from './services/security/keyProvider.js';
import { initializeOpenTelemetry, shutdownOpenTelemetry } from './config/otel.js';
import { logger } from './logger.js';

dotenv.config();

export const PROCESSES = (process.env.PROCESSES || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

export const KNOWN_PROCESSES = [
  'api',
  'mcp',
  'crawler',
  'ingestion-worker',
  'github-sync-worker',
  'temporal-worker',
] as const;

export type ProcessName = (typeof KNOWN_PROCESSES)[number];

// Development convenience: with no PROCESSES env, boot everything in one
// process (preserves the historical `npm run dev` behavior). Production
// requires an explicit PROCESSES list.
const DEFAULT_DEV_PROCESSES: ProcessName[] = [
  'api',
  'mcp',
  'crawler',
  'ingestion-worker',
  'github-sync-worker',
  'temporal-worker',
];

let initialized = false;
let pidFile: string | null = null;
let apiServer: Server | null = null;
let shuttingDown = false;
const startedProcesses = new Set<string>();

function pidFileFor(name: string): string {
  return `./pid.${name}`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err && err.code === 'EPERM';
  }
}

function acquirePidFile(name: string): void {
  const path = pidFileFor(name);
  if (existsSync(path)) {
    const existing = parseInt(readFileSync(path, 'utf8').trim(), 10);
    if (Number.isFinite(existing) && existing !== process.pid && isProcessAlive(existing)) {
      throw new Error(`Another '${name}' process is already running (pid=${existing}). Exit.`);
    }
  }
  writeFileSync(path, process.pid.toString());
  pidFile = path;
}

function releasePidFile(): void {
  if (pidFile && existsSync(pidFile)) {
    unlinkSync(pidFile);
    pidFile = null;
  }
}

/**
 * Starts the workload for a single process name. Worker modules are loaded
 * lazily so each process only imports its own dependencies.
 */
async function startProcess(name: ProcessName): Promise<void> {
  switch (name) {
    case 'api': {
      const { startApiServer } = await import('./index.js');
      apiServer = startApiServer();
      break;
    }
    case 'mcp': {
      const { startMCPServer } = await import('./services/mcp.js');
      startMCPServer();
      break;
    }
    case 'crawler': {
      const { startCrawlerWorker } = await import('./services/crawler.js');
      startCrawlerWorker();
      break;
    }
    case 'ingestion-worker': {
      const { startIngestionWorker } = await import('./workers/ingestionWorker.js');
      startIngestionWorker();
      break;
    }
    case 'github-sync-worker': {
      const { startGithubSyncWorker } = await import('./workers/githubSyncWorker.js');
      startGithubSyncWorker();
      break;
    }
    case 'temporal-worker': {
      const { startTemporalWorker } = await import('./workers/temporalWorker.js');
      await startTemporalWorker();
      break;
    }
  }
  startedProcesses.add(name);
  logger.info(`Process started: ${name}`);
}

/**
 * Stops the workload for a started process name (best effort).
 */
async function stopProcess(name: string): Promise<void> {
  switch (name) {
    case 'api':
      if (apiServer) {
        await new Promise<void>((resolve) => {
          apiServer!.close(() => resolve());
        });
      }
      break;
    case 'mcp':
      // FastMCP has no stop handle; process exit tears it down.
      break;
    case 'crawler': {
      const { stopCrawlerWorker } = await import('./services/crawler.js');
      stopCrawlerWorker();
      break;
    }
    case 'ingestion-worker': {
      const { stopIngestionWorker } = await import('./workers/ingestionWorker.js');
      await stopIngestionWorker();
      break;
    }
    case 'github-sync-worker': {
      const { stopGithubSyncWorker } = await import('./workers/githubSyncWorker.js');
      await stopGithubSyncWorker();
      break;
    }
    case 'temporal-worker': {
      const { stopTemporalWorker } = await import('./workers/temporalWorker.js');
      await stopTemporalWorker();
      break;
    }
  }
  startedProcesses.delete(name);
}

async function shutdownGracefully(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down Company Brain processes');
  for (const name of [...startedProcesses]) {
    try {
      await stopProcess(name);
    } catch (err) {
      logger.warn(`Failed to stop process ${name}`, { error: (err as Error).message });
    }
  }
  await shutdownOpenTelemetry();
  releasePidFile();
  process.exit(0);
}

/**
 * Boots the requested processes. Prefers the explicit array argument (used by
 * entrypoints); falls back to the PROCESSES env var; in development with
 * neither set, boots every process in one process.
 */
async function bootstrap(processes: string[] = []): Promise<void> {
  // Production boot refuses mock credentials: the key provider must be
  // explicitly configured and must not be the dev/test-only MemoryKeyProvider.
  if (isProduction()) {
    try {
      getKeyProvider();
    } catch (err: any) {
      logger.fatal(`Key provider configuration rejected at boot: ${err.message}`);
      process.exit(1);
    }
  }

  initializeOpenTelemetry();

  const explicit = (processes || []).map((p) => p.trim()).filter(Boolean);
  let names: string[] = explicit.length > 0 ? explicit : PROCESSES;

  if (names.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      logger.fatal(
        `PROCESSES env variable must be set in production. Supported: ${KNOWN_PROCESSES.join(', ')}`
      );
      process.exit(1);
    }
    logger.warn(
      `PROCESSES env not set. Defaulting to all processes (DEVELOPMENT ONLY): ${DEFAULT_DEV_PROCESSES.join(', ')}`
    );
    names = [...DEFAULT_DEV_PROCESSES];
  }

  const unique = [...new Set(names)];
  for (const name of unique) {
    if (!KNOWN_PROCESSES.includes(name as ProcessName)) {
      logger.fatal(`Unknown process '${name}'. Supported: ${KNOWN_PROCESSES.join(', ')}`);
      process.exit(1);
    }
  }

  if (!initialized) {
    initialized = true;
  }

  process.on('SIGINT', shutdownGracefully);
  process.on('SIGTERM', shutdownGracefully);

  for (const name of unique) {
    const entry = name as ProcessName;
    try {
      acquirePidFile(entry);
      await startProcess(entry);
    } catch (err) {
      logger.error(`Failed to start process '${entry}'`, { error: (err as Error).message });
      releasePidFile();
      process.exit(1);
    }
  }

  logger.info(`Bootstrapped processes: ${unique.join(', ')} (pid=${process.pid})`);
}

export { bootstrap };

// Self-execute when run directly (npm run dev / npm start / make dev):
// boots the PROCESSES env list, defaulting to all processes in dev.
if (import.meta.url === `file://${process.argv[1]}`) {
  void bootstrap();
}
