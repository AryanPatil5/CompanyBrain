// Environment check (Phase 1 hardening): verifies the services the stack
// actually uses (Redis, Postgres via docker-compose; Supabase + .env config)
// instead of Ollama, which is not part of the compose stack. Read-only.
import net from 'net';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', '.env');

const REQUIRED_ENV_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VAULT_SECRET_KEY',
  'OPENROUTER_API_KEY',
];

const OPTIONAL_ENV_KEYS = [
  'SUPABASE_ANON_KEY',
  'DATABASE_URL',
  'REDIS_URL',
  'PROCESSES',
  'LOG_LEVEL',
];

async function checkTcpPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      status = true;
      socket.destroy();
    });
    socket.on('error', () => socket.destroy());
    socket.on('timeout', () => socket.destroy());
    socket.on('close', () => resolve(status));

    socket.connect(port, host);
  });
}

async function checkHttps(url, timeoutMs = 4000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return { reachable: res.ok || res.status < 500, status: res.status };
  } catch {
    return { reachable: false, status: 'unreachable' };
  }
}

function checkEnvFile() {
  if (!existsSync(SERVER_ENV_PATH)) {
    return { present: false, presentKeys: [], missing: REQUIRED_ENV_KEYS };
  }
  const content = readFileSync(SERVER_ENV_PATH, 'utf8');
  const defined = new Set(
    content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => line.split('=')[0].trim()),
  );
  return {
    present: true,
    presentKeys: [...defined],
    missing: REQUIRED_ENV_KEYS.filter((k) => !defined.has(k)),
  };
}

async function runCheck() {
  console.log('\n=============================================================');
  console.log('       Company Brain — Infrastructure Dependency Check       ');
  console.log('=============================================================\n');

  const redisStatus = await checkTcpPort('localhost', 6379);
  const postgresStatus = await checkTcpPort('localhost', 5432);
  const env = checkEnvFile();

  let supabaseUrl = null;
  let supabaseReachable = false;
  if (env.present) {
    const urlLine = env.presentKeys.includes('SUPABASE_URL')
      ? readFileSync(SERVER_ENV_PATH, 'utf8').split('\n').find((l) => l.trim().startsWith('SUPABASE_URL='))
      : null;
    supabaseUrl = urlLine ? urlLine.split('=').slice(1).join('=').trim() : null;
  }
  if (supabaseUrl && /^https?:\/\//.test(supabaseUrl)) {
    const probe = await checkHttps(supabaseUrl.replace(/\/+$/, ''));
    supabaseReachable = probe.reachable;
  }

  const results = [
    {
      Service: 'Redis Queue',
      Endpoint: 'localhost:6379',
      Status: redisStatus ? 'HEALTHY' : 'UNREACHABLE',
      Details: redisStatus ? 'Active (Port 6379 responding)' : 'Ensure Redis container is running',
    },
    {
      Service: 'PostgreSQL (docker compose)',
      Endpoint: 'localhost:5432',
      Status: postgresStatus ? 'HEALTHY' : 'UNREACHABLE',
      Details: postgresStatus ? 'Active (Port 5432 responding)' : 'Ensure Postgres container is running',
    },
    {
      Service: 'Supabase',
      Endpoint: supabaseUrl || 'server/.env missing SUPABASE_URL',
      Status: env.present && supabaseUrl && supabaseReachable ? 'HEALTHY' : 'UNREACHABLE',
      Details: env.present && supabaseUrl
        ? supabaseReachable ? 'Reachable (HTTPS)' : 'Not reachable over HTTPS'
        : 'Set SUPABASE_URL in server/.env',
    },
  ];

  console.table(results);

  if (!env.present) {
    console.log('⚠️  server/.env not found — copy server/.env.example and fill in the required values.');
  } else if (env.missing.length > 0) {
    console.log(`⚠️  server/.env is missing required keys: ${env.missing.join(', ')}`);
  } else {
    console.log('✅ server/.env present with all required keys.');
  }
  const optionalMissing = OPTIONAL_ENV_KEYS.filter((k) => !env.presentKeys.includes(k));
  if (optionalMissing.length) {
    console.log(`ℹ️  Optional keys not set: ${optionalMissing.join(', ')}`);
  }

  const overallHealthy = redisStatus && postgresStatus && env.present && env.missing.length === 0;
  console.log('\n-------------------------------------------------------------');
  if (overallHealthy) {
    console.log('✅ OVERALL ENVIRONMENT STATUS: HEALTHY');
  } else {
    console.log('⚠️  OVERALL ENVIRONMENT STATUS: PARTIAL / ACTION REQUIRED');
    console.log('    Run `docker compose up -d` to start local dependencies;');
    console.log('    fill server/.env per server/.env.example; run `npm run migrate --prefix server`.');
  }
  console.log('=============================================================\n');
}

runCheck().catch((err) => {
  console.error('Environment check failed:', err);
  process.exit(1);
});
