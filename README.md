# Company Brain 🧠

> **The missing layer between raw company data and reliable AI automation.**  
> An AI-native operational knowledge engine that ingests fragmented team communication (Slack, GitHub, Linear), extracts structured Standard Operating Procedures (SOPs), maintains procedural freshness, and serves executable skills to AI agents via FastMCP.

---

## 🎯 What is Company Brain?

As AI models improve, the primary blocker to enterprise AI automation is no longer model intelligence—it's **scattered domain knowledge**. Knowledge lives in Slack threads, GitHub issue comments, Linear tickets, and support logs.

Company Brain acts as a living map of how a company operates. It:
1. **Ingests** unstructured communication from multi-source webhooks (Slack, GitHub, Linear).
2. **Extracts** structured SOPs with triggers, preconditions, execution steps, step conditions, and failure handling.
3. **Maintains Freshness** with immutable version history, automated staleness detection, and LLM conflict resolution.
4. **Governs** procedures via human-in-the-loop Draft → Approved status control.
5. **Exposes Executable Skills** to autonomous AI agents over Model Context Protocol (FastMCP) on `:8080`.

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
 └──────────────┘                 │             ▼             │
                                  │  ┌─────────────────────┐  │
                                  │  │ Supabase Storage &  │  │
                                  │  │ TanStack UI (:3001) │  │
                                  │  └─────────────────────┘  │
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
OPENROUTER_API_KEY=your_openrouter_key
```

Run database migrations in Supabase SQL Editor:
1. `server/supabase/create_skills_sops.sql`
2. `server/supabase/create_raw_threads_and_citations.sql`
3. `server/supabase/003_versioning_and_logs.sql`

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

Open `http://localhost:3001` to view the **TanStack Start Glassmorphism UI**.

---

## 🔌 Webhook Endpoints

Send payloads to test real-time SOP extraction:

### Slack
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

### GitHub
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

### Linear
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

---

## 🤖 FastMCP Tools for AI Agents

Connect any MCP-compatible client (Claude Desktop, Cursor, Custom Subagent) to `http://localhost:8080/mcp`.

Available MCP tools:
- `get_sop_by_id`: Fetch approved SOP execution steps & rules.
- `search_operational_sops`: Search approved SOPs by category or keyword.
- `get_sop_with_history`: Fetch SOP details alongside version evolution snapshots.
- `log_sop_execution`: Log agent execution outcomes back to Company Brain observability.

---

## 📜 Tech Stack

- **Frontend**: React 19, TanStack Start/Router, Vite, TailwindCSS v4, Lucide Icons
- **Backend**: Node.js, Express, FastMCP, Supabase JS client
- **AI Extraction**: OpenRouter (Google Gemma 4 / Ling-3.0 Flash)
- **Database**: Supabase PostgreSQL (JSONB execution steps, vector/text indexing, audit tables)
