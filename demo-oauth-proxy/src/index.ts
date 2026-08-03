import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

// ─────────────────────────────────────────────────────────────────────────
// Company Brain — Demo OAuth Proxy
//
// This is a SEPARATE, standalone service. It is the only place the real
// client_secret for the shared "try it in under a minute" Slack App and
// Google OAuth Client ever exists. It is intentionally not part of the
// main `server/` app so that:
//   - the secrets never end up in the public repo
//   - self-hosted Company Brain deployments never need the real secrets
//   - if the demo app is ever abused/rate-limited, only this tiny surface
//     is affected
//
// A self-hosted Company Brain backend calls this service over HTTPS:
//   GET  /config/:provider              -> public client_id for building
//                                          the browser authorize URL
//   POST /exchange/:provider            -> exchanges an OAuth `code` for
//                                          tokens using the real secret,
//                                          and returns ONLY the resulting
//                                          access/refresh tokens (never
//                                          the secret itself).
//
// Deploy this anywhere that can hold env vars privately (Render, Fly.io,
// Railway, a small VM, etc.) and point the main app's
// DEMO_PROXY_URL / DEMO_PROXY_SHARED_SECRET at it. See README.md.
// ─────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;
const PROXY_SHARED_SECRET = process.env.PROXY_SHARED_SECRET;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!PROXY_SHARED_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: PROXY_SHARED_SECRET must be set in production. This protects the demo app from abuse.');
}

app.use(
  cors({
    origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : false,
  })
);

// Generous but bounded — this is a shared demo app, not meant for production traffic.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Demo credentials for each supported provider. Real secrets live ONLY here.
const PROVIDERS: Record<string, { clientId?: string; clientSecret?: string; tokenUrl: string }> = {
  slack: {
    clientId: process.env.DEMO_SLACK_CLIENT_ID,
    clientSecret: process.env.DEMO_SLACK_CLIENT_SECRET,
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
  },
  gmail: {
    clientId: process.env.DEMO_GOOGLE_CLIENT_ID,
    clientSecret: process.env.DEMO_GOOGLE_CLIENT_SECRET,
    tokenUrl: 'https://oauth2.googleapis.com/token',
  },
};

function requireSharedSecret(req: Request, res: Response, next: NextFunction): void {
  if (!PROXY_SHARED_SECRET) {
    // Dev convenience only — never reached in production due to the startup check above.
    next();
    return;
  }
  const provided = req.header('x-proxy-secret');
  if (provided !== PROXY_SHARED_SECRET) {
    res.status(401).json({ error: 'Invalid or missing proxy shared secret.' });
    return;
  }
  next();
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Public: just the client_id, which is always exposed in browser OAuth redirects anyway.
app.get('/config/:provider', (req: Request, res: Response) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider || !provider.clientId) {
    res.status(404).json({ error: `No demo app configured for provider '${req.params.provider}'.` });
    return;
  }
  res.json({ client_id: provider.clientId });
});

// Protected: performs the real token exchange. Requires the shared secret header
// so only the trusted Company Brain backend(s) can spend the demo app's quota.
app.post('/exchange/:provider', requireSharedSecret, async (req: Request, res: Response) => {
  try {
    const providerKey = req.params.provider;
    const provider = PROVIDERS[providerKey];
    const { code, redirect_uri } = req.body as { code?: string; redirect_uri?: string };

    if (!provider || !provider.clientId || !provider.clientSecret) {
      res.status(404).json({ error: `No demo app configured for provider '${providerKey}'.` });
      return;
    }
    if (!code || !redirect_uri) {
      res.status(400).json({ error: 'Missing code or redirect_uri.' });
      return;
    }

    if (providerKey === 'slack') {
      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code,
          redirect_uri,
        }),
      });
      const data = await tokenRes.json();
      if (!data.ok) {
        res.status(400).json({ error: 'slack_oauth_failed', detail: data.error || null });
        return;
      }
      res.json({
        access_token: data.access_token,
        external_org_id: data.team?.id || null,
      });
      return;
    }

    if (providerKey === 'gmail') {
      const tokenRes = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          redirect_uri,
          grant_type: 'authorization_code',
        }),
      });
      const data = await tokenRes.json();
      if (data.error) {
        res.status(400).json({ error: 'gmail_oauth_failed', detail: data.error });
        return;
      }
      res.json({
        access_token: data.access_token,
        refresh_token: data.refresh_token || null,
      });
      return;
    }

    res.status(400).json({ error: `Unsupported provider '${providerKey}'.` });
  } catch (err) {
    console.error('[Demo Proxy Exchange Error]:', err);
    res.status(500).json({ error: 'Token exchange failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`[demo-oauth-proxy] listening on port ${PORT}`);
});
