// Unit tests: GitHub App JWT creation, installation token exchange, caching.
// Pure tests: no Redis / Supabase / network — fetch is injected.

import { generateKeyPairSync, createSign } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify } from 'jose';
import { GitHubAppAuth, GitHubAuthError } from '../../../src/connectors/github/auth.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function runAuthTest(): Promise<boolean> {
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

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const origAppId = process.env.GITHUB_APP_ID;
  const origKey = process.env.GITHUB_APP_PRIVATE_KEY;
  process.env.GITHUB_APP_ID = '123456';
  process.env.GITHUB_APP_PRIVATE_KEY = privatePem;

  try {
    // ─── 1. App JWT claims & signature ───
    const auth = new GitHubAppAuth();
    const jwt = await auth.getAppJwt();
    const spkiKey = await importSPKI(publicPem, 'RS256');
    const { payload, protectedHeader } = await jwtVerify(jwt, spkiKey);

    check('JWT is RS256 signed', protectedHeader.alg === 'RS256');
    check('JWT issuer is the app id', payload.iss === '123456');
    check('JWT has issued-at', typeof payload.iat === 'number');
    check('JWT expiry within 10-minute cap', typeof payload.exp === 'number' && (payload.exp - (payload.iat || 0)) <= 600);
    check('JWT expiry in the future', typeof payload.exp === 'number' && payload.exp * 1000 > Date.now());

    // ─── 2. App JWT is cached (only one sign per lifetime) ───
    const jwt2 = await auth.getAppJwt();
    check('App JWT is cached and reused', jwt === jwt2);

    // ─── 3. Installation token exchange + caching ───
    let tokenFetchCalls = 0;
    const tokenAuth = new GitHubAppAuth({
      fetchImpl: async (_url: string, init?: RequestInit) => {
        tokenFetchCalls++;
        const authHeader = (init?.headers as Record<string, string>)?.Authorization || '';
        const jwt = authHeader.replace('Bearer ', '');
        // Verify the request was signed with a valid app JWT.
        let bearerValid = false;
        try {
          const { payload } = await jwtVerify(jwt, spkiKey);
          bearerValid = payload.iss === '123456';
        } catch {
          bearerValid = false;
        }
        return jsonResponse(bearerValid ? { token: 'inst-token-abc', expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() } : { error: 'bad jwt' }, bearerValid ? 200 : 401);
      },
    });

    const token1 = await tokenAuth.getInstallationToken(42);
    check('Installation token returned', token1 === 'inst-token-abc');
    check('Installation token request used app JWT bearer', tokenFetchCalls === 1);
    const token2 = await tokenAuth.getInstallationToken(42);
    check('Installation token is cached (no second fetch)', tokenFetchCalls === 1 && token2 === 'inst-token-abc');

    // ─── 4. Expired installation token is refreshed ───
    let expiredCalls = 0;
    const expiredAuth = new GitHubAppAuth({
      fetchImpl: async () => {
        expiredCalls++;
        return jsonResponse({ token: `token-${expiredCalls}`, expires_at: new Date().toISOString() });
      },
    });
    const e1 = await expiredAuth.getInstallationToken(7);
    const e2 = await expiredAuth.getInstallationToken(7);
    check('Expired token is refreshed', expiredCalls === 2 && e1 !== e2);

    // ─── 5. Missing credentials → typed error ───
    const savedAppId = process.env.GITHUB_APP_ID;
    const savedKey = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    let threw = false;
    try {
      await new GitHubAppAuth().getAppJwt();
    } catch (err) {
      threw = err instanceof GitHubAuthError;
    }
    if (savedAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = savedAppId;
    if (savedKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = savedKey;
    check('Missing credentials throw GitHubAuthError', threw);

    // ─── 6. isConfigured respects env ───
    const configured = new GitHubAppAuth();
    check('isConfigured true with env credentials', configured.isConfigured() === true);

    // ─── 7. Token fetch honors timeout (never blocks indefinitely) ───
    const hangingAuth = new GitHubAppAuth({
      timeoutMs: 100,
      fetchImpl: (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    });
    let timedOut = false;
    try {
      await hangingAuth.getInstallationToken(1);
    } catch {
      timedOut = true;
    }
    check('Installation token request aborts on timeout', timedOut);
  } finally {
    if (origAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = origAppId;
    if (origKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = origKey;
  }

  console.log(`\nAuth tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAuthTest().then((ok) => process.exit(ok ? 0 : 1));
}

export { runAuthTest };
