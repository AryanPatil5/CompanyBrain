import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import { logger } from '../logger.js';
import { recordUsage, usageFromContext } from './costMeter.js';

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
const OPENROUTER_TIMEOUT_MS = Math.max(timeoutFor('openrouter'), 60_000);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const ENABLE_OLLAMA = process.env.ENABLE_OLLAMA === 'true';
const OLLAMA_HOST =(process.env.OLLAMA_HOST ||process.env.OLLAMA_BASE_URL ||'http://localhost:11434').replace(/\/+$/, '');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
const OPENROUTER_MODEL =process.env.OPENROUTER_MODEL ||'deepseek/deepseek-v4-flash-0731';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const OPENROUTER_REFERER =process.env.APP_BASE_URL ||'http://localhost:5001';

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

/**
 * Dimension required by the Supabase pgvector schema (vector(1536)).
 * Embeddings that do not match exactly are rejected — never padded or truncated.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export type EmbeddingErrorCode =
  | 'embedding_empty_input'
  | 'embedding_provider_unreachable'
  | 'embedding_provider_http_error'
  | 'embedding_invalid_response'
  | 'embedding_dimension_mismatch';

/**
 * Typed error for embedding generation failures. Thrown instead of silently
 * returning fake/deterministic vectors, so callers can fail loudly, record
 * ingestion state, and preserve retry behaviour.
 */
export class EmbeddingError extends Error {
  readonly code: EmbeddingErrorCode;
  readonly provider: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly dimensions?: number;

  constructor(
    code: EmbeddingErrorCode,
    message: string,
    options: { provider?: string; retryable?: boolean; status?: number; dimensions?: number } = {}
  ) {
    super(message);
    this.name = 'EmbeddingError';
    this.code = code;
    this.provider = options.provider ?? 'ollama';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.dimensions = options.dimensions;
  }
}

function normalizeEmbeddingFailure(err: unknown): EmbeddingError {
  if (err instanceof EmbeddingError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || /aborted|timed out|timeout/i.test(message)) {
    return new EmbeddingError('embedding_provider_unreachable', `Embedding request timed out: ${message}`, { retryable: true });
  }
  // Network-level failures (connection refused, DNS, etc.) are retryable.
  return new EmbeddingError('embedding_provider_unreachable', `Embedding request failed: ${message}`, { retryable: true });
}

