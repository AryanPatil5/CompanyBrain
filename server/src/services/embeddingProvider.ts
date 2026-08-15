import { logger } from '../logger.js';
import { EMBEDDING_DIMENSIONS, EmbeddingError } from './aiProvider.js';

export interface EmbeddingResult {
  vector: number[];
  model: string;
  version: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly version: string;
  readonly expectedDimensions: number;

  embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult>;
  embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]>;
  healthCheck(): Promise<boolean>;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONFIG = {
  timeoutMs: parseIntEnv('AI_TIMEOUT_MS', 30_000),
  maxRetries: parseIntEnv('AI_PROVIDER_MAX_RETRIES', 2),
  retryBaseDelayMs: parseIntEnv('AI_PROVIDER_RETRY_BASE_MS', 500),
};

function timeoutFor(provider: string): number {
  return parseIntEnv(`AI_TIMEOUT_MS_${provider.toUpperCase()}`, CONFIG.timeoutMs);
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

function validateVector(vector: number[], expectedDimensions: number, provider: string): void {
  if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new EmbeddingError('embedding_invalid_response', `${provider} returned a non-numeric embedding`, { provider, retryable: false });
  }
  if (vector.length !== expectedDimensions) {
    throw new EmbeddingError(
      'embedding_dimension_mismatch',
      `Embedding dimension ${vector.length} does not match required ${expectedDimensions}; refusing to pad or truncate vectors`,
      { provider, dimensions: vector.length, retryable: false }
    );
  }
}

