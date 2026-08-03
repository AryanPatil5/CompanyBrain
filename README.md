# Company Brain 🧠

> **The missing layer between raw company data and reliable AI automation.**  
> An AI-native operational knowledge engine that ingests fragmented team communication across 7 active sources (Slack, GitHub, Linear, Zendesk, Email, Database, Direct Teach), extracts structured Standard Operating Procedures (SOPs), maintains procedural freshness, and serves executable skills to AI agents via FastMCP.

---

## 🎯 What is Company Brain?

As AI models improve, the primary blocker to enterprise AI automation is no longer model intelligence—it's **scattered domain knowledge**. Knowledge lives in Slack threads, GitHub issue comments, Linear tickets, support emails, database runbooks, and tacit dictations.

Company Brain acts as a living map of how a company operates. It:
1. **Ingests** unstructured communication from multi-source webhooks and active historical crawlers (Slack, GitHub, Linear, Zendesk, Email, Database, Teach).
2. **Extracts** structured SOPs with triggers, preconditions, execution steps, step conditions, and failure handling using Zod-validated schema governance.
3. **Maintains Freshness** with immutable version history, automated staleness detection, and pgvector semantic conflict detection.
4. **Governs** procedures via human-in-the-loop Draft → Approved status control and real-time execution gate tickets for High/Critical risk SOPs.
5. **Exposes Executable Skills** to autonomous AI agents over Model Context Protocol (FastMCP) on `:8080` with direct target integration dispatching.

---

## 🏗️ Architecture

