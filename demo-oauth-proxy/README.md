# Company Brain — Demo OAuth Proxy

A tiny, standalone service whose only job is to hold the **real** client
secrets for the shared "try it in under a minute" Slack App and Google
OAuth Client, and perform the OAuth token exchange on their behalf.

## Why this exists

Slack and Google OAuth both require a server-side `client_secret` exchange
— unlike GitHub Apps, you can't complete the flow with just a public
`client_id`. That means a real shared demo experience for Slack/Gmail needs
a real secret *somewhere*. We don't want that secret:

- committed to the public Company Brain repo, or
- required in every self-hosted deployment's `.env` just to get a working demo.

So it lives here instead — one small service, deployed once, that the main
Company Brain backend calls over HTTPS. The main backend never sees the
secret, only the resulting access/refresh tokens.

## Endpoints

- `GET /health` — liveness check.
- `GET /config/:provider` — returns the demo app's public `client_id` for
  `slack` or `gmail`. Safe to expose; client IDs are always public in OAuth
  authorize URLs anyway.
- `POST /exchange/:provider` — exchanges an OAuth `code` for tokens.
  Requires an `x-proxy-secret` header matching `PROXY_SHARED_SECRET`, so
  only your trusted Company Brain backend can spend the demo app's quota.
  Body: `{ "code": "...", "redirect_uri": "..." }`.
  Returns tokens only — never the client secret.

## Deploying

This is a plain Express app — deploy it anywhere that can hold private env
vars (Render, Fly.io, Railway, a small VM, a container on your own infra).
It has no database and no state.

```bash
npm install
npm run build
npm start
```

Set these env vars on whatever platform you deploy to (see `.env.example`):

- `PROXY_SHARED_SECRET` — generate with `openssl rand -hex 32`
- `ALLOWED_ORIGINS` — your Company Brain backend's URL
- `DEMO_SLACK_CLIENT_ID` / `DEMO_SLACK_CLIENT_SECRET` — from the one Slack
  App registered for Company Brain demos
- `DEMO_GOOGLE_CLIENT_ID` / `DEMO_GOOGLE_CLIENT_SECRET` — from the one
  Google OAuth Client registered for Company Brain demos

## Wiring it up to the main app

In `server/.env`, set:

```
DEMO_PROXY_URL=https://your-deployed-proxy.example.com
DEMO_PROXY_SHARED_SECRET=<same value as PROXY_SHARED_SECRET above>
```

If `DEMO_PROXY_URL` is unset, the main app falls back to its existing
dev-only mock tokens for Slack/Gmail in non-production, and to "not
configured" in production — so nothing breaks if you choose not to run
this proxy at all (e.g. self-hosted deployments that only want admins to
use their own OAuth Apps via the Setup Wizard).

## Threat model notes

- The shared secret header stops randoms from using this as a free
  Slack/Google OAuth relay for their own apps.
- Rate limiting (30 req/min per IP) bounds abuse of the demo app's quota.
- `ALLOWED_ORIGINS` restricts CORS to your own backend.
- If the demo app is ever compromised or abused, only this isolated
  service and its two demo OAuth Apps are affected — not any customer's
  real credentials, which always live encrypted in their own Supabase
  project via the Setup Wizard (Option A), not here.