function normalizeEmbeddingFailure(err: unknown, provider: string): EmbeddingError {
  if (err instanceof EmbeddingError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  if (name === 'AbortError' || /aborted|timed out|timeout/i.test(message)) {
    return new EmbeddingError('embedding_provider_unreachable', `Embedding request timed out: ${message}`, { provider, retryable: true });
  }
  return new EmbeddingError('embedding_provider_unreachable', `Embedding request failed: ${message}`, { provider, retryable: true });
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const body: any = await res.json();
    if (typeof body?.error?.message === 'string') return body.error.message;
    if (typeof body?.message === 'string') return body.message;
  } catch {
  }
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Shared embedding request loop: identical retry/backoff/abort/timeout
 * semantics for every provider. `request` performs ONE HTTP call and returns
 * the raw vector plus any model identity the server reported; HTTP-status
 * classification (retryable vs not) happens inside the provider's request
 * builder so each endpoint keeps its own rules. The returned EmbeddingResult
 * carries the PROVIDER-RETURNED model/version — callers persist exactly what
 * generated the vector.
 */
async function embedWithRetry(
  provider: { name: string; model: string; version: string; expectedDimensions: number; timeoutMs: number },
  request: (signal: AbortSignal) => Promise<{ vector: number[]; model?: string }>,
  signal?: AbortSignal
): Promise<EmbeddingResult> {
  let lastError: EmbeddingError | undefined;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new EmbeddingError('embedding_provider_unreachable', `${provider.name} embedding request cancelled`, { provider: provider.name, retryable: false });
    }
    const startedAt = Date.now();
    try {
      const { vector: rawVector, model: returnedModel } = await withTimeout(provider.timeoutMs, request, signal);

      validateVector(rawVector, provider.expectedDimensions, provider.name);

      const model = returnedModel && returnedModel !== '' ? returnedModel : provider.model;
      logger.info('ai_embedding_success', {
        provider: provider.name,
        model,
        dimensions: rawVector.length,
        latencyMs: Date.now() - startedAt,
      });
      return { vector: rawVector, model, version: provider.version };
    } catch (err) {
      lastError = normalizeEmbeddingFailure(err, provider.name);
      logger.warn('ai_embedding_failure', {
        provider: provider.name,
        model: provider.model,
        attempt,
        latencyMs: Date.now() - startedAt,
        code: lastError.code,
        status: lastError.status,
        retryable: lastError.retryable,
        message: lastError.message,
      });
      if (!lastError.retryable || attempt >= CONFIG.maxRetries || signal?.aborted) throw lastError;
      await sleep(backoffDelayMs(attempt, lastError.retryAfterMs));
    }
  }

  throw lastError;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'ollama';
  readonly model: string;
  readonly version: string;
  readonly expectedDimensions = EMBEDDING_DIMENSIONS;

  private readonly host: string;
  private readonly timeoutMs: number;

  constructor() {
    this.model = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
    this.version = process.env.EMBEDDING_VERSION || 'v1';
    this.host = (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
    this.timeoutMs = timeoutFor('ollama');
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new EmbeddingError('embedding_empty_input', 'Cannot embed empty text: no input provided', { provider: this.name, retryable: false });
    }

    return embedWithRetry(
      { name: this.name, model: this.model, version: this.version, expectedDimensions: this.expectedDimensions, timeoutMs: this.timeoutMs },
      async (abortSignal) => {
        const res = await fetch(`${this.host}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortSignal,
          body: JSON.stringify({ model: this.model, prompt: cleanText }),
        });
        if (!res.ok) {
          const detail = (await readErrorBody(res)).slice(0, 200);
          const retryable = res.status === 429 ? false : res.status >= 500;
          throw new EmbeddingError(
            'embedding_provider_http_error',
            `Ollama embeddings returned HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
            { provider: this.name, status: res.status, retryable }
          );
        }
        const data = await res.json();
        const embedding: unknown = data.embedding ?? data.embeddings?.[0];
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new EmbeddingError('embedding_invalid_response', 'Ollama returned an empty embedding', { provider: this.name, retryable: false });
        }
        return { vector: embedding as number[] };
      },
      signal
    );
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      if (signal?.aborted) {
        throw new EmbeddingError('embedding_provider_unreachable', 'Batch embedding cancelled', { provider: this.name, retryable: false });
      }
      results[i] = await this.embed(texts[i], signal);
    }
    return results;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const data = await res.json();
      const models: string[] = data.models?.map((m: any) => m.name) ?? [];
      return models.some((m) => m === this.model || m.startsWith(`${this.model}:`));
    } catch {
      return false;
    }
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  readonly version: string;
  readonly expectedDimensions = EMBEDDING_DIMENSIONS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY || '';
    // Server-side key only: the client never receives it and it is never
    // logged (the logger redacts it by value pattern anyway, but it also
    // never appears in any log payload emitted by this module).
    if (!apiKey) {
      throw new EmbeddingError(
        'embedding_provider_config_error',
        'OpenAI embedding provider selected by EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is not set',
        { provider: this.name, retryable: false }
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    this.version = process.env.EMBEDDING_VERSION || 'v1';
    this.timeoutMs = timeoutFor('openai');
  }

  private classifiesHttpError(status: number, res: Response, detail: string): EmbeddingError {
    const retryAfterSec = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : undefined;
    if (status === 429) {
      return new EmbeddingError(
        'embedding_provider_http_error',
        `OpenAI embeddings quota exceeded (HTTP 429)${detail ? `: ${detail}` : ''}`,
        { provider: this.name, status, retryable: true, retryAfterMs }
      );
    }
    if (status >= 500) {
      return new EmbeddingError(
        'embedding_provider_http_error',
        `OpenAI embeddings returned HTTP ${status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
        { provider: this.name, status, retryable: true }
      );
    }
    // Everything else in 4xx is a client/configuration error: never retried.
    return new EmbeddingError(
      'embedding_provider_http_error',
      `OpenAI embeddings returned HTTP ${status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
      { provider: this.name, status, retryable: false }
    );
  }

  private async requestEmbeddings(signal: AbortSignal, input: string[]): Promise<any> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      signal,
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!res.ok) {
      const detail = (await readErrorBody(res)).slice(0, 200);
      throw this.classifiesHttpError(res.status, res, detail);
    }
    return res.json();
  }

  async embed(text: string, signal?: AbortSignal): Promise<EmbeddingResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      throw new EmbeddingError('embedding_empty_input', 'Cannot embed empty text: no input provided', { provider: this.name, retryable: false });
    }

    return embedWithRetry(
      { name: this.name, model: this.model, version: this.version, expectedDimensions: this.expectedDimensions, timeoutMs: this.timeoutMs },
      async (abortSignal) => {
        const data: any = await this.requestEmbeddings(abortSignal, [cleanText]);
        const items: any[] = Array.isArray(data.data) ? data.data : [];
        if (items.length === 0) {
          throw new EmbeddingError('embedding_invalid_response', 'OpenAI returned no embedding data', { provider: this.name, retryable: false });
        }
        const item = items.find((i) => i.index === 0) ?? items[0];
        const embedding: unknown = item?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new EmbeddingError('embedding_invalid_response', 'OpenAI returned an empty embedding', { provider: this.name, retryable: false });
        }
        // The server may resolve aliases; persist the model it actually used.
        return { vector: embedding as number[], model: typeof data.model === 'string' ? data.model : undefined };
      },
      signal
    );
  }

  async embedBatch(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
    const cleanTexts = texts.map((t) => t.trim());
    for (const text of cleanTexts) {
      if (!text) {
        throw new EmbeddingError('embedding_empty_input', 'Cannot embed empty text: no input provided', { provider: this.name, retryable: false });
      }
    }
    if (signal?.aborted) {
      throw new EmbeddingError('embedding_provider_unreachable', 'Batch embedding cancelled', { provider: this.name, retryable: false });
    }

    let lastError: EmbeddingError | undefined;
    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
      if (signal?.aborted) {
        throw new EmbeddingError('embedding_provider_unreachable', 'Batch embedding cancelled', { provider: this.name, retryable: false });
      }
      const startedAt = Date.now();
      try {
        const data: any = await withTimeout(this.timeoutMs, (abortSignal) => this.requestEmbeddings(abortSignal, cleanTexts), signal);
        const items: any[] = Array.isArray(data.data) ? data.data : [];
        if (items.length !== cleanTexts.length) {
          throw new EmbeddingError(
            'embedding_invalid_response',
            `OpenAI batch returned ${items.length} embeddings for ${cleanTexts.length} inputs`,
            { provider: this.name, retryable: false }
          );
        }
        const model = typeof data.model === 'string' && data.model !== '' ? data.model : this.model;
        const results: EmbeddingResult[] = new Array(cleanTexts.length);
        for (const item of items) {
          const index = item.index;
          if (typeof index !== 'number' || index < 0 || index >= cleanTexts.length || results[index] !== undefined) {
            throw new EmbeddingError('embedding_invalid_response', 'OpenAI batch returned an unexpected or duplicate index', { provider: this.name, retryable: false });
          }
          const embedding: unknown = item?.embedding;
          if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new EmbeddingError('embedding_invalid_response', 'OpenAI returned an empty embedding in batch', { provider: this.name, retryable: false });
          }
          validateVector(embedding as number[], this.expectedDimensions, this.name);
          results[index] = { vector: embedding as number[], model, version: this.version };
        }
        if (results.some((r) => r === undefined)) {
          throw new EmbeddingError('embedding_invalid_response', 'OpenAI batch response is missing embeddings', { provider: this.name, retryable: false });
        }
        logger.info('ai_embedding_success', {
          provider: this.name,
          model,
          dimensions: results[0].vector.length,
          batchSize: results.length,
          latencyMs: Date.now() - startedAt,
        });
        return results;
      } catch (err) {
        lastError = normalizeEmbeddingFailure(err, this.name);
        logger.warn('ai_embedding_failure', {
          provider: this.name,
          model: this.model,
          attempt,
          latencyMs: Date.now() - startedAt,
          code: lastError.code,
          status: lastError.status,
          retryable: lastError.retryable,
          message: lastError.message,
        });
        if (!lastError.retryable || attempt >= CONFIG.maxRetries || signal?.aborted) throw lastError;
        await sleep(backoffDelayMs(attempt, lastError.retryAfterMs));
      }
    }

    throw lastError;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return Array.isArray(data?.data);
    } catch {
      return false;
    }
  }
}

let _embeddingProvider: EmbeddingProvider | null = null;

/**
 * Selects the embedding provider from EMBEDDING_PROVIDER (default 'ollama').
 * Unknown values and missing credential configuration throw a typed
 * EmbeddingError('embedding_provider_config_error') — the caller decides
 * whether to surface it as a 500 or a degraded health state.
 */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (!_embeddingProvider) {
    const providerName = (process.env.EMBEDDING_PROVIDER || 'ollama').trim().toLowerCase();
    switch (providerName) {
      case 'ollama':
        _embeddingProvider = new OllamaEmbeddingProvider();
        break;
      case 'openai':
        _embeddingProvider = new OpenAIEmbeddingProvider();
        break;
      default:
        throw new EmbeddingError(
          'embedding_provider_config_error',
          `Unknown embedding provider '${providerName}'. Supported: openai, ollama. Set EMBEDDING_PROVIDER accordingly.`,
          { provider: providerName, retryable: false }
        );
    }
  }
  return _embeddingProvider;
}

export function setEmbeddingProviderForTest(provider: EmbeddingProvider | null): void {
  _embeddingProvider = provider;
}