```
                                  ┌───────────────────────────┐
 ┌──────────────┐                 │       Company Brain       │                 ┌─────────────────────────┐
 │ Multi-Source │                 │                           │                 │     AI Agent Layer      │
 │  Ingestion   │                 │  ┌─────────────────────┐  │                 │                         │
 │              │ ── Webhooks ──> │  │ LLM Extraction &    │  │ ── FastMCP ───> │  Claude / Cursor /      │
 │ Slack        │                 │  │ Freshness Engine    │  │    Port 8080    │  Custom Autonomous      │
 │ GitHub       │                 │  └──────────┬──────────┘  │                 │  Agents                 │
 │ Linear       │                 │             │             │                 └─────────────────────────┘
 │ Zendesk      │                 │             ▼             │
 │ Email        │                 │  ┌─────────────────────┐  │
 │ Database     │                 │  │ Supabase Storage &  │  │
 │ Direct Teach │                 │  │ Glassmorphic UI    │  │
 └──────────────┘                 │  └─────────────────────┘  │
                                  └───────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** (v18+)
- **Supabase** project (free tier works)
- **OpenRouter API Key** (free models supported)

### 1. Backend Setup

```bash
cd server
npm install
```

Create `server/.env` based on `server/.env.example`:
```env
PORT=5001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_ANON_KEY=your_public_anon_key
VAULT_SECRET_KEY=generate_via_openssl_rand_hex_32
OPENROUTER_API_KEY=your_openrouter_key
```

*Note: User authentication is handled natively by Supabase Auth session tokens. OAuth tokens are encrypted at rest using AES-256-GCM (`VAULT_SECRET_KEY`). Generate a secret key via `openssl rand -hex 32`.*

Run database migrations in Supabase SQL Editor:
1. `server/supabase/create_skills_sops.sql`
2. `server/supabase/create_raw_threads_and_citations.sql`
3. `server/supabase/003_versioning_and_logs.sql`
4. `server/supabase/004_enterprise_guardrails_and_rbac.sql`
5. `server/supabase/005_ingestion_failures_and_embeddings.sql`
6. `server/supabase/006_crawled_sources_table.sql`
7. `server/supabase/007_tool_registry.sql`
8. `server/supabase/008_rls_hardening_and_vector_precision.sql`
9. `server/supabase/009_agent_registry.sql`
10. `server/supabase/010_single_use_approvals.sql`
11. `server/supabase/011_remove_workspace_bypass.sql`
12. `server/supabase/012_integration_installations.sql`
13. `server/supabase/013_rls_hardening_remaining_tables.sql`
14. `server/supabase/014_user_workspace_roles.sql`
15. `server/supabase/015_custom_access_token_hook.sql`
16. `server/supabase/016_integration_credentials.sql`
17. `server/supabase/017_oauth_state_nonces.sql`

#### Custom Access Token Hook Setup (Supabase Dashboard)
1. Go to **Supabase Dashboard** -> **Authentication** -> **Hooks (Beta)**.
2. Enable **Custom Access Token Hook**.
3. Select scheme: `public.custom_access_token_hook`.

### Connecting Slack, GitHub & Gmail (OAuth Setup)

To allow workspace administrators to connect integrations via the UI's **Settings → Integrations** modal:

#### 1. Slack OAuth App Setup
- Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps).
- Go to **OAuth & Permissions** -> Add Redirect URL: `{APP_BASE_URL}/api/integrations/slack/callback` (e.g. `http://localhost:5001/api/integrations/slack/callback`).
- Under **Bot Token Scopes**, add `channels:history`, `channels:read`, `chat:write`.
- Copy **Client ID**, **Client Secret**, and **Signing Secret** into `server/.env` (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`).

#### 2. GitHub App Setup
- Create a GitHub App at **Settings** -> **Developer settings** -> **GitHub Apps**.
- Set **Webhook URL** to `{APP_BASE_URL}/api/ingestion/webhook/github`.
- Set **Setup / Callback URL** to `{APP_BASE_URL}/api/integrations/github/callback`.
- Copy the App's URL slug into `GITHUB_APP_NAME` and the Webhook secret into `GITHUB_WEBHOOK_SECRET` in `server/.env`.

#### 3. Gmail OAuth Client Setup
- Open [Google Cloud Console](https://console.cloud.google.com) -> **APIs & Services** -> **Credentials**.
- Click **Create Credentials** -> **OAuth client ID** -> Select **Web application**.
- Add Authorized Redirect URI: `{APP_BASE_URL}/api/integrations/gmail/callback`.
- Enable the **Gmail API** under Library.
- Copy **Client ID** and **Client Secret** into `server/.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

*Once configured, workspace admins can connect each provider directly from the UI's Settings -> Integrations modal without manual database or `.env` modifications.*

#### Provision Admin & Team Users
Provision initial admin users with assigned workspace roles using the server script:
```bash
npx tsx server/src/scripts/provision_user.ts admin@company.com admin
```

Start the Express API & FastMCP Server:
```bash
npm run dev
```

- REST API runs at `http://localhost:5001`
- FastMCP Server runs at `http://localhost:8080/mcp`

### 2. Frontend Setup

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:3000` to view the **Glassmorphism Management UI**.

---

## 🔌 Ingestion Sources & Webhook Endpoints

Send payloads or trigger webhooks across 7 supported sources:

### 1. Slack
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "source": "slack",
    "external_thread_id": "thread_123",
    "channel_or_project": "billing-support",
    "messages": [
      {"user": "Sarah", "text": "When an invoice fails with code insufficient_funds and retry count >= 2, schedule a retry for 72 hours later in Stripe."},
      {"user": "Dave", "text": "And if ARR is over $25k, escalate immediately to the account manager on Slack."}
    ]
  }'
```

### 2. GitHub
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/github \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "external_thread_id": "gh-issue-99",
    "channel_or_project": "company/api",
    "messages": [
      {"user": "engineer-1", "text": "When deploy pipeline fails on staging: 1) Check health endpoint for 500 status. 2) Trigger rollback via Admin CLI. 3) Post commit SHA to #deploys on Slack."}
    ]
  }'
```

### 3. Linear
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/linear \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "external_thread_id": "lin-SEC-42",
    "channel_or_project": "SEC",
    "messages": [
      {"user": "Security Lead", "text": "When secret_scanner detects a leaked key in prod: 1) Revoke key in Admin CLI 2) Query audit logs in Postgres 3) Rotate secret in Vault 4) Post incident to #security."}
    ]
  }'
```

