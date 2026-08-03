#!/usr/bin/env node
// One-time setup wizard for the Company Brain "sign in and go" demo experience.
//
// Run this AFTER you've registered the three apps (see the README this
// script prints instructions for at each step). It writes:
//   - demo-oauth-proxy/.env   (the real secrets — deploy this service privately)
//   - server/.env             (adds/updates GITHUB_APP_NAME + DEMO_PROXY_* vars)
//
// Usage:  node scripts/setup-demo-proxy.mjs
//
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROXY_ENV_PATH = path.join(ROOT, 'demo-oauth-proxy', '.env');
const SERVER_ENV_PATH = path.join(ROOT, 'server', '.env');

const rl = readline.createInterface({ input: stdin, output: stdout });

function divider() {
  console.log('\n' + '─'.repeat(72) + '\n');
}

async function ask(question, { required = false, secret = false } = {}) {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer || !required) return answer;
    console.log('  (required — please paste a value)');
  }
}

function readExistingEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const out = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(filePath, values) {
  const existing = readExistingEnv(filePath);
  const merged = { ...existing, ...values };
  const body = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  fs.writeFileSync(filePath, body + '\n');
}

async function main() {
  console.log(`
Company Brain — one-time "sign in and go" setup

This registers ONE shared demo app per provider so that every future
user of this deployment can connect Slack / GitHub / Gmail just by
clicking "Connect" and signing in — no setup on their end, ever.

You'll need to have already created (or be ready to create) three apps.
This script will walk you through each one, then write the config files.
`);

  // ── Slack ──────────────────────────────────────────────────────────
  divider();
  console.log(`STEP 1 — Slack App

1. Go to https://api.slack.com/apps -> "Create New App" -> "From scratch"
2. Name it (e.g. "Company Brain"), pick your workspace
3. Left sidebar -> "OAuth & Permissions"
4. Under "Redirect URLs", add:
     <your deployed backend URL>/api/integrations/slack/callback
   (e.g. https://app.yourcompany.com/api/integrations/slack/callback)
5. Under "Scopes" -> "Bot Token Scopes", add:
     channels:history, channels:read, chat:write
6. Left sidebar -> "Basic Information" -> "App Credentials"
   Copy the Client ID and Client Secret from there.
`);
  const slackClientId = await ask('Slack Client ID: ', { required: true });
  const slackClientSecret = await ask('Slack Client Secret: ', { required: true });

  // ── GitHub ──────────────────────────────────────────────────────────
  divider();
  console.log(`STEP 2 — GitHub App

1. Go to https://github.com/settings/apps -> "New GitHub App"
2. Set "Homepage URL" to your app's URL
3. Set "Webhook URL" to:
     <your deployed backend URL>/api/ingestion/webhook/github
4. Set "Callback URL" to:
     <your deployed backend URL>/api/integrations/github/callback
5. Under Permissions, grant read access to repository contents + metadata
   (add more if you plan to ingest issues/PRs too)
6. Create the app, then note its "slug" from the URL, e.g.
     github.com/settings/apps/YOUR-APP-SLUG  ->  YOUR-APP-SLUG
7. Generate a webhook secret (any random string) and set it on the app.

GitHub Apps don't need a client secret for the install flow we use, so
that's all we need here.
`);
  const githubAppSlug = await ask('GitHub App slug: ', { required: true });
  const githubWebhookSecret = await ask('GitHub Webhook Secret (leave blank to skip): ');

  // ── Google ──────────────────────────────────────────────────────────
  divider();
  console.log(`STEP 3 — Google OAuth Client

1. Go to https://console.cloud.google.com/apis/credentials
2. Create a project (or pick one), then "Create Credentials" ->
   "OAuth client ID" -> Application type: "Web application"
3. Under "Authorized redirect URIs", add:
     <your deployed backend URL>/api/integrations/gmail/callback
4. Go to "APIs & Services" -> "Library" -> enable the "Gmail API"
5. Copy the Client ID and Client Secret from the credential you created.

Note: while your OAuth consent screen is in "Testing" mode, Google will
only let pre-approved test users sign in. Submit it for verification (or
publish it) when you're ready for anyone to connect.
`);
  const googleClientId = await ask('Google Client ID: ', { required: true });
  const googleClientSecret = await ask('Google Client Secret: ', { required: true });

  // ── Deployment details ────────────────────────────────────────────
  divider();
  console.log(`STEP 4 — Where you'll deploy the demo-oauth-proxy service

The proxy holds the Slack/Google secrets above and is deployed
separately from the main app (Render, Fly.io, Railway, a small VM —
anywhere that can hold private env vars). If you haven't deployed it
yet, leave this blank and set DEMO_PROXY_URL in server/.env manually
once you have.
`);
  const proxyUrl = await ask('Deployed proxy URL (e.g. https://demo-proxy.onrender.com), or blank: ');

  const sharedSecret = crypto.randomBytes(32).toString('hex');
  console.log(`\nGenerated a random PROXY_SHARED_SECRET for you (used by both files below).`);

  // ── Write demo-oauth-proxy/.env ─────────────────────────────────────
  fs.mkdirSync(path.dirname(PROXY_ENV_PATH), { recursive: true });
  writeEnv(PROXY_ENV_PATH, {
    PORT: '8787',
    NODE_ENV: 'production',
    PROXY_SHARED_SECRET: sharedSecret,
    ALLOWED_ORIGINS: '',
    DEMO_SLACK_CLIENT_ID: slackClientId,
    DEMO_SLACK_CLIENT_SECRET: slackClientSecret,
    DEMO_GOOGLE_CLIENT_ID: googleClientId,
    DEMO_GOOGLE_CLIENT_SECRET: googleClientSecret,
  });

  // ── Write server/.env ────────────────────────────────────────────
  fs.mkdirSync(path.dirname(SERVER_ENV_PATH), { recursive: true });
  writeEnv(SERVER_ENV_PATH, {
    GITHUB_APP_NAME: githubAppSlug,
    ...(githubWebhookSecret ? { GITHUB_WEBHOOK_SECRET: githubWebhookSecret } : {}),
    ...(proxyUrl ? { DEMO_PROXY_URL: proxyUrl } : {}),
    DEMO_PROXY_SHARED_SECRET: sharedSecret,
  });

  divider();
  console.log(`Done. Wrote:
  - demo-oauth-proxy/.env  (real secrets — deploy this file's values as env vars on your host, never commit it)
  - server/.env            (updated with GITHUB_APP_NAME + DEMO_PROXY_* vars)

Next steps:
  1. Deploy demo-oauth-proxy/ (see demo-oauth-proxy/README.md), setting its
     env vars from demo-oauth-proxy/.env on your hosting platform.
  2. If you left the proxy URL blank above, set DEMO_PROXY_URL in
     server/.env to the deployed proxy's URL once it's live.
  3. Also set ALLOWED_ORIGINS in the proxy's env to your backend's URL.
  4. Restart your Company Brain server.

From here, your client (and anyone else using this deployment) connects
Slack / GitHub / Gmail by clicking "Connect" in the Integrations panel
and signing in — no setup on their end.
`);

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
