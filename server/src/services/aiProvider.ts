import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { logger } from '../logger.js';

dotenv.config();

export type AIProviderName = 'gemini' | 'anthropic' | 'openrouter' | 'ollama';

const VALID_PROVIDERS: readonly AIProviderName[] = ['gemini', 'anthropic', 'openrouter', 'ollama'];
const DEFAULT_PRIORITY: readonly AIProviderName[] = ['gemini', 'anthropic', 'openrouter', 'ollama'];

// ─── Configuration ───────────────────────────────────────────────────────────

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePriority(raw: string | undefined): AIProviderName[] {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_PRIORITY];
  const seen = new Set<AIProviderName>();
  const priority: AIProviderName[] = [];
  for (const part of raw.split(',')) {
    const candidate = part.trim().toLowerCase() as AIProviderName;
    if (VALID_PROVIDERS.includes(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      priority.push(candidate);
    }
  }
  for (const provider of DEFAULT_PRIORITY) {
    if (!seen.has(provider)) priority.push(provider);
  }
  return priority;
}

const CONFIG = {
  priority: parsePriority(process.env.AI_PROVIDER_PRIORITY),
  timeoutMs: parseIntEnv('AI_TIMEOUT_MS', 30_000),
  maxRetries: parseIntEnv('AI_PROVIDER_MAX_RETRIES', 2),
  retryBaseDelayMs: parseIntEnv('AI_PROVIDER_RETRY_BASE_MS', 500),
  staggerMs: parseIntEnv('AI_PROVIDER_STAGGER_MS', 250),
};

function timeoutFor(provider: AIProviderName): number {
  return parseIntEnv(`AI_TIMEOUT_MS_${provider.toUpperCase()}`, CONFIG.timeoutMs);
}

