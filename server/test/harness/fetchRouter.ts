/**
 * Hermetic test harness: deterministic fetch router.
 *
 * Replaces global.fetch so that every outbound HTTP request is served locally:
 *   - /api/embeddings  -> deterministic 1536-dim vector (Ollama embeddings)
 *   - /api/generate    -> deterministic LLM completions (Ollama text gen),
 *                         content-routed so the grounding evaluator gets a
 *                         deterministic verdict while every other call gets a
 *                         canned response with token counts
 *   - https://example.com/            -> canned 200 (SSRF "public hostname" case)
 *   - https://1.1.1.1/start           -> 302 redirect to a metadata endpoint
 *                                        (SSRF redirect-mid-loop case)
 *   - anything else                   -> throws a connection-refused TypeError,
 *                                        i.e. behaves like a dead network
 *
 * Suites that need richer behavior (e.g. GitHub API fixtures) install their own
 * router on top of global.fetch, exactly like test/connectors/github/sync.test.ts.
 */

const EMBEDDING_DIM = 1536;
const DEFAULT_COMPLETION = 'Deterministic test response.';

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;

// Preserve the real fetch for loopback servers started by suites themselves
// (e.g. infra/health, infra/logger spin up local HTTP servers and probe them).
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Deterministic claim-grounding judge used by the LLM-graded hallucination
 * evaluator tests. Flags responses that assert approval/execution without the
 * manager gate that the source context requires.
 */
export function judgeGrounding(userPrompt: string): { totalClaims: number; unsupportedClaims: Array<{ claim: string; justification: string }> } {
  const response = userPrompt.split('AGENT RESPONSE:')[1] ?? userPrompt;
  const combined = `${userPrompt}\n${response}`.toLowerCase();
  const requiresApproval = /\b(manager|approval|review|human gate)\b/.test(combined);
  const contradictsApprovalGate = /\b(without|no |not |never|automatically|auto[\s-]?approved|instant(ly)?|immediate(ly)?|on the spot)\b/.test(response.toLowerCase());

  if (requiresApproval && contradictsApprovalGate) {
    return {
      totalClaims: 1,
      unsupportedClaims: [
        {
          claim: 'response contradicts the manager-approval requirement',
          justification: 'The response asserts execution without the manager review the source context requires.',
        },
      ],
    };
  }
  return { totalClaims: 1, unsupportedClaims: [] };
}

/**
 * Deterministic entity-resolution judge: answers the graph entity resolver's
 * "Are Entity A and Entity B identical business entities?" prompt. Mirrors the
 * resolver's intent with a token-containment rule (one name subsumes the
 * other) which covers the test fixtures ("Google" vs "Google LLC" match,
 * "Apple Bank" vs "Apple Inc" do not).
 */
export function judgeEntityMatch(prompt: string): string {
  const match = prompt.match(/Entity A \('([^']+)'\) and Entity B \('([^']+)'\)/);
  if (!match) return JSON.stringify({ match: false, canonicalName: null });
  const a = match[1].toLowerCase().split(/\s+/).filter(Boolean);
  const b = match[2].toLowerCase().split(/\s+/).filter(Boolean);
  const isSubset = (sub: string[], full: string[]) => sub.every((t) => full.includes(t));
  const identical = isSubset(a, b) && isSubset(b, a);
  const subsumed = isSubset(a, b) || isSubset(b, a);
  return JSON.stringify({ match: identical || subsumed, canonicalName: match[2] });
}

export function installFetchRouter(): void {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/embeddings')) {
      return jsonResponse({ embedding: new Array(EMBEDDING_DIM).fill(0.01) });
    }

    if (url.includes('/api/generate')) {
      let body: any = {};
      try {
        body = init?.body ? JSON.parse(String(init.body)) : {};
      } catch {
        // non-JSON body: fall through to canned response
      }
      const prompt = String(body.prompt ?? '');
      const system = String(body.system ?? '');
      let responseText = DEFAULT_COMPLETION;
      if (prompt.includes('identical business entities')) {
        responseText = judgeEntityMatch(prompt);
      } else if (prompt.includes('AGENT RESPONSE:') || system.includes('unsupportedClaims') || system.includes('grounding safety judge')) {
        const verdict = judgeGrounding(prompt);
        responseText = JSON.stringify(verdict);
      }
      return jsonResponse({
        model: 'llama3.2:3b',
        response: responseText,
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
      });
    }

    if (url.startsWith('https://example.com/')) {
      return new Response('ok', { status: 200 });
    }

    if (method === 'GET' && url.startsWith('https://1.1.1.1/start')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }

    if (LOOPBACK_RE.test(url) && typeof realFetch === 'function') {
      return realFetch(input, init);
    }

    throw new TypeError('fetch failed: network disabled by hermetic test harness');
  };
}


