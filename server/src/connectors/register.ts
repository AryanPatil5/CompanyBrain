// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — Builtin connector registration (connectors/register.ts)
//
// The registry is process-local; every production process that needs the
// connector framework must register the builtin connectors at boot:
//   - the `api` process (GET /api/ingestion/connectors capability listing),
//   - the `ingestion-worker` process (CRAWLER_V2=true crawl_provider jobs).
//
// registerBuiltinConnectors() is IDEMPOTENT: repeated calls (dev single-process
// boot where api + ingestion-worker share one process, test re-initialization)
// skip providers that are already registered instead of throwing. Production
// code must never call clearConnectorRegistry() — that helper is test/admin
// only and lives in registry.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../logger.js';
import { hasConnector, registerConnector } from './registry.js';
import { createGithubConnector } from './githubConnector.js';

export interface BuiltinRegistrationResult {
  provider: string;
  /** 'registered' when this call added it; 'already_registered' when skipped. */
  status: 'registered' | 'already_registered';
}

/**
 * Registers every builtin connector that ships with the server. Safe to call
 * multiple times in one process — providers already present are skipped, so
 * duplicate registration never throws.
 */
export function registerBuiltinConnectors(): BuiltinRegistrationResult[] {
  const builtins: Array<{ provider: string; create: () => ReturnType<typeof createGithubConnector> }> = [
    { provider: 'github', create: () => createGithubConnector() },
  ];

  const results: BuiltinRegistrationResult[] = [];
  for (const builtin of builtins) {
    if (hasConnector(builtin.provider)) {
      results.push({ provider: builtin.provider, status: 'already_registered' });
      continue;
    }
    registerConnector(builtin.create());
    results.push({ provider: builtin.provider, status: 'registered' });
    logger.info(`Builtin connector registered: ${builtin.provider}`);
  }
  return results;
}
