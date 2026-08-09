/**
 * Hermetic test harness: environment preload.
 * Forces every LLM provider to route to a dead local endpoint so that the
 * harness fetch router (see fetchRouter.ts) can serve deterministic responses
 * instead of hitting real networks. Must run BEFORE the app module graph
 * (src/services/aiProvider.ts, modelRouter.ts, ...) is first imported.
 */
export function installHarnessEnv(): void {
  process.env.AI_PROVIDER_PRIORITY = 'ollama';
  process.env.ENABLE_OLLAMA = 'true';
  process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
  process.env.GEMINI_API_KEY = '';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.E2B_API_KEY = '';
  process.env.AI_PROVIDER_MAX_RETRIES = '2';
  process.env.AI_PROVIDER_RETRY_BASE_MS = '1';
  process.env.AI_PROVIDER_STAGGER_MS = '1';
  process.env.AI_TIMEOUT_MS = '2000';
  process.env.SANDBOX_FORCE_LOCAL = 'true';
  process.env.OTEL_ENABLED = 'false';
  if (process.env.LOG_LEVEL === undefined) {
    process.env.LOG_LEVEL = 'warn';
  }
  if (process.env.VAULT_SECRET_KEY === undefined) {
    process.env.VAULT_SECRET_KEY = 'test-only-vault-secret-key-00000000000000000000000000';
  }
}

// Apply immediately at module load so that ANY test file that imports the
// harness (before importing app modules) gets the deterministic env before
// src/services/aiProvider.ts and friends read it on first import.
installHarnessEnv();
