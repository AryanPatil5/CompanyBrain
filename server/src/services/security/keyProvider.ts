// KeyProvider interface for Phase 0 (ADR-T6 executed)
// This provides the abstraction for secure key management needed by KMS encryption.
//
// Phase 0 Task 5 (remove production mock credentials):
// - MemoryKeyProvider is a development/test-only implementation. It throws at
//   construction when NODE_ENV=production so the process fails fast at boot
//   instead of silently resolving mock tokens.
// - getKeyProvider() refuses to boot in production unless an explicit,
//   non-memory provider is configured. Unknown values fail closed.
// - Real Vault/KMS connectors land in Phase 5; for Phase 0 the
//   EnvironmentKeyProvider is the accepted production stand-in (documented in
//   the roadmap's key-management entry).

export interface KeyProvider {
  /**
   * Resolve a secret or key from a reference like "vault:my-secret" or "aws-secret-manager:my-key"
   * Returns the resolved value as a string or null if not found/unauthorized
   */
  resolveCredential(reference: string): Promise<string | null>;

  /**
   * Store a new secret or key using the configured key provider
   * Returns true on success, false on failure
   */
  storeCredential(reference: string, value: string): Promise<boolean>;

  /**
   * Delete a secret or key from the key provider
   * Returns true on success, false on failure
   */
  deleteCredential(reference: string): Promise<boolean>;

  /**
   * Test connectivity to the key provider
   * Returns true if provider is reachable and authenticated
   */
  healthCheck(): Promise<boolean>;
}

/**
 * Single source of truth for production mode. Mock credentials and the
 * MemoryKeyProvider are structurally rejected wherever this returns true.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * In-memory implementation of KeyProvider for development/testing only.
 * Seeded mock tokens exist here so local and CI flows work without a real
 * secret store; production boot is refused at construction (fail fast).
 */
export class MemoryKeyProvider implements KeyProvider {
  private store: Map<string, string> = new Map();

  constructor() {
    if (isProduction()) {
      throw new Error(
        'FATAL: MemoryKeyProvider is a development/test-only key provider and cannot be used in production. ' +
          'Set KEY_PROVIDER=environment (or a Vault/KMS provider) in production.'
      );
    }

    // Seed with some common credentials for testing (dev/test mode only)
    this.store.set('mcp-admin-key-99', 'mock-admin-token');
    this.store.set('vault:slack_bot_token', 'xoxb-mock-slack-token');
    this.store.set('vault:github_pat', 'ghp_mock-github-token');
    this.store.set('vault:stripe_secret_key', 'sk_test_mock-stripe-key');
  }

  async resolveCredential(reference: string): Promise<string | null> {
    return this.store.get(reference) || null;
  }

  async storeCredential(reference: string, value: string): Promise<boolean> {
    this.store.set(reference, value);
    return true;
  }

  async deleteCredential(reference: string): Promise<boolean> {
    return this.store.delete(reference);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Fallback KeyProvider that delegates to environment variables.
 * The accepted production stand-in for Phase 0 until the Vault/KMS
 * connectors land in Phase 5. Stores nothing; resolves env references only.
 */
export class EnvironmentKeyProvider implements KeyProvider {
  async resolveCredential(reference: string): Promise<string | null> {
    // Try direct env var reference
    if (reference.startsWith('env:')) {
      const envKey = reference.substring(4);
      return process.env[envKey] || null;
    }

    // Try vault-prefixed references
    if (reference.startsWith('vault:')) {
      const secretKey = reference.substring(6);
      return process.env[`VAULT_${secretKey.toUpperCase().replace('-', '_')}`] || null;
    }

    // Bare references resolve against identically-named environment variables
    return process.env[reference] || null;
  }

  async storeCredential(_reference: string, _value: string): Promise<boolean> {
    // Environment provider cannot store credentials
    return false;
  }

  async deleteCredential(_reference: string): Promise<boolean> {
    // Environment provider cannot delete credentials
    return false;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

/**
 * Default KeyProvider factory that returns appropriate implementation based on configuration.
 *
 * Production (NODE_ENV=production) refuses:
 *   - 'memory' (mock credentials must never exist in production code paths)
 *   - unset/unknown values (no silent default; production must require a real provider)
 *
 * Development/test keeps the previous default (EnvironmentKeyProvider) and allows
 * 'memory' for local flows that need seeded mock credentials.
 */
export function getKeyProvider(): KeyProvider {
  const provider = process.env.KEY_PROVIDER?.toLowerCase() || '';

  if (isProduction()) {
    if (!provider || provider === 'auto') {
      throw new Error(
        'FATAL: KEY_PROVIDER is not configured. Production requires an explicit key provider ' +
          "(e.g. KEY_PROVIDER=environment; Vault/KMS connectors arrive in Phase 5). 'memory' is forbidden in production."
      );
    }
    if (provider === 'memory') {
      throw new Error(
        'FATAL: KEY_PROVIDER=memory is forbidden in production. Mock credentials must only exist in development or test mode.'
      );
    }
    if (provider !== 'environment' && provider !== 'vault' && provider !== 'hashicorp-vault' && provider !== 'aws-secrets-manager') {
      throw new Error(`FATAL: Unknown KEY_PROVIDER '${provider}'. Production fails closed rather than fall back silently.`);
    }
    // Phase 0 stand-in: environment-backed provider until real Vault/KMS connectors (Phase 5).
    return new EnvironmentKeyProvider();
  }

  switch (provider) {
    case 'memory':
      return new MemoryKeyProvider();
    case 'environment':
    case 'vault':
    case 'hashicorp-vault':
    case 'aws-secrets-manager':
      // In Phase 0, vault/kms/aws would return real clients; for now these
      // all fall back to the environment provider.
      return new EnvironmentKeyProvider();
    default:
      // Default to environment provider for Phase 0 (dev/test default preserved)
      return new EnvironmentKeyProvider();
  }
}
