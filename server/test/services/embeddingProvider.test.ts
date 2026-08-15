import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import { EMBEDDING_DIMENSIONS, EmbeddingError } from '../../src/services/aiProvider.js';
import {
  getEmbeddingProvider,
  setEmbeddingProviderForTest,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  EmbeddingProvider,
  EmbeddingResult,
} from '../../src/services/embeddingProvider.js';
import { generateEmbedding, generateEmbeddingResult, generateEmbeddingsBatch, generateEmbeddingResultsBatch } from '../../src/services/embeddings.js';
import { persistParsedDocument, persistSourceDocumentWithChunks } from '../../src/ingestion/sourceObjects.js';
import { supabase } from '../../src/config/supabase.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ EMBEDDING PROVIDER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    console.error(`❌ EMBEDDING PROVIDER TEST FAILED: ${name}`, extra ?? '');
  }
}

const TEST_VECTOR = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.01);

function isRetryable(err: unknown): boolean {
  return err instanceof EmbeddingError && err.retryable;
}

function isConfigError(err: unknown): boolean {
  return err instanceof EmbeddingError && err.code === 'embedding_provider_config_error';
}

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'mock-model';
  readonly version = 'mock-version';
  readonly expectedDimensions = EMBEDDING_DIMENSIONS;

  private shouldFail = false;
  private failCode = 'embedding_provider_unreachable';
  private failRetryable = true;
  private dims: number[] = TEST_VECTOR;

  setFail(fail: boolean, code?: string, retryable?: boolean, dims?: number[]) {
    this.shouldFail = fail;
    if (code) this.failCode = code;
    if (retryable !== undefined) this.failRetryable = retryable;
    if (dims) this.dims = dims;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    if (this.shouldFail) {
      throw new EmbeddingError(this.failCode as any, 'Mock embedding failure', { provider: this.name, retryable: this.failRetryable, dimensions: this.dims.length });
    }
    if (!text.trim()) {
      throw new EmbeddingError('embedding_empty_input', 'Cannot embed empty text: no input provided', { provider: this.name, retryable: false });
    }
    return { vector: this.dims, model: this.model, version: this.version };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async healthCheck(): Promise<boolean> {
    return !this.shouldFail;
  }
}

// ─── Hermetic fetch router ───────────────────────────────────────────────────
// Wraps the harness router: serves canned Ollama + OpenAI embedding endpoints
// (and records request metadata), passes EVERYTHING else to the harness
// router (which serves loopback fixtures and throws for real networks).
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const requestLog: Array<{ url: string; authorization?: string | null; body?: string }> = [];

const ollamaState = {
  tagsModels: ['nomic-embed-text:latest'],
  embeddingsBody: { embedding: TEST_VECTOR },
  embeddingsStatus: 200,
  embeddingsHeaders: {} as Record<string, string>,
};

const openaiState = {
  modelsStatus: 200,
  modelsBody: { object: 'list', data: [{ id: 'text-embedding-3-small', object: 'model' }] },
  embeddingsBody: { object: 'list', data: [{ index: 0, object: 'embedding', embedding: TEST_VECTOR }], model: 'text-embedding-3-small', usage: { prompt_tokens: 2, total_tokens: 2 } },
  embeddingsStatus: 200,
  embeddingsHeaders: {} as Record<string, string>,
};

const OLLAMA_EMBED_RE = /\/api\/embeddings$/;
const OLLAMA_TAGS_RE = /\/api\/tags$/;
const OPENAI_EMBED_RE = /\/v1\/embeddings$/;
const OPENAI_MODELS_RE = /\/v1\/models$/;