const GEMINI_TIMEOUT_MS = Math.max(timeoutFor('gemini'), 15_000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ENABLE_OLLAMA = process.env.ENABLE_OLLAMA === 'true';
const OLLAMA_HOST = (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || '~deepseek/deepseek-v4-flash-latest';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const OPENROUTER_REFERER = process.env.APP_BASE_URL || 'http://localhost:5001';

function modelFor(provider: AIProviderName): string {
  switch (provider) {
    case 'gemini': return GEMINI_MODEL;
    case 'anthropic': return ANTHROPIC_MODEL;
    case 'openrouter': return OPENROUTER_MODEL;
    case 'ollama': return OLLAMA_MODEL;
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(provider: string, message: string, options: { status?: number; retryable: boolean; retryAfterMs?: number } = { retryable: false }) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class AIProviderAggregateError extends Error {
  readonly errors: ProviderError[];

  constructor(errors: ProviderError[], cause?: unknown) {
    const details = errors.length > 0
      ? errors.map((e) => `[${e.provider}] ${e.message}`).join('; ')
      : 'No AI providers are configured. Set GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or set ENABLE_OLLAMA=true with an OLLAMA_HOST.';
    super(`All AI providers failed: ${details}`);
    this.name = 'AIProviderAggregateError';
    this.errors = errors;
    if (cause !== undefined) this.cause = cause;
  }
}

function normalizeError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  logger.debug('ai_provider_raw_error', {
    provider,
    name,
    message,
    cause: err instanceof Error ? (err as any).cause : undefined,
    stack: err instanceof Error ? err.stack : undefined,
  });

  const isAbort =
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    /aborted|timed out|timeout/i.test(message);

  if (isAbort) {
    return new ProviderError(provider, `${provider} request timed out`, {
      retryable: true,
    });
  }

  return new ProviderError(provider, `${provider} request failed: ${message}`, {
    retryable: true,
  });
}

// ─── Abort + retry primitives ────────────────────────────────────────────────

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  const exponential = CONFIG.retryBaseDelayMs * Math.pow(2, attempt);
  const jitter = exponential * 0.2 * Math.random();
  const delay = exponential + jitter;
  return retryAfterMs !== undefined ? Math.max(retryAfterMs, delay) : delay;
}

async function withRetry(provider: AIProviderName, attemptFn: () => Promise<string>): Promise<string> {
  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      const text = await attemptFn();
      logger.info('ai_provider_success', {
        provider,
        model: modelFor(provider),
        attempt,
        latencyMs: Date.now() - startedAt,
      });
      return text;
    } catch (err) {
      lastError = normalizeError(provider, err);
      logger.warn('ai_provider_failure', {
        provider,
        model: modelFor(provider),
        attempt,
        status: lastError.status,
        retryable: lastError.retryable,
        latencyMs: Date.now() - startedAt,
        message: lastError.message,
      });
      if (!lastError.retryable || attempt >= CONFIG.maxRetries) {
        throw lastError;
      }
      const delayMs = backoffDelayMs(attempt, lastError.retryAfterMs);
      logger.info('ai_provider_retry', {
        provider,
        model: modelFor(provider),
        nextAttempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// ─── HTTP response classification ────────────────────────────────────────────

async function throwForHttpStatus(provider: AIProviderName, res: Response): Promise<void> {
  if (res.status === 429) {
    const retryAfterSec = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined;
    throw new ProviderError(provider, `${provider} quota exceeded (HTTP 429)`, { status: 429, retryable: false, retryAfterMs });
  }
  if (res.status >= 500) {
    throw new ProviderError(provider, `${provider} returned HTTP ${res.status} ${res.statusText}`, { status: res.status, retryable: true });
  }
  if (res.status >= 400) {
    throw new ProviderError(provider, `${provider} returned HTTP ${res.status} ${res.statusText}`, { status: res.status, retryable: false });
  }
}

// ─── Provider clients ────────────────────────────────────────────────────────

let geminiClient: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  try {
    geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (err) {
    logger.warn('ai_provider_client_init_failed', { provider: 'gemini', message: (err as Error).message });
  }
}

let anthropicClient: Anthropic | null = null;
if (ANTHROPIC_API_KEY) {
  try {
    anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY, timeout: timeoutFor('anthropic') });
  } catch (err) {
    logger.warn('ai_provider_client_init_failed', { provider: 'anthropic', message: (err as Error).message });
  }
}

type ProviderAdapter = () => Promise<string>;

function buildAdapters(prompt: string, systemPrompt: string): Map<AIProviderName, ProviderAdapter> {
  const adapters = new Map<AIProviderName, ProviderAdapter>();

  if (geminiClient && GEMINI_API_KEY) {
    adapters.set('gemini', async () =>
      withTimeout(GEMINI_TIMEOUT_MS, async (signal) => {
        const response = await geminiClient!.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: {
            systemInstruction: systemPrompt,
            temperature: 0.1,
            abortSignal: signal,
            httpOptions: { timeout: GEMINI_TIMEOUT_MS },
          },
        });
        const text = response.text?.trim();
        if (!text) throw new ProviderError('gemini', 'Gemini returned an empty response', { retryable: false });
        return text;
      }),
    );
  }

  if (anthropicClient && ANTHROPIC_API_KEY) {
    adapters.set('anthropic', async () =>
      withTimeout(timeoutFor('anthropic'), async (signal) => {
        const message = await anthropicClient!.messages.create(
          {
            model: ANTHROPIC_MODEL,
            max_tokens: 2048,
            temperature: 0.1,
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          },
          { signal },
        );
        const text = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();
        if (!text) throw new ProviderError('anthropic', 'Anthropic returned an empty response', { retryable: false });
        return text;
      }),
    );
  }

  if (OPENROUTER_API_KEY) {
    adapters.set('openrouter', async () =>
      withTimeout(timeoutFor('openrouter'), async (signal) => {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': OPENROUTER_REFERER,
            'X-Title': 'Company Brain',
          },
          signal,
          body: JSON.stringify({
            model: OPENROUTER_MODEL,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            temperature: 0.1,
          }),
        });
        if (!res.ok) await throwForHttpStatus('openrouter', res);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) throw new ProviderError('openrouter', 'OpenRouter returned an empty response', { retryable: false });
        return text;
      }),
    );
  }

  if (ENABLE_OLLAMA) {
    adapters.set('ollama', async () =>
      withTimeout(timeoutFor('ollama'), async (signal) => {
        const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: `${systemPrompt}\n\n${prompt}`,
            stream: false,
          }),
        });
        if (!res.ok) await throwForHttpStatus('ollama', res);
        const data = await res.json();
        const text = typeof data.response === 'string' ? data.response.trim() : '';
        if (!text) throw new ProviderError('ollama', 'Ollama returned an empty response', { retryable: false });
        return text;
      }),
    );
  }

  return adapters;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function generateText(prompt: string, systemPrompt?: string): Promise<string> {
  const fullSystemPrompt = systemPrompt || 'You are an Enterprise Knowledge AI Assistant.';
  const adapters = buildAdapters(prompt, fullSystemPrompt);
  let enabled = CONFIG.priority.filter((provider) => adapters.has(provider));
  if (adapters.has('openrouter')) {
    enabled = ['openrouter', ...enabled.filter((provider) => provider !== 'openrouter')];
  }

  if (enabled.length === 0) {
    const error = new AIProviderAggregateError([]);
    logger.error('ai_provider_all_failed', { enabled: [], totalLatencyMs: 0, message: error.message });
    throw error;
  }

  const startedAt = Date.now();
  logger.info('ai_provider_race_start', {
    enabled,
    priority: CONFIG.priority,
    timeoutMs: CONFIG.timeoutMs,
    maxRetries: CONFIG.maxRetries,
  });

  const attempts = enabled.map((provider, index) => {
    const attempt = withRetry(provider, adapters.get(provider)!).then((text) => ({ provider, text }));
    const startDelayMs = index * CONFIG.staggerMs;
    return startDelayMs > 0 ? sleep(startDelayMs).then(() => attempt) : attempt;
  });

  try {
    const winner = await Promise.any(attempts);
    logger.info('ai_provider_selected', {
      provider: winner.provider,
      model: modelFor(winner.provider),
      latencyMs: Date.now() - startedAt,
    });
    return winner.text;
  } catch (err) {
    const aggregate = err instanceof AggregateError ? err : new AggregateError([err as Error], 'All AI providers failed');
    const errors = aggregate.errors.map((e) => normalizeError('unknown', e));
    const failure = new AIProviderAggregateError(errors, aggregate);
    logger.error('ai_provider_all_failed', {
      enabled,
      totalLatencyMs: Date.now() - startedAt,
      errors: errors.map((e) => ({ provider: e.provider, status: e.status, retryable: e.retryable, message: e.message })),
    });
    throw failure;
  }
}

