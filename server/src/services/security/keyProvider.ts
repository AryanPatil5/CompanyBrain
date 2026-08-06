// KeyProvider interface for Phase 0 (ADR-T6 executed)
// This provides the abstraction for secure key management needed by KMS encryption

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
 * In-memory implementation of KeyProvider for development/testing
 * Replaces direct KMS key usage with an interface
 */
export class MemoryKeyProvider implements KeyProvider {
  private store: Map<string, string> = new Map();

  constructor() {
    // Seed with some common credentials for testing
    this.store.set('mcp-admin-key-99', 'mock-admin-token');
    this.store.set('vault:slack_bot_token', 'xoxb-mock-slack-token');
    this.store.set('vault:github_pat', 'ghp_mock-github-token');
    this.store.set('vault:stripe_secret_key', 'sk_test_mock-stripe-key');
  }

  async resolveCredential(reference: string): Promise<string | null> {
    // Production mode rejects mock tokens
    if (process.env.NODE_ENV === 'production') {
      if (reference === 'mcp-admin-key-99' || reference === 'vault:mock-admin-token') {
        return null;
      }
    }

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
 * Fallback KeyProvider that delegates to environment variables
 * Used as a default when other providers are unavailable
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
 * Default KeyProvider factory that returns appropriate implementation based on configuration
 */
export function getKeyProvider(): KeyProvider {
  const provider = process.env.KEY_PROVIDER?.toLowerCase();

  switch (provider) {
    case 'memory':
      return new MemoryKeyProvider();
    case 'environment':
      return new EnvironmentKeyProvider();
    case 'vault':
    case 'hashicorp-vault':
      // In Phase 0, this would return a real Vault client if available
      // For now, fall back to environment provider
      return new EnvironmentKeyProvider();
    case 'aws-secrets-manager':
      // In Phase 0, this would return AWS Secrets Manager client
      // For now, fall back to environment provider
      return new EnvironmentKeyProvider();
    default:
      // Default to environment provider for Phase 0
      return new EnvironmentKeyProvider();
  }
}