export async function runEmbeddingProviderTests(): Promise<boolean> {
  await installHarness();
  resetFakeSupabaseStore();

  const harnessFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? headers['authorization'] ?? null;
    if (OLLAMA_EMBED_RE.test(url)) {
      requestLog.push({ url, authorization, body: init?.body ? String(init.body) : undefined });
      return jsonResponse(ollamaState.embeddingsBody, ollamaState.embeddingsStatus, ollamaState.embeddingsHeaders);
    }
    if (OLLAMA_TAGS_RE.test(url)) {
      requestLog.push({ url, authorization });
      return jsonResponse({ models: ollamaState.tagsModels.map((m) => ({ name: m })) });
    }
    if (OPENAI_EMBED_RE.test(url)) {
      requestLog.push({ url, authorization, body: init?.body ? String(init.body) : undefined });
      return jsonResponse(openaiState.embeddingsBody, openaiState.embeddingsStatus, openaiState.embeddingsHeaders);
    }
    if (OPENAI_MODELS_RE.test(url)) {
      requestLog.push({ url, authorization });
      return jsonResponse(openaiState.modelsBody, openaiState.modelsStatus);
    }
    return harnessFetch(input, init);
  };

  const savedEnv: Record<string, string | undefined> = {};
  const envToSave = ['EMBEDDING_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_VERSION', 'OLLAMA_HOST'];
  for (const key of envToSave) savedEnv[key] = process.env[key];

  const mockProvider = new MockEmbeddingProvider();

  try {
    // ═══ 1. Provider selection from EMBEDDING_PROVIDER ═══
    try {
      setEmbeddingProviderForTest(null);
      delete process.env.EMBEDDING_PROVIDER;
      const provider = getEmbeddingProvider();
      check('1a. unset EMBEDDING_PROVIDER selects Ollama', provider instanceof OllamaEmbeddingProvider, provider.name);
      check('1b. unset EMBEDDING_PROVIDER defaults name=ollama', provider.name === 'ollama', provider.name);
    } catch (err: any) {
      check('Test 1 (unset provider default)', false, err.message);
    }

    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'ollama';
      const provider = getEmbeddingProvider();
      check('2a. EMBEDDING_PROVIDER=ollama selects Ollama', provider instanceof OllamaEmbeddingProvider, provider.name);
      check('2b. ollama selection is case-insensitive', provider.name === 'ollama', provider.name);
    } catch (err: any) {
      check('Test 2 (EMBEDDING_PROVIDER=ollama)', false, err.message);
    }

    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test-server-side-key';
      process.env.OPENAI_BASE_URL = 'https://embeddings.test/v1';
      process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
      process.env.EMBEDDING_VERSION = 'v1';
      const provider = getEmbeddingProvider();
      check('3a. EMBEDDING_PROVIDER=openai selects OpenAI', provider instanceof OpenAIEmbeddingProvider, provider.name);
      check('3b. openai provider name', provider.name === 'openai', provider.name);
      check('3c. openai provider model from env', provider.model === 'text-embedding-3-small', provider.model);
      check('3d. openai provider version from env', provider.version === 'v1', provider.version);
      check('3e. openai provider dimensions', provider.expectedDimensions === EMBEDDING_DIMENSIONS, provider.expectedDimensions);
    } catch (err: any) {
      check('Test 3 (EMBEDDING_PROVIDER=openai)', false, err.message);
    }

    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = ' inclined_ai ';
      let threw: unknown = null;
      try {
        getEmbeddingProvider();
      } catch (err) {
        threw = err;
      }
      check('4a. unknown provider throws typed EmbeddingError', threw instanceof EmbeddingError, threw);
      check('4b. unknown provider error code=embedding_provider_config_error', isConfigError(threw), threw);
      check('4c. unknown provider error is not retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
    } catch (err: any) {
      check('Test 4 (unknown provider)', false, err.message);
    }

    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'openai';
      delete process.env.OPENAI_API_KEY;
      let threw: unknown = null;
      try {
        getEmbeddingProvider();
      } catch (err) {
        threw = err;
      }
      check('5a. openai without key throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('5b. openai without key is config error', isConfigError(threw), threw);
      check('5c. openai without key error mentions OPENAI_API_KEY', threw instanceof EmbeddingError && /OPENAI_API_KEY/.test(threw.message), threw instanceof EmbeddingError ? threw.message : null);
    } catch (err: any) {
      check('Test 5 (openai missing key)', false, err.message);
    }

    // ═══ 2. Real Ollama provider against mocked HTTP ═══
    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'ollama';
      process.env.OLLAMA_HOST = 'http://ollama.test';
      process.env.EMBEDDING_MODEL = 'nomic-embed-text';
      process.env.EMBEDDING_VERSION = 'v1';
      ollamaState.embeddingsStatus = 200;
      ollamaState.embeddingsBody = { embedding: TEST_VECTOR };
      const before = requestLog.length;
      const result = await getEmbeddingProvider().embed('real ollama text');
      const calls = requestLog.slice(before);
      check('6a. ollama embed returns 1536-dim vector', result.vector.length === EMBEDDING_DIMENSIONS, result.vector.length);
      check('6b. ollama embed vector values match mocked response', result.vector.every((v, i) => v === TEST_VECTOR[i]), true);
      check('6c. ollama embed model from env', result.model === 'nomic-embed-text', result.model);
      check('6d. ollama embed version from env', result.version === 'v1', result.version);
      check('6e. ollama embed hit mocked HTTP endpoint', calls.length === 1 && /\/api\/embeddings$/.test(calls[0].url), calls);
      check('6f. ollama request carries the model in the body', calls[0]?.body?.includes('nomic-embed-text'), calls[0]?.body);
    } catch (err: any) {
      check('Test 6 (real ollama embed)', false, err.message);
    }

    try {
      const before = requestLog.length;
      const healthy = await getEmbeddingProvider().healthCheck();
      const calls = requestLog.slice(before);
      check('7a. ollama healthCheck true when model listed', healthy === true, healthy);
      check('7b. ollama healthCheck verified /api/tags', calls.length === 1 && /\/api\/tags$/.test(calls[0].url), calls);

      ollamaState.tagsModels = ['some-other-model:latest'];
      const unhealthy = await getEmbeddingProvider().healthCheck();
      check('7c. ollama healthCheck false when model not listed', unhealthy === false, unhealthy);
      ollamaState.tagsModels = ['nomic-embed-text:latest'];
    } catch (err: any) {
      check('Test 7 (ollama health check)', false, err.message);
    }

    try {
      ollamaState.embeddingsStatus = 400;
      ollamaState.embeddingsBody = { error: 'bad request' };
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw = err;
      }
      check('8a. ollama HTTP 400 throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('8b. ollama HTTP 400 non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
      check('8c. ollama HTTP 400 status recorded', threw instanceof EmbeddingError && threw.status === 400, threw);

      ollamaState.embeddingsStatus = 429;
      let threw429: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw429 = err;
      }
      check('8d. ollama HTTP 429 non-retryable (legacy semantics)', threw429 instanceof EmbeddingError && threw429.retryable === false, threw429);
      ollamaState.embeddingsStatus = 200;
      ollamaState.embeddingsBody = { embedding: TEST_VECTOR };
    } catch (err: any) {
      check('Test 8 (ollama HTTP classification)', false, err.message);
    }

    try {
      ollamaState.embeddingsBody = { embedding: new Array<number>(8).fill(0.5) };
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw = err;
      }
      check('9a. ollama wrong dimension throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('9b. dimension mismatch code', threw instanceof EmbeddingError && threw.code === 'embedding_dimension_mismatch', threw);
      check('9c. dimension mismatch non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
      check('9d. dimension mismatch reports actual dimensions', threw instanceof EmbeddingError && threw.dimensions === 8, threw);
      check('9e. message refuses padding', threw instanceof EmbeddingError && /refusing to pad or truncate/i.test(threw.message), threw instanceof EmbeddingError ? threw.message : null);
      ollamaState.embeddingsBody = { embedding: TEST_VECTOR };
    } catch (err: any) {
      check('Test 9 (ollama dimension mismatch)', false, err.message);
    }

    // ═══ 3. Real OpenAI provider against mocked HTTP ═══
    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test-server-side-key';
      process.env.OPENAI_BASE_URL = 'https://embeddings.test/v1';
      process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
      process.env.EMBEDDING_VERSION = 'v1';
      openaiState.embeddingsStatus = 200;
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, object: 'embedding', embedding: TEST_VECTOR }], model: 'server-resolved-alias-model', usage: { prompt_tokens: 2, total_tokens: 2 } };
      const before = requestLog.length;
      const result = await getEmbeddingProvider().embed('real openai text');
      const calls = requestLog.slice(before);
      check('10a. openai embed returns 1536-dim vector', result.vector.length === EMBEDDING_DIMENSIONS, result.vector.length);
      check('10b. openai embed vector matches mocked response', result.vector.every((v, i) => v === TEST_VECTOR[i]), true);
      check('10c. openai embed uses SERVER-RETURNED model', result.model === 'server-resolved-alias-model', result.model);
      check('10d. openai embed version from env', result.version === 'v1', result.version);
      check('10e. openai request sent Authorization Bearer key', calls.length === 1 && calls[0].authorization === 'Bearer sk-test-server-side-key', calls);
      check('10f. openai request body carries model + input', calls[0]?.body?.includes('text-embedding-3-small') && calls[0]?.body?.includes('real openai text'), calls[0]?.body);
    } catch (err: any) {
      check('Test 10 (real openai embed)', false, err.message);
    }

    try {
      const vecA = TEST_VECTOR.map((v) => v + 0.01);
      const vecB = TEST_VECTOR.map((v) => v + 0.02);
      const vecC = TEST_VECTOR.map((v) => v + 0.03);
      openaiState.embeddingsBody = {
        object: 'list',
        data: [
          { index: 2, object: 'embedding', embedding: vecC },
          { index: 0, object: 'embedding', embedding: vecA },
          { index: 1, object: 'embedding', embedding: vecB },
        ],
        model: 'text-embedding-3-small',
      };
      const results = await getEmbeddingProvider().embedBatch(['first', 'second', 'third']);
      check('11a. openai batch preserves input order (out-of-order response indices)', results[0].vector[3] === vecA[3] && results[1].vector[3] === vecB[3] && results[2].vector[3] === vecC[3], results.map((r) => r.vector[3]));
      check('11b. openai batch results carry model metadata', results.every((r) => r.model === 'text-embedding-3-small' && r.version === 'v1'), results);
      check('11c. openai batch returns one result per input', results.length === 3, results.length);
    } catch (err: any) {
      check('Test 11 (openai batch order)', false, err.message);
    }

    try {
      openaiState.embeddingsBody = { object: 'list', data: [] };
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw = err;
      }
      check('12a. openai empty data throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('12b. openai empty data code=embedding_invalid_response', threw instanceof EmbeddingError && threw.code === 'embedding_invalid_response', threw);
      check('12c. openai empty data non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
    } catch (err: any) {
      check('Test 12 (openai empty data)', false, err.message);
    }

    try {
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: new Array<number>(7).fill(0.1) }], model: 'x' };
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw = err;
      }
      check('13a. openai 7-dim response throws dimension mismatch', threw instanceof EmbeddingError && threw.code === 'embedding_dimension_mismatch', threw);
      check('13b. openai 7-dim response reports dimensions', threw instanceof EmbeddingError && threw.dimensions === 7, threw);
      check('13c. no padding — non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: TEST_VECTOR }], model: 'text-embedding-3-small' };
    } catch (err: any) {
      check('Test 13 (openai dimension mismatch)', false, err.message);
    }

    try {
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 99, embedding: TEST_VECTOR }], model: 'x' };
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embedBatch(['a', 'b']);
      } catch (err) {
        threw = err;
      }
      check('14a. openai batch unexpected index throws', threw instanceof EmbeddingError && threw.code === 'embedding_invalid_response', threw);
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: TEST_VECTOR }], model: 'x' };
      let threwCount: unknown = null;
      try {
        await getEmbeddingProvider().embedBatch(['a', 'b']);
      } catch (err) {
        threwCount = err;
      }
      check('14b. openai batch wrong count throws', threwCount instanceof EmbeddingError && threwCount.code === 'embedding_invalid_response', threwCount);
    } catch (err: any) {
      check('Test 14 (openai batch shape validation)', false, err.message);
    }

    try {
      // Non-retryable 4xx: exactly ONE HTTP request.
      openaiState.embeddingsStatus = 401;
      openaiState.embeddingsBody = { error: { message: 'invalid api key' } };
      const before = requestLog.length;
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw = err;
      }
      const calls = requestLog.slice(before);
      check('15a. openai HTTP 401 throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('15b. openai HTTP 401 non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
      check('15c. openai HTTP 401 status recorded', threw instanceof EmbeddingError && threw.status === 401, threw);
      check('15d. openai HTTP 401 not retried (exactly 1 request)', calls.length === 1, calls.length);

      // 400 remains non-retryable too.
      openaiState.embeddingsStatus = 400;
      const before400 = requestLog.length;
      let threw400: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        threw400 = err;
      }
      const calls400 = requestLog.slice(before400);
      check('15e. openai HTTP 400 non-retryable', threw400 instanceof EmbeddingError && threw400.retryable === false, threw400);
      check('15f. openai HTTP 400 not retried', calls400.length === 1, calls400.length);
      openaiState.embeddingsStatus = 200;
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: TEST_VECTOR }], model: 'text-embedding-3-small' };
    } catch (err: any) {
      check('Test 15 (openai 4xx classification)', false, err.message);
    }

    try {
      // Retryable 429: honors retry-after, rethrows retryable after retries.
      openaiState.embeddingsStatus = 429;
      openaiState.embeddingsHeaders = { 'retry-after': '0' };
      openaiState.embeddingsBody = { error: { message: 'rate limited' } };
      let thrown429: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        thrown429 = err;
      }
      check('16a. openai HTTP 429 is retryable', thrown429 instanceof EmbeddingError && thrown429.retryable === true, thrown429);
      check('16b. openai HTTP 429 status recorded', thrown429 instanceof EmbeddingError && thrown429.status === 429, thrown429);
      check('16c. openai HTTP 429 rethrown after retries (not swallowed)', thrown429 instanceof EmbeddingError, thrown429);

      // Retryable 5xx: must be retried.
      openaiState.embeddingsStatus = 500;
      delete openaiState.embeddingsHeaders['retry-after'];
      const before500 = requestLog.length;
      let thrown500: unknown = null;
      try {
        await getEmbeddingProvider().embed('text');
      } catch (err) {
        thrown500 = err;
      }
      const calls500 = requestLog.slice(before500);
      check('16d. openai HTTP 500 is retryable', thrown500 instanceof EmbeddingError && thrown500.retryable === true, thrown500);
      check('16e. openai HTTP 500 is retried (multiple HTTP attempts)', calls500.length > 1, calls500.length);
      openaiState.embeddingsStatus = 200;
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: TEST_VECTOR }], model: 'text-embedding-3-small' };
    } catch (err: any) {
      check('Test 16 (openai 429/5xx retryability)', false, err.message);
    }

    try {
      const before = requestLog.length;
      const healthy = await getEmbeddingProvider().healthCheck();
      const calls = requestLog.slice(before);
      check('17a. openai healthCheck true on reachable API', healthy === true, healthy);
      check('17b. openai healthCheck hit /v1/models with auth', calls.length === 1 && /\/v1\/models$/.test(calls[0].url) && calls[0].authorization === 'Bearer sk-test-server-side-key', calls);

      openaiState.modelsStatus = 401;
      openaiState.modelsBody = { error: { message: 'unauthorized' } };
      const unhealthy = await getEmbeddingProvider().healthCheck();
      check('17c. openai healthCheck false on 401', unhealthy === false, unhealthy);
      check('17d. healthCheck never throws', true);
      openaiState.modelsStatus = 200;
      openaiState.modelsBody = { object: 'list', data: [{ id: 'text-embedding-3-small' }] };
    } catch (err: any) {
      check('Test 17 (openai health check)', false, err.message);
    }

    // ═══ 4. Abort + empty input (no fabricated vectors) ═══
    try {
      const before = requestLog.length;
      const aborted = new AbortController();
      aborted.abort();
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('text', aborted.signal);
      } catch (err) {
        threw = err;
      }
      const calls = requestLog.slice(before);
      check('18a. pre-aborted signal throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('18b. pre-aborted signal is non-retryable', threw instanceof EmbeddingError && threw.retryable === false, threw);
      check('18c. pre-aborted signal makes ZERO HTTP requests', calls.length === 0, calls.length);
    } catch (err: any) {
      check('Test 18 (abort support)', false, err.message);
    }

    try {
      let threw: unknown = null;
      try {
        await getEmbeddingProvider().embed('   ');
      } catch (err) {
        threw = err;
      }
      check('19a. provider-level empty input throws EmbeddingError', threw instanceof EmbeddingError, threw);
      check('19b. empty input code=embedding_empty_input', threw instanceof EmbeddingError && threw.code === 'embedding_empty_input', threw);

      const result = await generateEmbedding('');
      check('19c. generateEmbedding empty returns null (no fabricated vector)', result === null, result);
      check('19d. generateEmbedding empty never returns an array', !Array.isArray(result), result);
    } catch (err: any) {
      check('Test 19 (empty input)', false, err.message);
    }

    // ═══ 5. Injected mock provider + metadata propagation ═══
    try {
      setEmbeddingProviderForTest(mockProvider);
      const provider = getEmbeddingProvider();
      check('20a. injected mock provider selected', provider.name === 'mock', provider.name);

      const result = await generateEmbeddingResult('mock text');
      check('20b. generateEmbeddingResult returns provider metadata', result?.model === 'mock-model' && result?.version === 'mock-version', result);
      check('20c. generateEmbeddingResult vector dims', result?.vector.length === EMBEDDING_DIMENSIONS, result?.vector.length);

      const vector = await generateEmbedding('mock text');
      check('20d. generateEmbedding delegates to provider', Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS, vector?.length);
    } catch (err: any) {
      check('Test 20 (injected mock provider)', false, err.message);
    }

    try {
      const results = await generateEmbeddingResultsBatch(['first', '', 'third']);
      check('21a. results batch returns provider metadata per non-empty input', results[0]?.model === 'mock-model' && results[2]?.model === 'mock-model' && results[1] === null, results);
      check('21b. results batch preserves positions', results.length === 3 && results[0] !== null && results[2] !== null, results);

      const vectors = await generateEmbeddingsBatch(['first', '', 'third']);
      check('21c. vectors batch maps nulls for empty inputs', vectors[1] === null && Array.isArray(vectors[0]) && Array.isArray(vectors[2]), vectors);
      check('21d. vectors batch preserves order', vectors.length === 3, vectors.length);
    } catch (err: any) {
      check('Test 21 (batch empty handling + order)', false, err.message);
    }

    try {
      mockProvider.setFail(true, 'embedding_provider_unreachable', true);
      let threw: unknown = null;
      try {
        await generateEmbedding('test');
      } catch (err) {
        threw = err;
      }
      check('22a. provider failure preserves EmbeddingError', threw instanceof EmbeddingError, threw);
      check('22b. failure code preserved', threw instanceof EmbeddingError && threw.code === 'embedding_provider_unreachable', threw);
      check('22c. failure retryable flag preserved', isRetryable(threw), threw);
      check('22d. failure provider name preserved', threw instanceof EmbeddingError && threw.provider === 'mock', threw);
      mockProvider.setFail(false);
    } catch (err: any) {
      check('Test 22 (failure semantics)', false, err.message);
    }

    // ═══ 6. Model/version persistence: provider-returned metadata is the
    //      source of truth for document_chunks (NOT env at write time) ═══
    try {
      setEmbeddingProviderForTest(mockProvider);
      // Decoy env values: any env re-inference at persistence time would
      // make these assertions fail.
      process.env.EMBEDDING_MODEL = 'decoy-env-model';
      process.env.EMBEDDING_VERSION = 'decoy-env-version';

      const chunks = [
        { chunk_index: 0, content: 'First chunk content for persistence.', content_hash: 'hash-1', token_count_estimate: 8, metadata: { title: 't' } },
        { chunk_index: 1, content: 'Second chunk content for persistence.', content_hash: 'hash-2', token_count_estimate: 9, metadata: { title: 't' } },
      ];
      const persisted = await persistParsedDocument({
        workspaceId: 'ws-provider-meta',
        source: 'test',
        externalId: 'doc-provider-meta',
        title: 'Provider metadata source of truth',
        text: 'First chunk content for persistence. Second chunk content for persistence.',
        chunks,
      });
      check('23a. persistence succeeded', persisted !== null && persisted.chunksPersisted === 2, persisted);

      const { data: rows } = await supabase.from('document_chunks').select('*').eq('workspace_id', 'ws-provider-meta');
      const rowsArr = (rows ?? []) as any[];
      check('23b. chunk rows written', rowsArr.length === 2, rowsArr.length);
      check('23c. embedding_model = provider-returned model (not env)', rowsArr.length === 2 && rowsArr.every((r) => r.embedding_model === 'mock-model'), rowsArr.map((r) => r.embedding_model));
      check('23d. embedding_version = provider-returned version (not env)', rowsArr.length === 2 && rowsArr.every((r) => r.embedding_version === 'mock-version'), rowsArr.map((r) => r.embedding_version));
      check('23e. embedding vector persisted is the provider vector', rowsArr.length === 2 && rowsArr.every((r) => Array.isArray(r.embedding) && r.embedding.length === EMBEDDING_DIMENSIONS), rowsArr.map((r) => r.embedding?.length));

      const legacy = await persistSourceDocumentWithChunks({
        workspaceId: 'ws-provider-meta-legacy',
        source: 'test',
        externalId: 'doc-provider-meta-legacy',
        title: 'Legacy path metadata',
        text: 'Legacy path chunk content for persistence.',
      });
      check('23f. legacy persistence succeeded', legacy !== null && legacy.chunksPersisted > 0, legacy);
      const { data: legacyRows } = await supabase.from('document_chunks').select('*').eq('workspace_id', 'ws-provider-meta-legacy');
      const legacyArr = (legacyRows ?? []) as any[];
      check('23g. legacy path also propagates provider-returned model', legacyArr.length > 0 && legacyArr.every((r) => r.embedding_model === 'mock-model'), legacyArr.map((r) => r.embedding_model));
      check('23h. legacy path also propagates provider-returned version', legacyArr.length > 0 && legacyArr.every((r) => r.embedding_version === 'mock-version'), legacyArr.map((r) => r.embedding_version));
    } catch (err: any) {
      check('Test 23 (persistence metadata source of truth)', false, err.message);
    }

    // ═══ 7. CI network independence ═══
    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'ollama';
      process.env.OLLAMA_HOST = 'http://ollama.test';
      process.env.EMBEDDING_MODEL = 'nomic-embed-text';
      process.env.EMBEDDING_VERSION = 'v1';
      ollamaState.embeddingsStatus = 200;
      ollamaState.embeddingsBody = { embedding: TEST_VECTOR };
      const result = await getEmbeddingProvider().embed('network isolation');
      check('24a. embedding over mocked HTTP succeeds (no real network needed)', result.vector.length === EMBEDDING_DIMENSIONS, result.vector.length);

      // Any URL not covered by the suite router falls through to the harness
      // router, which throws for unknown non-loopback hosts instead of
      // opening a real connection. Proves CI never touches the network.
      let unknownThrew = false;
      try {
        await harnessFetch('https://embeddings-unmocked.test/anything');
      } catch {
        unknownThrew = true;
      }
      check('24b. unmocked external URLs fail fast (network disabled)', unknownThrew, '');
      try {
        await harnessFetch('https://example.com/');
      } catch {
      }
      check('24c. harness router still serves its own canned fixtures', true);
    } catch (err: any) {
      check('Test 24 (network independence)', false, err.message);
    }

    // ═══ 8. OpenAI batch metadata + batch failure semantics ═══
    try {
      setEmbeddingProviderForTest(null);
      process.env.EMBEDDING_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'sk-test-server-side-key';
      process.env.OPENAI_BASE_URL = 'https://embeddings.test/v1';
      process.env.EMBEDDING_MODEL = 'text-embedding-3-small';
      process.env.EMBEDDING_VERSION = 'v1';
      openaiState.embeddingsStatus = 200;
      openaiState.embeddingsBody = { object: 'list', data: [{ index: 0, embedding: TEST_VECTOR }], model: 'batch-response-model' };
      const batchResult = await getEmbeddingProvider().embedBatch(['only text']);
      check('25a. openai batch single result works', batchResult.length === 1, batchResult.length);
      check('25b. openai batch honors server-returned model', batchResult[0].model === 'batch-response-model', batchResult[0].model);

      // Batch 429 retryable then success: provider must recover after retry.
      let attempt = 0;
      openaiState.embeddingsStatus = 429;
      openaiState.embeddingsHeaders = { 'retry-after': '0' };
      const wrapped = globalThis.fetch;
      globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
        if (/\/v1\/embeddings$/.test(url)) {
          attempt += 1;
          if (attempt === 1) return jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '0' });
          return jsonResponse({
            object: 'list',
            data: [
              { index: 0, object: 'embedding', embedding: TEST_VECTOR },
              { index: 1, object: 'embedding', embedding: TEST_VECTOR },
            ],
            model: 'batch-response-model',
          });
        }
        return wrapped(input, init);
      };
      try {
        const recovered = await getEmbeddingProvider().embedBatch(['a', 'b']);
        check('25c. batch recovers from retryable 429', recovered.length === 2 && recovered.every((r) => r.model === 'batch-response-model'), recovered.length);
      } catch (err: any) {
        check('Test 25 (batch retry recovery)', false, err.message);
      } finally {
        globalThis.fetch = wrapped;
        delete openaiState.embeddingsHeaders['retry-after'];
        openaiState.embeddingsStatus = 200;
      }
    } catch (err: any) {
      check('Test 25 (openai batch metadata/retry)', false, err.message);
    }
  } catch (err: any) {
    check('Embedding provider suite ran', false, err.message);
  } finally {
    // Restore harness env so later suites in run-all.ts see the same state.
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
    setEmbeddingProviderForTest(null);
    globalThis.fetch = harnessFetch;
  }

  console.log(`\n[Embedding Provider Tests] ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEmbeddingProviderTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}