### 4. Zendesk Support
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/zendesk \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-admin-token" \
  -d '{
    "external_thread_id": "zd-ticket-8821",
    "channel_or_project": "tier3-support",
    "messages": [
      {"user": "Senior Tech", "text": "For enterprise SSO login timeouts: 1) Flush SAML session cache in Admin CLI 2) Verify metadata URL response in Postgres 3) Notify customer rep in Zendesk."}
    ]
  }'
```

### 5. Email Shared Inbox
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-admin-token" \
  -d '{
    "external_thread_id": "msg-em-991",
    "channel_or_project": "ops-inbox",
    "messages": [
      {"user": "ops-lead@company.com", "text": "Subject: High Memory Outage Runbook. When API pod memory usage exceeds 92%: 1) Dump heap trace 2) Restart pod in Admin CLI 3) Log incident to #ops."}
    ]
  }'
```

### 6. Database Runbooks & Query Logs
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/database \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-admin-token" \
  -d '{
    "external_thread_id": "db-proc-override-1",
    "channel_or_project": "postgres_primary",
    "messages": [
      {"user": "db_routine_scanner", "text": "EXPLICIT OPERATIONAL SOP DECREE: When Postgres idle_in_transaction count exceeds 15 for > 5m: 1) Query pg_stat_activity 2) Terminate deadlocked PIDs in Postgres 3) Post alert to #database-ops."}
    ]
  }'
```

### 7. Direct Tacit Knowledge Teach
```bash
curl -X POST http://localhost:5001/api/ingestion/webhook/teach \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer mock-admin-token" \
  -d '{
    "title": "Legacy VIP Refund Exception Protocol",
    "category": "Billing",
    "description": "When an enterprise customer requests an override refund above $1,000 within 14 days of renewal: 1) Verify contract status in Stripe 2) Confirm zero chargeback disputes in Stripe 3) Issue 50% credit memo 4) Log to #billing-approvals on Slack.",
    "steps": [
      "Verify contract status in Stripe",
      "Confirm zero chargeback disputes in Stripe",
      "Issue 50% credit memo",
      "Log to #billing-approvals on Slack"
    ]
  }'
```

---

## 🤖 FastMCP Tools for AI Agents

Connect any MCP-compatible client (Claude Desktop, Cursor, Custom Subagent) to `http://localhost:8080/mcp`.

| FastMCP Tool | Description | Human Gate Enforcement |
| :--- | :--- | :--- |
| `get_sop_by_id` | Retrieves approved SOP steps & trigger rules. | Blocks low-trust agents if High/Critical risk SOP is unapproved by manager. |
| `search_operational_sops` | Searches approved SOPs by category or keyword query. | None (read query). |
| `get_sop_with_history` | Fetches SOP details alongside version evolution snapshots. | None (audit query). |
| `request_execution_approval` | Submits a real-time human approval ticket to manager queue for High/Critical risk SOP execution. | Creates pending approval record in `pending_approvals`. |
| `check_approval_status` | Checks if a human manager has approved a pending execution ticket. | Reads approval status (`pending`, `approved`, `rejected`). |
| `execute_sop_step` | **Execution Engine**: Executes a step against target systems (Stripe, GitHub, Postgres, Slack, Admin CLI) via `integration_connections`. | Strictly rejects execution if High/Critical risk SOP lacks an approved manager ticket. Automatically logs outcome to `execution_logs`. |
| `log_sop_execution` | Logs agent execution outcomes back to Company Brain observability. | None (logging). |

---

## 📜 Tech Stack

- **Frontend**: React 19, TanStack Start/Router, Vite, Vanilla CSS / Glassmorphism Design System, Lucide Icons
- **Backend**: Node.js, Express, FastMCP, Supabase JS client
- **AI Extraction**: OpenRouter (Google Gemma 4 / Ling-3.0 Flash)
- **Database**: Supabase PostgreSQL (`pgvector` cosine similarity, JSONB execution steps, audit logs, `integration_connections` tool registry)