function normalizeError(provider: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  const status = err instanceof Object && typeof (err as any).status === 'number' ? (err as any).status : undefined;

  logger.debug('ai_provider_raw_error', {
    provider,
    name,
    message,
    status,
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

  if (/quota|resource_exhausted|rate limit/i.test(message)) {
    return new ProviderError(provider, message, {
        retryable: false,
    });
}

if (/credit balance|billing|invalid_request_error/i.test(message)) {
    return new ProviderError(provider, message, {
        retryable: false,
    });
}
  if (status !== undefined && status >= 400 && status < 500) {
    return new ProviderError(provider, message, { status, retryable: false });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError(provider, message, { status, retryable: true });
  }
  return new ProviderError(provider, `${provider} request failed: ${message}`, {
    retryable: true,
  });
}

// ─── Abort + retry primitives ────────────────────────────────────────────────

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
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

async function withRetry(provider: AIProviderName, attemptFn: ProviderAdapter, externalSignal?: AbortSignal): Promise<ProviderResult> {
  let lastError: ProviderError | undefined;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (externalSignal?.aborted) {
      throw new ProviderError(provider, `${provider} request cancelled`, { retryable: false });
    }
    const startedAt = Date.now();
    try {
      const result = await attemptFn(externalSignal);
      logger.info('ai_provider_success', {
        provider,
        model: modelFor(provider),
        attempt,
        latencyMs: Date.now() - startedAt,
      });
      return result;
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
      if (!lastError.retryable || attempt >= CONFIG.maxRetries || externalSignal?.aborted) {
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

async function readErrorBody(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    if (typeof body?.error?.message === 'string') return body.error.message;
    if (typeof body?.message === 'string') return body.message;
  } catch {
    // Non-JSON error body
  }
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

async function throwForHttpStatus(provider: AIProviderName, res: Response, bodyMessage?: string): Promise<void> {
  const detail = bodyMessage ? `: ${bodyMessage}` : '';
  if (res.status === 429) {
    const retryAfterSec = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined;
    throw new ProviderError(provider, `${provider} quota exceeded (HTTP 429)${detail}`, { status: 429, retryable: false, retryAfterMs });
  }
  if (res.status >= 500) {
    throw new ProviderError(provider, `${provider} returned HTTP ${res.status} ${res.statusText}${detail}`, { status: res.status, retryable: true });
  }
  if (res.status >= 400) {
    throw new ProviderError(provider, `${provider} returned HTTP ${res.status} ${res.statusText}${detail}`, { status: res.status, retryable: false });
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

type ProviderAdapter = (signal?: AbortSignal) => Promise<ProviderResult>;

export interface ProviderResult {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

function buildAdapters(prompt: string, systemPrompt: string): Map<AIProviderName, ProviderAdapter> {
  const adapters = new Map<AIProviderName, ProviderAdapter>();

  if (geminiClient && GEMINI_API_KEY) {
    adapters.set('gemini', (raceSignal) =>
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
        const metadata: any = response.usageMetadata;
        return {
          text,
          usage:
            metadata && typeof metadata.promptTokenCount === 'number'
              ? {
                  promptTokens: metadata.promptTokenCount,
                  completionTokens: metadata.candidatesTokenCount ?? 0,
                }
              : undefined,
        };
      }, raceSignal),
    );
  }

  if (anthropicClient && ANTHROPIC_API_KEY) {
    adapters.set('anthropic', (raceSignal) =>
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
        return {
          text,
          usage:
            message.usage && typeof message.usage.input_tokens === 'number'
              ? {
                  promptTokens: message.usage.input_tokens,
                  completionTokens: message.usage.output_tokens ?? 0,
                }
              : undefined,
        };
      }, raceSignal),
    );
  }

  if (OPENROUTER_API_KEY) {
    adapters.set('openrouter', (raceSignal) =>
      withTimeout(OPENROUTER_TIMEOUT_MS, async (signal) => {
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
        if (!res.ok) {
          const bodyMessage = await readErrorBody(res);
          await throwForHttpStatus('openrouter', res, bodyMessage);
        }
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) throw new ProviderError('openrouter', 'OpenRouter returned an empty response', { retryable: false });
        return {
          text,
          usage:
            data.usage && typeof data.usage.prompt_tokens === 'number'
              ? {
                  promptTokens: data.usage.prompt_tokens,
                  completionTokens: data.usage.completion_tokens ?? 0,
                }
              : undefined,
        };
      }, raceSignal),
    );
  }

  if (ENABLE_OLLAMA) {
    adapters.set('ollama', (raceSignal) =>
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
        return {
          text,
          usage:
            typeof data.prompt_eval_count === 'number'
              ? {
                  promptTokens: data.prompt_eval_count,
                  completionTokens: data.eval_count ?? 0,
                }
              : undefined,
        };
      }, raceSignal),
    );
  }

  return adapters;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface GenerateTextOptions {
  workspaceId?: string;
  correlationId?: string;
  purpose?: string;
}

export async function generateText(prompt: string, systemPrompt?: string, options?: GenerateTextOptions): Promise<string> {
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

  const raceController = new AbortController();
  const attempts = enabled.map(async (provider, index) => {
    const startDelayMs = index * CONFIG.staggerMs;
    if (startDelayMs > 0) {
      await sleep(startDelayMs);
    }
    if (raceController.signal.aborted) {
      throw new ProviderError(provider, `${provider} request cancelled`, { retryable: false });
    }
    const result = await withRetry(provider, adapters.get(provider)!, raceController.signal);
    return { provider, result };
  });

  try {
    const winner = await Promise.any(attempts);
    raceController.abort();
    const model = modelFor(winner.provider);
    const latencyMs = Date.now() - startedAt;
    logger.info('ai_provider_selected', {
      provider: winner.provider,
      model,
      latencyMs,
      purpose: options?.purpose,
    });

    const usage = winner.result.usage;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    void recordUsage(
      usageFromContext(
        winner.provider,
        model,
        { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        latencyMs,
        options?.workspaceId
      )
    );

    return winner.result.text;
  } catch (err) {
    raceController.abort();
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
 * Generates vector embeddings for a string or string array using local Ollama.
 * Returns a normalized EMBEDDING_DIMENSIONS (1536) dimensional array compatible
 * with the Supabase pgvector schema.
 *
 * Never fabricates vectors: if embeddings cannot be generated, a typed
 * EmbeddingError is thrown (no deterministic pseudo-vectors, no zero padding).
 * Retryable failures (network, 5xx) are retried with backoff.
 */
export async function generateEmbeddings(textInput: string | string[]): Promise<number[]> {
  const text = Array.isArray(textInput) ? textInput.join(' ') : textInput;
  const cleanText = text.trim();

  if (!cleanText) {
    throw new EmbeddingError('embedding_empty_input', 'Cannot embed empty text: no input provided', { retryable: false });
  }

  const model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
  let lastError: EmbeddingError | undefined;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    const startedAt = Date.now();
    try {
      const rawVector = await withTimeout(timeoutFor('ollama'), async (signal) => {
        const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({ model, prompt: cleanText }),
        });
        if (!res.ok) {
          const detail = (await readErrorBody(res)).slice(0, 200);
          const retryable = res.status === 429 ? false : res.status >= 500;
          throw new EmbeddingError(
            'embedding_provider_http_error',
            `Ollama embeddings returned HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
            { status: res.status, retryable }
          );
        }
        const data = await res.json();
        const embedding: unknown = data.embedding ?? data.embeddings?.[0];
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new EmbeddingError('embedding_invalid_response', 'Ollama returned an empty embedding', { retryable: false });
        }
        return embedding as number[];
      });

      if (!rawVector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new EmbeddingError('embedding_invalid_response', 'Ollama returned a non-numeric embedding', { retryable: false });
      }
      if (rawVector.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingError(
          'embedding_dimension_mismatch',
          `Embedding dimension ${rawVector.length} does not match required ${EMBEDDING_DIMENSIONS}; refusing to pad or truncate vectors`,
          { dimensions: rawVector.length, retryable: false }
        );
      }

      logger.info('ai_embedding_success', {
        provider: 'ollama',
        model,
        dimensions: rawVector.length,
        attempt,
        latencyMs: Date.now() - startedAt,
      });
      return rawVector;
    } catch (err) {
      lastError = normalizeEmbeddingFailure(err);
      logger.warn('ai_embedding_failure', {
        provider: 'ollama',
        model,
        attempt,
        latencyMs: Date.now() - startedAt,
        code: lastError.code,
        status: lastError.status,
        retryable: lastError.retryable,
        message: lastError.message,
      });
      if (!lastError.retryable || attempt >= CONFIG.maxRetries) throw lastError;
      await sleep(backoffDelayMs(attempt));
    }
  }

  throw lastError;
}
