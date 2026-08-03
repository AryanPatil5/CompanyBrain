import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ingestionRouter from './routes/ingestion.js';
import sopsRouter from './routes/sops.js';
import integrationsRouter from './routes/integrations.js';
import { startMCPServer } from './services/mcp.js';
import { startCrawlerWorker, stopCrawlerWorker } from './services/crawler.js';
import { startIngestionWorker, stopIngestionWorker } from './workers/ingestionWorker.js';

dotenv.config();

export const DEV_SEED_WORKSPACE_ID = process.env.DEV_SEED_WORKSPACE_ID || '00000000-0000-0000-0000-000000000000';

if (process.env.NODE_ENV === 'production' && process.env.PROVISIONED_WORKSPACE_ID === DEV_SEED_WORKSPACE_ID) {
  throw new Error("FATAL: Production mode cannot be provisioned with demo seed workspace ID '00000000-0000-0000-0000-000000000000'.");
}

const app = express();
const PORT = process.env.PORT || 5001; // Updated default port to 5001 to avoid macOS AirPlay conflict

// Configure CORS to allow requests from any development origin (Vite, TanStack, ngrok)
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server) or dev origins
      if (!origin || process.env.NODE_ENV !== 'production' || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('ngrok')) {
        callback(null, true);
      } else {
        callback(null, true);
      }
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

// Register API Routes
app.use('/api/ingestion', ingestionRouter);
app.use('/api/sops', sopsRouter);
app.use('/api/integrations', integrationsRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Company Brain Backend' });
});

// Start Express API Server
const server = app.listen(PORT, () => {
  console.log(`[INFO] Company Brain REST API running at http://localhost:${PORT}`);
});

// Start FastMCP Server for AI Agents
startMCPServer();

// Start Background Knowledge Crawler Worker
startCrawlerWorker();

// Start BullMQ Asynchronous Ingestion Worker (Concurrency: 2)
startIngestionWorker();

// Graceful Shutdown Handlers
const shutdown = async () => {
  console.log('[INFO] Gracefully shutting down Express server...');
  stopCrawlerWorker();
  await stopIngestionWorker();
  server.close(() => {
    console.log('[INFO] Server closed and port released.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);