/**
 * Generates vector embeddings for a string or string array using local Ollama (nomic-embed-text).
 * Returns normalized 1536-dimensional array compatible with Supabase pgvector schema.
 */
export async function generateEmbeddings(textInput: string | string[]): Promise<number[]> {
  const text = Array.isArray(textInput) ? textInput.join(' ') : textInput;
  const cleanText = text.trim();

  if (!cleanText) {
    return new Array(1536).fill(0);
  }

  try {
    const rawVector = await withTimeout(timeoutFor('ollama'), async (signal) => {
      const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
          prompt: cleanText,
        }),
      });
      if (!res.ok) throw new ProviderError('ollama', `Ollama embeddings returned HTTP ${res.status}`, { status: res.status, retryable: false });
      const data = await res.json();
      const embedding: number[] = data.embedding || data.embeddings?.[0] || [];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new ProviderError('ollama', 'Ollama returned an empty embedding', { retryable: false });
      }
      return embedding;
    });

    // Normalize vector length to 1536 for Supabase pgvector alignment
    if (rawVector.length === 1536) return rawVector;
    if (rawVector.length < 1536) {
      return [...rawVector, ...new Array(1536 - rawVector.length).fill(0)];
    }
    return rawVector.slice(0, 1536);
  } catch (err) {
    logger.warn('ai_embedding_fallback', { message: normalizeError('ollama', err).message });
  }

  // Fallback: Deterministic 1536-dimensional pseudo-embedding vector for offline / test environments
  const fallbackVector = new Array(1536).fill(0);
  for (let i = 0; i < cleanText.length; i++) {
    const charCode = cleanText.charCodeAt(i);
    const index = (i * 31 + charCode) % 1536;
    fallbackVector[index] = (fallbackVector[index] + charCode / 255) / 2;
  }
  return fallbackVector;
}
