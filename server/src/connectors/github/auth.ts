// GitHub App authentication: app JWT (RS256) + installation access tokens.
// Tokens are cached until shortly before expiry; the app JWT is refreshed
// before its 10-minute maximum lifetime to keep webhooks and syncs alive.

import { SignJWT, importPKCS8 } from 'jose';
import { readFileSync } from 'node:fs';
import { logger } from '../../logger.js';

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

export interface GitHubAppConfig {
  appId?: string;
  privateKey?: string;
  privateKeyPath?: string;
  apiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const APP_JWT_LIFETIME_SECONDS = 8 * 60; // GitHub caps app JWTs at 10 minutes.
const TOKEN_REFRESH_MARGIN_MS = 60_000; // Refresh 60s before GitHub's expiry.

function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n').trim();
}

function resolvePrivateKey(config: GitHubAppConfig): string {
  const explicitKey = config.privateKey || process.env.GITHUB_APP_PRIVATE_KEY;
  if (explicitKey) return normalizePrivateKey(explicitKey);
  const keyPath = config.privateKeyPath || process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (keyPath) return readFileSync(keyPath, 'utf8');
  throw new GitHubAuthError(
    'GitHub App credentials not configured. Set GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH.'
  );
}

export class GitHubAppAuth {
  private appJwtCache: { jwt: string; expiresAt: number } | null = null;
  private readonly installationTokens = new Map<number, { token: string; expiresAt: number }>();

  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly appId: string;

  constructor(config: GitHubAppConfig = {}) {
    this.apiBaseUrl = (config.apiBaseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs || 30_000;
    this.fetchImpl = config.fetchImpl || fetch;
    this.appId = config.appId || process.env.GITHUB_APP_ID || '';
  }

  isConfigured(): boolean {
    if (!this.appId) return false;
    try {
      resolvePrivateKey({});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns a signed GitHub App JWT, reusing the cached token until it is
   * about to expire (GitHub rejects JWTs with exp > 10 minutes).
   */
  async getAppJwt(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.appJwtCache && this.appJwtCache.expiresAt > now * 1000 + 60_000) {
      return this.appJwtCache.jwt;
    }
    if (!this.appId) {
      throw new GitHubAuthError('GITHUB_APP_ID is not configured.');
    }

    const privateKeyPem = resolvePrivateKey({});
    const signingKey = await importPKCS8(privateKeyPem, 'RS256');

    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.appId)
      .setIssuedAt(now)
      .setExpirationTime(now + APP_JWT_LIFETIME_SECONDS)
      .sign(signingKey);

    this.appJwtCache = { jwt, expiresAt: (now + APP_JWT_LIFETIME_SECONDS) * 1000 };
    return jwt;
  }

  /**
   * Fetches (and caches) a GitHub installation access token via
   * POST /app/installations/{id}/access_tokens. Cache is only reused within
   * TOKEN_REFRESH_MARGIN_MS of GitHub's reported expiry.
   */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.installationTokens.get(installationId);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }

    const appJwt = await this.getAppJwt();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'CompanyBrain/1.0.0',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new GitHubAuthError(
          `GitHub installation token request failed with HTTP ${res.status}: ${res.statusText}`
        );
      }

      const data: any = await res.json();
      if (!data.token || !data.expires_at) {
        throw new GitHubAuthError('GitHub installation token response missing token or expires_at.');
      }

      const expiresAt = new Date(data.expires_at).getTime();
      this.installationTokens.set(installationId, { token: data.token, expiresAt });
      logger.info('github_installation_token_acquired', {
        installationId,
        expiresInSeconds: Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
      });
      return data.token;
    } finally {
      clearTimeout(timer);
    }
  }

  clearCache(): void {
    this.appJwtCache = null;
    this.installationTokens.clear();
  }
}

export function createGitHubAppAuth(config?: GitHubAppConfig): GitHubAppAuth {
  return new GitHubAppAuth(config);
}
