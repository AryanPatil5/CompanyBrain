import { installHarness } from '../harness/index.js';
import { getKeyProvider, MemoryKeyProvider, EnvironmentKeyProvider, isProduction } from '../../src/services/security/keyProvider.js';
import { encryptSecret, decryptSecret } from '../../src/services/security/kmsEncryption.js';

const ENV_KEYS = ['NODE_ENV', 'KEY_PROVIDER', 'KMS_MASTER_KEY'] as const;

function setEnv(pairs: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(pairs)) {
    if (value !== undefined) process.env[key] = value;
  }
}

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

export async function runKeyProviderTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running KeyProvider Mock-Credential Guard Suite');
  console.log('=================================================');

  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }

  let success = true;

  try {
    // 1. Production refuses MemoryKeyProvider at construction (fail fast)
    try {
      setEnv({ NODE_ENV: 'production' });
      new MemoryKeyProvider();
      console.error('❌ KEYPROVIDER TEST FAILED: MemoryKeyProvider constructed in production without throwing!');
      success = false;
    } catch (err: any) {
      if (err.message && err.message.includes('development/test-only')) {
        console.log('✅ KEYPROVIDER TEST PASSED: MemoryKeyProvider fails fast at construction in production.');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: unexpected error:', err.message);
        success = false;
      }
    }

    // 2. Production refuses KEY_PROVIDER=memory via factory
    try {
      setEnv({ NODE_ENV: 'production', KEY_PROVIDER: 'memory' });
      getKeyProvider();
      console.error('❌ KEYPROVIDER TEST FAILED: getKeyProvider returned MemoryKeyProvider in production!');
      success = false;
    } catch (err: any) {
      if (err.message && err.message.includes('forbidden in production')) {
        console.log('✅ KEYPROVIDER TEST PASSED: getKeyProvider refuses KEY_PROVIDER=memory in production.');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: unexpected error:', err.message);
        success = false;
      }
    }

    // 3. Production refuses unset KEY_PROVIDER (no silent default)
    try {
      setEnv({ NODE_ENV: 'production' });
      getKeyProvider();
      console.error('❌ KEYPROVIDER TEST FAILED: getKeyProvider booted in production without explicit provider!');
      success = false;
    } catch (err: any) {
      if (err.message && err.message.includes('KEY_PROVIDER is not configured')) {
        console.log('✅ KEYPROVIDER TEST PASSED: Production requires an explicit KEY_PROVIDER (fails closed).');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: unexpected error:', err.message);
        success = false;
      }
    }

    // 4. Production refuses unknown provider values (fail closed)
    try {
      setEnv({ NODE_ENV: 'production', KEY_PROVIDER: 'some-unknown-provider' });
      getKeyProvider();
      console.error('❌ KEYPROVIDER TEST FAILED: getKeyProvider accepted unknown provider in production!');
      success = false;
    } catch (err: any) {
      if (err.message && err.message.includes("Unknown KEY_PROVIDER")) {
        console.log('✅ KEYPROVIDER TEST PASSED: Unknown KEY_PROVIDER fails closed in production.');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: unexpected error:', err.message);
        success = false;
      }
    }

    // 5. Production accepts explicit environment provider + KMS roundtrip
    try {
      setEnv({
        NODE_ENV: 'production',
        KEY_PROVIDER: 'environment',
        KMS_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      });
      const provider = getKeyProvider();
      if (!(provider instanceof EnvironmentKeyProvider)) {
        console.error('❌ KEYPROVIDER TEST FAILED: production did not select EnvironmentKeyProvider!');
        success = false;
      }
      const resolved = await provider.resolveCredential('env:KMS_MASTER_KEY');
      if (resolved !== process.env.KMS_MASTER_KEY) {
        console.error('❌ KEYPROVIDER TEST FAILED: env credential resolution mismatch!');
        success = false;
      } else {
        const secret = 'xoxb-real-slack-token-123';
        const encrypted = await encryptSecret(secret);
        const decrypted = await decryptSecret(encrypted);
        if (decrypted !== secret) {
          console.error('❌ KEYPROVIDER TEST FAILED: KMS roundtrip mismatch in production!');
          success = false;
        } else {
          console.log('✅ KEYPROVIDER TEST PASSED: Production EnvironmentKeyProvider resolves env refs + KMS roundtrip.');
        }
      }
    } catch (err: any) {
      console.error('❌ KEYPROVIDER TEST EXCEPTION (production environment provider):', err.message);
      success = false;
    }

    // 6. Production accepts vault/aws names as Phase 0 env-backed stand-ins
    try {
      setEnv({ NODE_ENV: 'production', KEY_PROVIDER: 'vault' });
      const provider = getKeyProvider();
      if (!(provider instanceof EnvironmentKeyProvider)) {
        console.error('❌ KEYPROVIDER TEST FAILED: vault provider did not resolve to env stand-in!');
        success = false;
      } else {
        console.log('✅ KEYPROVIDER TEST PASSED: Production vault selection uses env-backed Phase 0 stand-in.');
      }
    } catch (err: any) {
      console.error('❌ KEYPROVIDER TEST EXCEPTION (vault stand-in):', err.message);
      success = false;
    }

    // 7. Dev: KEY_PROVIDER=memory returns working seeded MemoryKeyProvider
    try {
      setEnv({ KEY_PROVIDER: 'memory' });
      const provider = getKeyProvider();
      if (!(provider instanceof MemoryKeyProvider)) {
        console.error('❌ KEYPROVIDER TEST FAILED: dev did not select MemoryKeyProvider!');
        success = false;
      }
      const mock = await provider.resolveCredential('mcp-admin-key-99');
      if (mock !== 'mock-admin-token') {
        console.error('❌ KEYPROVIDER TEST FAILED: seeded mock credential missing in dev!');
        success = false;
      } else {
        console.log('✅ KEYPROVIDER TEST PASSED: Dev MemoryKeyProvider still serves seeded mock credentials.');
      }
    } catch (err: any) {
      console.error('❌ KEYPROVIDER TEST EXCEPTION (dev memory provider):', err.message);
      success = false;
    }

    // 8. Dev: unset KEY_PROVIDER keeps the environment default (local DX preserved)
    try {
      setEnv({});
      const provider = getKeyProvider();
      if (!(provider instanceof EnvironmentKeyProvider)) {
        console.error('❌ KEYPROVIDER TEST FAILED: dev default is not EnvironmentKeyProvider!');
        success = false;
      } else {
        console.log('✅ KEYPROVIDER TEST PASSED: Dev default KEY_PROVIDER remains environment-backed.');
      }
    } catch (err: any) {
      console.error('❌ KEYPROVIDER TEST EXCEPTION (dev default):', err.message);
      success = false;
    }

    // 9. encryptSecret fails fast when no master key is resolvable
    try {
      setEnv({ NODE_ENV: 'production', KEY_PROVIDER: 'environment' });
      await encryptSecret('secret-without-key');
      console.error('❌ KEYPROVIDER TEST FAILED: encryptSecret succeeded without a master key!');
      success = false;
    } catch (err: any) {
      if (err.message && err.message.includes('No master key available')) {
        console.log('✅ KEYPROVIDER TEST PASSED: KMS fails fast when no master key is resolvable.');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: unexpected error:', err.message);
        success = false;
      }
    }

    // 10. isProduction helper matches NODE_ENV
    try {
      setEnv({ NODE_ENV: 'production' });
      const prodFlag = isProduction();
      setEnv({ NODE_ENV: 'development' });
      const devFlag = isProduction();
      if (prodFlag === true && devFlag === false) {
        console.log('✅ KEYPROVIDER TEST PASSED: isProduction() gate matches NODE_ENV.');
      } else {
        console.error('❌ KEYPROVIDER TEST FAILED: isProduction() gate mismatch!', { prodFlag, devFlag });
        success = false;
      }
    } catch (err: any) {
      console.error('❌ KEYPROVIDER TEST EXCEPTION (isProduction gate):', err.message);
      success = false;
    }
  } finally {
    // Restore original environment so in-process suites remain unaffected
    clearEnv();
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }

  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runKeyProviderTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
