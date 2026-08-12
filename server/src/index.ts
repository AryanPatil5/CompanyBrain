import { logger } from './logger.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import type { Server } from 'node:http';
import ingestionRouter from './routes/ingestion.js';
import sopsRouter from './routes/sops.js';
import integrationsRouter from './routes/integrations.js';
import webhooksRouter from './routes/webhooks.js';
import githubRouter from './routes/github.js';
import documentsRouter from './routes/documents.js';

import { observabilityMiddleware, getMetricsSnapshot } from './middleware/observability.js';
import { telemetryMiddleware, getPrometheusMetricsString } from './middleware/telemetry.js';
import { correlationIdMiddleware } from './middleware/correlationId.js';
import { registerBuiltinConnectors } from './connectors/register.js';
import {
  buildHealthPayload,
  checkAIProviderConfigured,
  checkPostgres,
  checkRedis,
  checkSupabase,
  getProcessStats,
} from './services/health.js';

dotenv.config();

export const DEV_SEED_WORKSPACE_ID = process.env.DEV_SEED_WORKSPACE_ID || '00000000-0000-0000-0000-000000000000';

if (process.env.NODE_ENV === 'production' && process.env.PROVISIONED_WORKSPACE_ID === DEV_SEED_WORKSPACE_ID) {
  throw new Error("FATAL: Production mode cannot be provisioned with demo seed workspace ID '00000000-0000-0000-0000-000000000000'.");
}

const app = express();
const PORT = process.env.PORT || 5001; // Updated default port to 5001 to avoid macOS AirPlay conflict

app.use(correlationIdMiddleware());
app.use(observabilityMiddleware());
app.use(telemetryMiddleware());

// Configure CORS to allow requests from local origins (Vite, TanStack, ngrok)
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow localhost, 127.0.0.1, ngrok, cloudflare origins, or non-browser requests
      if (
        !origin ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('ngrok') ||
        origin.includes('trycloudflare.com')
      ) {
        callback(null, origin || true);
      } else {
        callback(null, true);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-workspace-id',
      'ngrok-skip-browser-warning',
      'x-api-key',
    ],
  })
);

app.options('*', cors());

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
app.use('/api/v1/webhooks', webhooksRouter);
app.use('/api/github', githubRouter);
app.use('/api/documents', documentsRouter);

app.get('/health', async (_req, res) => {
  const payload = await buildHealthPayload(
    'api',
    {
      postgres: () => checkPostgres(),
      redis: () => checkRedis(),
      supabase: () => checkSupabase(),
      'ai-provider': () => checkAIProviderConfigured(),
    },
    getProcessStats('api')
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json(payload);
});

app.get('/api/metrics', (_req, res) => {
  res.json(getMetricsSnapshot());
});

app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(getPrometheusMetricsString());
});

/**
 * Starts the Express REST API server. Called by the `api` process only
 * (see bootstrap.ts / entrypoints/api.ts); worker startup moved to the
 * per-process boot topology.
 */
export function startApiServer(): Server {
  // The connector registry is process-local: register builtins before serving
  // so GET /api/ingestion/connectors can actually report them. Idempotent.
  registerBuiltinConnectors();

  const server = app.listen(PORT, () => {
    logger.info(`[INFO] Company Brain REST API running at http://localhost:${PORT}`);
  });
  return server;
}
