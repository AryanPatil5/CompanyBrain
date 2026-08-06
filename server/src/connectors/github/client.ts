// GitHub REST + GraphQL client with:
//   - AbortController timeouts (timer always cleared in finally)
//   - Exponential retry with jitter for HTTP 429 / secondary rate limits / 5xx
//   - Cursor-style pagination (Link header + page cursors, GraphQL cursors)
//   - Structured logs for requests, retries, rate limits, and failures

import { parseRetryAfterHeader, calculateExponentialBackoff, sleep } from '../../queue/rateLimiter.js';
import { logger } from '../../logger.js';

export class GitHubApiError extends Error {
  readonly status?: number;
  readonly body?: any;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; body?: any; retryable?: boolean } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = options.status;
    this.body = options.body;
    this.retryable = options.retryable ?? (options.status !== undefined ? options.status >= 500 || options.status === 429 : false);
  }
}

export interface GitHubClientOptions {
  apiBaseUrl?: string;
  tokenProvider?: () => Promise<string>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface Page<T> {
  items: T[];
  nextPage: number | null;
}

interface RequestResult<T> {
  body: T;
  headers: Headers;
}

interface RateLimitInfo {
  remaining: number | null;
  resetAt: number | null;
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

function pageFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const parsed = new URL(url);
  const page = parsed.searchParams.get('page');
  return page ? Number.parseInt(page, 10) : null;
}

function buildQuery(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, String(value));
  return `?${search.toString()}`;
}

