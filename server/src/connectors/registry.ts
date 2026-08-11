// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — Connector Registry (connectors/registry.ts)
//
// Per-provider registration with capability flags; crawler/worker dispatch
// through the registry (roadmap: "workers become generic (crawl_provider)
// rather than switch-statement dispatchers").
//
// Invariants:
//   - Deterministic registration: registerConnector rejects duplicates.
//   - Lookup by provider never falls back to an unrelated connector — an
//     unknown provider throws a typed ConnectorError('not_found').
//   - Every dispatch path requires an explicit workspaceId. There is NO
//     default/zero-workspace construction anywhere in this module.
//   - CRAWLER_V2 flag inventory lives here (IMPLEMENTATION_ORDER.md §3
//     prereq #3: "Feature-flag names registered centrally (single inventory
//     in server/.env.example)").
// ─────────────────────────────────────────────────────────────────────────────

import {
  Connector,
  ConnectorError,
  ConnectorSyncResult,
  ConnectorSyncOptions,
} from './types.js';

const registry = new Map<string, Connector>();

/**
 * True when the Phase 2 crawler-v2 dispatch path is enabled
 * (server/.env.example: CRAWLER_V2=false). Legacy crawler dispatch remains
 * the default and is byte-for-byte unchanged while the flag is off.
 */
export function isCrawlerV2Enabled(): boolean {
  return process.env.CRAWLER_V2 === 'true';
}

/** Registers a connector for its provider. Throws on duplicate registration. */
export function registerConnector(connector: Connector): void {
  const provider = connector.provider;
  if (!provider || !provider.trim()) {
    throw new ConnectorError(provider || 'unknown', 'internal', 'Connector registration requires a non-empty provider name.');
  }
  if (registry.has(provider)) {
    throw new ConnectorError(provider, 'unsupported', `Connector '${provider}' is already registered. Refusing duplicate registration.`);
  }
  registry.set(provider, connector);
}

/**
 * Looks up a connector by provider. Throws a typed ConnectorError when no
 * connector is registered — callers must never proceed with a silent fallback.
 */
export function getConnector(provider: string): Connector {
  const connector = registry.get(provider);
  if (!connector) {
    throw new ConnectorError(provider, 'not_found', `No connector is registered for provider '${provider}'.`);
  }
  return connector;
}

export function hasConnector(provider: string): boolean {
  return registry.has(provider);
}

/** Capability discovery: stable, sorted listing of registered connectors. */
export function listConnectors(): Array<{
  provider: string;
  displayName: string;
  capabilities: Connector['capabilities'];
}> {
  return [...registry.values()]
    .map((c) => ({ provider: c.provider, displayName: c.displayName, capabilities: c.capabilities }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Test/admin helper: clears all registrations. Production code should never
 * need this — registration happens once at boot.
 */
export function clearConnectorRegistry(): void {
  registry.clear();
}

function assertWorkspaceId(provider: string, workspaceId: string | undefined | null): string {
  if (!workspaceId || !workspaceId.trim()) {
    throw new ConnectorError(
      provider,
      'internal',
      'workspaceId is required for connector dispatch — refusing implicit/default workspace resolution.'
    );
  }
  return workspaceId;
}

/**
 * Registry-dispatched sync: the generic `crawl_provider` entrypoint used by
 * the ingestion worker and POST /api/ingestion/run. Resolves the provider
 * through the registry (typed errors, no silent fallback), refuses to invent
 * a workspace, and runs either the connector's phased sync() or the generic
 * listObjects + ack loop.
 */
export async function dispatchConnectorSync(
  provider: string,
  workspaceId: string | undefined | null,
  opts: Omit<ConnectorSyncOptions, 'workspaceId'> = {}
): Promise<ConnectorSyncResult> {
  const wsId = assertWorkspaceId(provider, workspaceId);
  const connector = getConnector(provider);

  const configured = await connector.isConfigured(wsId);
  if (!configured) {
    throw new ConnectorError(provider, 'not_configured', `Connector '${provider}' is not configured for workspace ${wsId}.`);
  }

  // Phased connectors run their own orchestration (GitHub: syncRepository +
  // github_sync_state checkpoints).
  if (connector.capabilities.supportsPhasedSync && typeof connector.sync === 'function') {
    const { result } = await connector.sync({ workspaceId: wsId, ...opts });
    return result;
  }

  // Generic path: pull every page, ack each object. This is ack-based
  // bookkeeping — NO source document is persisted, so the result reports
  // discovered (total) / acknowledged (acknowledged) and NEVER claims
  // `indexed` (nothing was persisted; indexed stays 0). Phase counts only
  // report ack failures in `failed`.
  const startedAt = Date.now();
  const result: ConnectorSyncResult = { total: 0, indexed: 0, skipped: 0, failed: 0, deleted: 0, durationMs: 0, phases: {} };
  for await (const page of connector.listObjects(wsId, opts)) {
    for (const obj of page) {
      result.total++;
      try {
        await connector.ack(wsId, obj.externalId);
        result.acknowledged = (result.acknowledged ?? 0) + 1;
      } catch {
        result.failed++;
        const phase = (result.phases[obj.type] ??= { indexed: 0, skipped: 0, failed: 0 });
        phase.failed++;
      }
    }
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}
