import net from 'net';

async function checkTcpPort(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      status = true;
      socket.destroy();
    });
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('timeout', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      resolve(status);
    });

    socket.connect(port, host);
  });
}

async function checkOllama(host = 'localhost', port = 11434) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://${host}:${port}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models.map((m) => m.name || m.model) : [];
      const hasNomic = models.some((m) => m.includes('nomic-embed-text'));
      return {
        online: true,
        models,
        hasNomic,
        details: hasNomic ? 'Active (nomic-embed-text installed)' : `Active (models: ${models.length ? models.join(', ') : 'none'})`,
      };
    }
  } catch (err) {
    // Offline
  }

  return { online: false, models: [], hasNomic: false, details: 'Offline / Unreachable' };
}

async function runCheck() {
  console.log('\n=============================================================');
  console.log('       Company Brain — Infrastructure Dependency Check       ');
  console.log('=============================================================\n');

  const redisStatus = await checkTcpPort('localhost', 6379);
  const postgresStatus = await checkTcpPort('localhost', 5432);
  const ollamaInfo = await checkOllama('localhost', 11434);

  const results = [
    {
      Service: 'Redis Queue',
      Endpoint: 'localhost:6379',
      Status: redisStatus ? 'HEALTHY' : 'UNREACHABLE',
      Details: redisStatus ? 'Active (Port 6379 responding)' : 'Ensure Redis container is running',
    },
    {
      Service: 'PostgreSQL',
      Endpoint: 'localhost:5432',
      Status: postgresStatus ? 'HEALTHY' : 'UNREACHABLE',
      Details: postgresStatus ? 'Active (Port 5432 responding)' : 'Ensure Postgres container is running',
    },
    {
      Service: 'Ollama Vector Engine',
      Endpoint: 'http://localhost:11434',
      Status: ollamaInfo.online ? 'HEALTHY' : 'STANDBY / OFFLINE',
      Details: ollamaInfo.details,
    },
  ];

  console.table(results);

  const overallHealthy = redisStatus && postgresStatus;
  console.log('\n-------------------------------------------------------------');
  if (overallHealthy) {
    console.log('✅ OVERALL ENVIRONMENT STATUS: HEALTHY');
  } else {
    console.log('⚠️  OVERALL ENVIRONMENT STATUS: PARTIAL / ACTION REQUIRED');
    console.log('    Run `docker compose up -d` to start local dependencies.');
  }
  console.log('=============================================================\n');
}

runCheck().catch((err) => {
  console.error('Environment check failed:', err);
  process.exit(1);
});