export class GitHubClient {
  readonly apiBaseUrl: string;
  private readonly tokenProvider?: () => Promise<string>;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs || parseInt(process.env.GITHUB_SYNC_TIMEOUT_MS || '30000', 10);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.userAgent = options.userAgent || 'CompanyBrain/1.0.0';
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}, raw = false): Promise<RequestResult<T>> {
    const token = this.tokenProvider ? await this.tokenProvider() : undefined;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.userAgent,
      ...((init.headers as Record<string, string> | undefined) || {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const url = path.startsWith('http') ? path : `${this.apiBaseUrl}${path}`;
    let lastError: GitHubApiError | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = Date.now();

      try {
        const res = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
        const rateLimit = this.readRateLimit(res.headers);

        // HTTP 429: honor Retry-After, else exponential backoff.
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterHeader(res.headers.get('retry-after'));
          const delayMs = retryAfterMs !== null ? retryAfterMs : calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
          logger.warn('github_client_rate_limited', { path, attempt, status: 429, delayMs });
          await sleep(Math.min(delayMs, 120_000));
          continue;
        }

        // 403 with zero remaining quota: wait until x-ratelimit-reset.
        if (res.status === 403 && (rateLimit.remaining === 0 || res.headers.get('x-ratelimit-remaining') === '0')) {
          const resetDelayMs = rateLimit.resetAt
            ? Math.max(0, rateLimit.resetAt - Date.now()) + 1000
            : calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
          logger.warn('github_client_rate_limit_exhausted', { path, attempt, resetAt: rateLimit.resetAt, delayMs: resetDelayMs });
          await sleep(Math.min(resetDelayMs, 120_000));
          continue;
        }

        if (res.status >= 500 && attempt < this.maxRetries) {
          const delayMs = calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
          logger.warn('github_client_retry', { path, attempt, status: res.status, delayMs });
          await sleep(delayMs);
          continue;
        }

        if (!res.ok) {
          let body: any = undefined;
          try {
            body = await res.json();
          } catch {
            /* non-JSON error body */
          }
          throw new GitHubApiError(`GitHub API ${res.status} ${res.statusText} for ${path}`, { status: res.status, body });
        }

        const value = raw ? ((await res.text()) as unknown as T) : ((await res.json()) as T);
        logger.debug('github_client_request_ok', { path, attempt, latencyMs: Date.now() - startedAt, remaining: rateLimit.remaining });
        return { body: value, headers: res.headers };
      } catch (err) {
        const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError' || /aborted|timed out/i.test(err.message));
        if (isAbort) {
          logger.warn('github_client_timeout', { path, attempt, timeoutMs: this.timeoutMs });
          throw new GitHubApiError(`GitHub request timed out after ${this.timeoutMs}ms for ${path}`, { retryable: false });
        }
        if (err instanceof GitHubApiError) {
          logger.error('github_client_error', { path, attempt, status: err.status, message: err.message });
          throw err;
        }
        // Network-level failure: transient, retry with backoff.
        lastError = err instanceof Error ? new GitHubApiError(err.message, { retryable: true }) : new GitHubApiError(String(err), { retryable: true });
        if (attempt >= this.maxRetries) {
          logger.error('github_client_network_failure', { path, attempt, message: lastError.message });
          throw lastError;
        }
        const delayMs = calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
        logger.warn('github_client_retry_network', { path, attempt, delayMs, message: lastError.message });
        await sleep(delayMs);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError ?? new GitHubApiError(`GitHub request failed for ${path}`, { retryable: false });
  }

  private readRateLimit(headers: Headers): RateLimitInfo {
    const remainingRaw = headers.get('x-ratelimit-remaining');
    const resetRaw = headers.get('x-ratelimit-reset');
    const remaining = remainingRaw !== null ? Number.parseInt(remainingRaw, 10) : null;
    const resetAt = resetRaw !== null ? Number.parseInt(resetRaw, 10) * 1000 : null;
    return { remaining, resetAt };
  }

  async getJson<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
    let query = '';
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) query = `?${qs}`;
    }
    const result = await this.request<T>(`${path}${query}`);
    return result.body;
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    const result = await this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
    return result.body;
  }

  async getRaw(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<string> {
    let query = '';
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) query = `?${qs}`;
    }
    const result = await this.request<string>(`${path}${query}`, { headers: { Accept: 'application/vnd.github.raw+json' } }, true);
    return result.body;
  }

  /**
   * Fetches one page of a paginated REST endpoint. Returns items plus the next
   * page cursor (null when exhausted). Handles Link-header pagination.
   */
  async getPage<T>(
    path: string,
    opts: { perPage?: number; page?: number; items?: (body: any) => T[]; params?: Record<string, string | number | boolean | undefined> } = {}
  ): Promise<Page<T>> {
    const perPage = opts.perPage || 100;
    const page = opts.page || 1;
    const query = buildQuery({ per_page: perPage, page, ...(opts.params || {}) });
    const result = await this.request<any>(`${path}${query}`);
    const links = parseLinkHeader(result.headers.get('link'));
    const nextUrl = links['next'];
    const nextPage = pageFromUrl(nextUrl);

    const body = result.body;
    const items = opts.items ? opts.items(body) : Array.isArray(body) ? body : body.items || [];
    return { items, nextPage };
  }

  /**
   * Fetches ALL pages of a REST endpoint, following Link headers.
   * Yields each page lazily so large repositories (100k+ files) can be
   * streamed and checkpointed between batches.
   */
  async *paginate<T>(
    path: string,
    opts: { perPage?: number; items?: (body: any) => T[]; startPage?: number; maxPages?: number; params?: Record<string, string | number | boolean | undefined> } = {}
  ): AsyncGenerator<T[], void, unknown> {
    let page = opts.startPage || 1;
    const perPage = opts.perPage || 100;
    const maxPages = opts.maxPages || 1000;
    let pagesFetched = 0;

    while (page !== null && pagesFetched < maxPages) {
      const result = await this.getPage<T>(path, { perPage, page, items: opts.items, params: opts.params });
      pagesFetched++;
      if (result.items.length > 0) yield result.items;
      if (result.items.length === 0 && result.nextPage === null) break;
      if (result.nextPage === null) break;
      page = result.nextPage;
    }
  }

  /** Convenience wrapper: accumulates all pages into one array. */
  async paginateAll<T>(path: string, opts: { perPage?: number; items?: (body: any) => T[]; maxPages?: number; params?: Record<string, string | number | boolean | undefined> } = {}): Promise<T[]> {
    const out: T[] = [];
    for await (const batch of this.paginate<T>(path, opts)) {
      out.push(...batch);
    }
    return out;
  }

  /**
   * GraphQL query with cursor pagination. Caller supplies a query that
   * accepts `$cursor` and selects `pageInfo { hasNextPage endCursor }`.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = this.tokenProvider ? await this.tokenProvider() : undefined;
    if (!token) {
      throw new GitHubApiError('GraphQL requires an authenticated GitHub token.', { retryable: false });
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.apiBaseUrl}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterHeader(res.headers.get('retry-after'));
          const delayMs = retryAfterMs !== null ? retryAfterMs : calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
          logger.warn('github_client_graphql_rate_limited', { attempt, delayMs });
          await sleep(Math.min(delayMs, 120_000));
          continue;
        }
        if (res.status >= 500 && attempt < this.maxRetries) {
          const delayMs = calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
          logger.warn('github_client_graphql_retry', { attempt, status: res.status, delayMs });
          await sleep(delayMs);
          continue;
        }
        if (!res.ok) {
          throw new GitHubApiError(`GraphQL HTTP ${res.status}`, { status: res.status });
        }
        const body: any = await res.json();
        if (body.errors && body.errors.length > 0) {
          const messages = body.errors.map((e: any) => e.message).join('; ');
          const isRateLimit = /rate limit/i.test(messages);
          if (isRateLimit && attempt < this.maxRetries) {
            const delayMs = calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
            logger.warn('github_client_graphql_rate_limited', { attempt, delayMs, message: messages });
            await sleep(delayMs);
            continue;
          }
          throw new GitHubApiError(`GraphQL error: ${messages}`, { retryable: isRateLimit });
        }
        return body.data as T;
      } catch (err) {
        const isAbort = err instanceof Error && (err.name === 'AbortError' || /aborted|timed out/i.test(err.message));
        if (isAbort) {
          throw new GitHubApiError(`GraphQL request timed out after ${this.timeoutMs}ms`, { retryable: false });
        }
        if (err instanceof GitHubApiError) throw err;
        if (attempt >= this.maxRetries) throw err;
        const delayMs = calculateExponentialBackoff(attempt + 1, this.retryBaseDelayMs);
        logger.warn('github_client_graphql_retry_network', { attempt, delayMs });
        await sleep(delayMs);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GitHubApiError('GraphQL request failed', { retryable: false });
  }
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  return new GitHubClient(options);
}
