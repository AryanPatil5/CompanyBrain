import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ingestionRouter from './routes/ingestion.js';
import sopsRouter from './routes/sops.js';
import { startMCPServer } from './services/mcp.js';
import { startCrawlerWorker, stopCrawlerWorker } from './services/crawler.js';

dotenv.config();

export const DEV_SEED_WORKSPACE_ID = process.env.DEV_SEED_WORKSPACE_ID || '00000000-0000-0000-0000-000000000000';

if (process.env.NODE_ENV === 'production' && process.env.PROVISIONED_WORKSPACE_ID === DEV_SEED_WORKSPACE_ID) {
  throw new Error("FATAL: Production mode cannot be provisioned with demo seed workspace ID '00000000-0000-0000-0000-000000000000'.");
}

const app = express();
const PORT = process.env.PORT || 5001; // Updated default port to 5001 to avoid macOS AirPlay conflict

// Configure CORS to allow requests from your Lovable / Vite frontend ports
app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'http://localhost:8080',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:8080',
    ],
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

// Graceful Shutdown Handlers
const shutdown = () => {
  console.log('[INFO] Gracefully shutting down Express server...');
  stopCrawlerWorker();
  server.close(() => {
    console.log('[INFO] Server closed and port released.');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);