// Unit tests: GitHub client pagination, rate limiting, retry/backoff, timeouts.
// The GitHub API is fully mocked via an injected fetch — no live infra.

import { GitHubClient, GitHubApiError } from '../../../src/connectors/github/client.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function linkHeader(nextUrl: string | null): Record<string, string> {
  return nextUrl ? { Link: `<${nextUrl}>; rel="next"` } : {};
}

function makeClient(fetchImpl: typeof fetch, opts: { maxRetries?: number; retryBaseDelayMs?: number; timeoutMs?: number } = {}): GitHubClient {
  return new GitHubClient({
    apiBaseUrl: 'https://api.github.test',
    tokenProvider: () => Promise.resolve('test-token'),
    fetchImpl,
    maxRetries: opts.maxRetries ?? 3,
    retryBaseDelayMs: opts.retryBaseDelayMs ?? 1,
    timeoutMs: opts.timeoutMs ?? 1000,
  });
}

async function runClientTest(): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean): void => {
    if (ok) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}`);
    }
  };

  // ─── 1. Link-header pagination across 3 pages ───
  {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requestedUrls.push(String(url));
      const page = Number.parseInt(new URL(String(url)).searchParams.get('page') || '1', 10);
      if (page === 1) {
        return jsonResponse(['a1', 'a2'], 200, linkHeader('https://api.github.test/items?page=2'));
      }
      if (page === 2) {
        return jsonResponse(['b1'], 200, linkHeader('https://api.github.test/items?page=3'));
      }
      return jsonResponse([], 200, {});
    };
    const client = makeClient(fetchImpl);
    const items = await client.paginateAll<string>('/items', { items: (body) => body });
    check('Pagination follows Link headers to exhaustion', JSON.stringify(items) === JSON.stringify(['a1', 'a2', 'b1']));
    check('Pagination requested pages 1..3', requestedUrls.every((u) => /page=[123]/.test(u)) && requestedUrls.length === 3);
  }

  // ─── 2. Cursor-style page stepping (getPage returns nextPage) ───
  {
    const fetchImpl: typeof fetch = async (url) => {
      const page = Number.parseInt(new URL(String(url)).searchParams.get('page') || '1', 10);
      if (page === 1) return jsonResponse({ items: ['x'] }, 200, linkHeader('https://api.github.test/repos/r/issues?page=2'));
      return jsonResponse({ items: ['y'] }, 200, {});
    };
    const client = makeClient(fetchImpl);
    const page1 = await client.getPage<string>('/repos/r/issues', { items: (body) => body.items });
    check('getPage exposes next page cursor', page1.nextPage === 2 && page1.items.length === 1);
  }

  // ─── 3. HTTP 429 → Retry-After honored, then success ───
  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '0' });
      return jsonResponse({ ok: true }, 200, { 'X-RateLimit-Remaining': '4999' });
    };
    const client = makeClient(fetchImpl, { retryBaseDelayMs: 50 });
    const body = await client.getJson<{ ok: boolean }>('/rate-limited');
    check('429 is retried and succeeds', calls === 2 && body.ok === true);
  }

  // ─── 4. 5xx transient error → exponential retry, then success ───
  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls <= 2) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({ ok: true });
    };
    const client = makeClient(fetchImpl, { retryBaseDelayMs: 1 });
    const body = await client.getJson<{ ok: boolean }>('/flaky');
    check('5xx is retried and succeeds', calls === 3 && body.ok === true);
  }

  // ─── 5. Non-retryable 404 throws immediately (single request) ───
  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return jsonResponse({ message: 'Not Found' }, 404);
    };
    const client = makeClient(fetchImpl);
    let thrown: GitHubApiError | null = null;
    try {
      await client.getJson('/missing');
    } catch (err) {
      thrown = err as GitHubApiError;
    }
    check('404 throws GitHubApiError', thrown !== null && thrown.status === 404);
    check('404 is not retried', calls === 1);
  }

  // ─── 6. 403 rate-limit exhaustion waits for reset then succeeds ───
  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({ message: 'API rate limit exceeded' }, 403, {
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 1),
        });
      }
      return jsonResponse({ ok: true }, 200, { 'X-RateLimit-Remaining': '4999' });
    };
    const client = makeClient(fetchImpl);
    const body = await client.getJson<{ ok: boolean }>('/limited');
    check('403 exhausted rate limit resumes after reset', calls === 2 && body.ok === true);
  }

  // ─── 7. Request timeout aborts via AbortController ───
  {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    const client = makeClient(fetchImpl, { timeoutMs: 50, maxRetries: 0 });
    let timedOut = false;
    try {
      await client.getJson('/slow');
    } catch (err) {
      timedOut = err instanceof GitHubApiError && /timed out/.test(err.message);
    }
    check('Timeout aborts and raises GitHubApiError', timedOut);
  }

  // ─── 8. Network failure is transient and retried ───
  {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed: connection refused');
      return jsonResponse({ ok: true });
    };
    const client = makeClient(fetchImpl, { retryBaseDelayMs: 1 });
    const body = await client.getJson<{ ok: boolean }>('/net');
    check('Network failure is retried', calls === 2 && body.ok === true);
  }

  // ─── 9. GraphQL query with cursor handoff ───
  {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!body.variables.cursor) {
        return jsonResponse({
          data: { repository: { discussions: { pageInfo: { hasNextPage: true, endCursor: 'cur2' }, nodes: [{ number: 1 }] } } },
        });
      }
      return jsonResponse({
        data: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 2 }] } } },
      });
    };
    const client = makeClient(fetchImpl);
    const page1 = await client.graphql<{ repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ number: number }> } } }>('query Q($cursor: String) { repository { discussions } }', { cursor: null });
    const page2 = await client.graphql<{ repository: { discussions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ number: number }> } } }>('query Q($cursor: String) { repository { discussions } }', { cursor: page1.repository.discussions.pageInfo.endCursor });
    check('GraphQL page 1 returns nodes + cursor', page1.repository.discussions.nodes.length === 1 && page1.repository.discussions.pageInfo.hasNextPage === true);
    check('GraphQL page 2 continues from cursor', page2.repository.discussions.nodes[0]?.number === 2 && page2.repository.discussions.pageInfo.hasNextPage === false);
  }

  // ─── 10. Authorization header always sent ───
  {
    let authHeader = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      authHeader = (init?.headers as Record<string, string>)?.Authorization || '';
      return jsonResponse({ ok: true });
    };
    const client = makeClient(fetchImpl);
    await client.getJson('/anything');
    check('Bearer token attached to requests', authHeader === 'Bearer test-token');
  }

  console.log(`\nClient tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClientTest().then((ok) => process.exit(ok ? 0 : 1));
}

export { runClientTest };
