// bootstrap.ts
export const PROCESSES = (process.env.PROCESSES || '').split(',').filter(Boolean) as string[];

function normalizeProcessList(value: unknown): string[] {
  if (value === true || value === 'true' || value === '1') return [String(value)];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') return value.split(',').filter(Boolean) as string[];
  return [];
}

let initialized = false;
let pidFile: string | null = null;

function acquirePidFile(path: string = './pid'): void {
  const fs = require('fs');
  const content = fs.readFileSync(path, 'utf8').trim();
  if (!content) {
    fs.writeFileSync(path, process.pid.toString());
    pidFile = path;
    return;
  }
  const existingPid = parseInt(content, 10);
  if (existingPid && existingPid !== process.pid) {
    throw new Error(`Another instance is already running (pid=${existingPid}). Exit.`);
  }
}

function releasePidFile(): void {
  if (pidFile && require('fs').existsSync(pidFile)) {
    require('fs').unlinkSync(pidFile);
  }
}

async function bootstrap(processes: string[]): Promise<void> {
  const configuredProcesses = normalizeProcessList(processes);
  if (configuredProcesses.length === 0) {
    console.log('[WARN] PROCESSES env not set or empty. Defaulting to single-process monolithic mode (DEVELOPMENT).');
    console.log('[WARN] Set PROCESSES=api,mcp,crawler,ingestion-worker,temporal-worker for full Phase 0 multi-process deployment.');
    process.exit(1);
  }

  if (!initialized) {
    if (require('fs').existsSync('./pid')) {
      throw new Error('PID file already exists. Another instance may be running.');
    }
    acquirePidFile();
    initialized = true;
  }

  console.log(`[INFO] Bootstrapping as processes: ${configuredProcesses.join(', ')} (pid=${process.pid})`);

  if (configuredProcesses.includes('crawler')) {
    console.log('[INFO] Crawler process started');
  }
  if (configuredProcesses.includes('ingestion-worker')) {
    console.log('[INFO] Ingestion worker process started');
  }
  if (configuredProcesses.includes('temporal-worker')) {
    console.log('[INFO] Temporal worker process started');
  }
  if (configuredProcesses.includes('api')) {
    console.log('[INFO] API process started');
  }
  if (configuredProcesses.includes('mcp')) {
    console.log('[INFO] MCP server process started');
  }

  process.on('SIGINT', () => {
    console.log('[INFO] Received SIGINT');
    releasePidFile();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    console.log('[INFO] Received SIGTERM');
    releasePidFile();
    process.exit(0);
  });

  const enabledProcesses = configuredProcesses;

  if (enabledProcesses.includes('crawler')) {
    await import('./services/crawler.js');
  }

  if (enabledProcesses.includes('ingestion-worker')) {
    await import('./workers/ingestionWorker.js');
  }

  if (enabledProcesses.includes('temporal-worker')) {
    await import('./workers/temporalWorker.js');
  }

  if (enabledProcesses.includes('api')) {
    await import('./entrypoints/api.js');
  }

  if (enabledProcesses.includes('mcp')) {
    await import('./entrypoints/mcpServer.js');
  }
}

export { bootstrap };
