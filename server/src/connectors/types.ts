// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Task 2 — Connector Contract (connectors/types.ts)
//
// The typed connector framework that becomes the Phase 12 SDK contract
// (@companybrain/connectors). This file is deliberately provider-agnostic:
// every future connector (Slack, Linear, Zendesk, Gmail, Database, Notion,
// Confluence, Jira, Drive, SharePoint, CRM) implements this surface.
//
// Design principles (locked in the Phase 2 Task 2 architecture review):
//   - Capability-based and resource-oriented. The roadmap's literal 5-method
//     interface (listObjects/fetchObject/fetchAcl/getDeltaCursor/ack) is the
//     minimal surface; connectors with richer semantics (phased/incremental
//     sync, resume/checkpoint tokens, change detection) advertise them via
//     ConnectorCapabilities and may implement the optional sync() method.
//     The existing production GitHub connector is the reference design: it
//     cannot be expressed through the 5-method surface alone without a
//     capability regression, so the contract is written GitHub-outward.
//   - Every operation requires an explicit workspaceId. There are NO
//     zero-workspace fallbacks and no implicit workspace resolution anywhere
//     in this contract. Refusing to invent a workspace is a hard invariant
//     (enforced by the conformance suite).
//   - SourceAcl is PROVISIONAL pending the ADR-T3 kickoff agreement with
//     Track B (Phase 5). The shape below mirrors the existing
//     source_document_acls columns (principal_type, principal_id, permission,
//     inherited, raw_acl, imported_at) so Phase 5 can map it without rework.
//   - Error taxonomy is shared (IMPLEMENTATION_ORDER.md §3 prereq #2):
//     ConnectorError carries a stable code that the SDK, the worker, and the
//     DLQ all switch on.
//   - ID/key consistency (IMPLEMENTATION_ORDER.md §3 prereq #1): sourceKey()
//     codifies the workspaceId:source:externalId convention already used by
//     sourceObjects.ts. Connectors MUST use it as the stable object key.
// ─────────────────────────────────────────────────────────────────────────────

export type ConnectorProvider = string;

// ─── Webhook topology (Phase 2 Task 2) ──────────────────────────────────────
// Two DISTINCT production topologies exist. webhookMode states which one a
// provider uses TODAY; they are NOT interchangeable, and 'provider_queue' is
// NOT a degraded form of 'durable_ledger':
//   - 'provider_queue':  the PROVIDER owns delivery. Webhooks are verified and
//                        converted into provider-level sync jobs (e.g. GitHub
//                        App webhooks → `github-sync` queue). There is no
//                        raw-event ledger in our system; the provider's own
//                        webhook redelivery (GitHub retries failed deliveries)
//                        bounds loss, and the sync job is the unit of work.
//   - 'durable_ledger':  OUR system owns the event (Phase 2 Task 1). Provider
//                        payloads are persisted to raw_source_events (dedupe
//                        key), the API answers 202 {event_id}, and the
//                        webhook-ingestion queue consumes exactly-once (event
//                        status + Phase 1 idempotency ledger).
// A provider's topology is a deliberate decision, not an upgrade path.
export type WebhookMode = 'provider_queue' | 'durable_ledger';

// Where a connector persists its sync cursors today. 'github_sync_state' is
// the pre-existing per-workspace/per-repo store; the generic syncState.ts
// store is the next Phase 2 task and new connectors will use 'generic'.
export type CursorStoreKind = 'generic' | 'github_sync_state';

export interface ConnectorCapabilities {
  /** Supports delta/incremental sync driven by a cursor. */
  supportsIncremental: boolean;
  /** Supports multi-resource phased sync with resume/checkpoint tokens. */
  supportsPhasedSync: boolean;
  /** fetchAcl() returns a normalized SourceAcl. */
  supportsAcl: boolean;
  /** Object attachments (Phase 2 attachments task; reserved now). */
  supportsAttachments: boolean;
  /** Which webhook topology the provider uses today (see WebhookMode). */
  webhookMode: WebhookMode;
  /** Where cursors persist for this provider. */
  cursorStore: CursorStoreKind;
  /** Where per-connection configuration comes from. */
  configSources: Array<'env' | 'integration_credentials' | 'webhook_subscriptions'>;
}

// ─── Object identity ─────────────────────────────────────────────────────────

export interface SourceObjectRef {
  workspaceId: string;
  /** Provider identifier (must equal Connector.provider). */
  provider: string;
  /** Provider-native object id (repo full name, thread ts, ticket id, ...). */
  externalId: string;
}

/**
 * Stable object key codifying the `workspaceId:source:externalId` convention
 * already used by sourceObjects.ts. All connectors MUST derive object keys
 * through this helper so Phase 3 provenance/content-hash work can rely on
 * stable keys.
 */
export function sourceKey(ref: { workspaceId: string; source: string; externalId: string }): string {
  return `${ref.workspaceId}:${ref.source}:${ref.externalId}`;
}

export interface SourceObject extends SourceObjectRef {
  /** Resource type within the provider, e.g. 'file' | 'issue' | 'pull_request'. */
  type: string;
  title: string;
  /** Normalized text content of the object. */
  text: string;
  uri?: string;
  /** Provider metadata; MUST NOT contain credentials or tokens. */
  metadata: Record<string, unknown>;
  /** Provider change token (git sha, updated_at, ...) for change detection. */
  version?: string;
  /** Provider last-modified timestamp (ISO 8601). */
  changedAt?: string;
  /** Reserved for the Phase 2 attachments task. Connectors without attachment
   *  support MUST emit an empty array. */
  attachments?: SourceAttachmentRef[];
}

export interface SourceAttachmentRef {
  /** Content-addressed storage key (object_key). */
  objectKey: string;
  sizeBytes: number;
  mimeType: string;
}

// ─── Source ACL (provisional — pending ADR-T3 kickoff with Track B) ─────────

export type PrincipalType = 'user' | 'group' | 'team' | 'role' | 'email';

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

export interface SourceAcl {
  owner?: PrincipalRef;
  viewers: PrincipalRef[];
  teams: PrincipalRef[];
  /** True when the object inherits ACLs from its parent (repo/team/drive). */
  inherited: boolean;
  /** The provider's raw ACL payload, retained verbatim for audit. */
  raw_acl: unknown;
  /** ISO timestamp of when this ACL was captured. */
  imported_at?: string;
}

// ─── Sync cursors / deltas ───────────────────────────────────────────────────

export interface SyncCursor {
  provider: string;
  workspaceId: string;
  /** Provider-native resume token (opaque to the framework). */
  cursor: unknown;
  updatedAt?: string;
}

export interface SourceDelta {
  added: SourceObject[];
  updated: SourceObject[];
  removed: Array<{ externalId: string; type?: string }>;
}

// ─── Phased sync (GitHub-outward) ────────────────────────────────────────────

/**
 * Connector-level resume/checkpoint token. Connectors with their own
 * persistence (GitHub: github_sync_state) keep checkpointing there and may
 * return a snapshot here; connectors without a store must round-trip this
 * token through getDeltaCursor()/sync() so a killed crawl can resume.
 */
export interface ConnectorSyncCheckpoint {
  phase?: string;
  position?: number;
  cursor?: string;
  completedPhases: string[];
  /** Provider-specific snapshot (e.g. per-repository resume tokens). */
  extra?: Record<string, unknown>;
}

export interface ConnectorSyncOptions {
  workspaceId: string;
  incremental?: boolean;
  /** Resource types to sync (provider-specific). Empty = all. */
  include?: string[];
  /** Hard cap on objects processed per run (0/undefined = provider default). */
  maxObjects?: number;
  signal?: AbortSignal;
  onProgress?: (phase: string, stats: { indexed: number; skipped: number; failed: number }) => void;
}

export interface ConnectorSyncResult {
  /** Objects (or provider units) encountered this run. */
  total: number;
  /**
   * Objects actually PERSISTED into the ingestion pipeline (source_documents
   * + chunks). Only set from real persistence — never from ack bookkeeping.
   */
  indexed: number;
  skipped: number;
  /** Objects that failed to persist, plus units that failed entirely (e.g. a
   *  repository whose sync aborted counts as one failed unit). */
  failed: number;
  deleted: number;
  durationMs: number;
  /**
   * Objects acknowledged as processed via ack() (ack-based bookkeeping only).
   * Phased connectors persist directly and leave this unset (0); the generic
   * list→ack dispatch reports discovered/acknowledged here and NEVER counts
   * them as indexed.
   */
  acknowledged?: number;
  phases: Record<string, { indexed: number; skipped: number; failed: number }>;
}

// ─── Error taxonomy (shared across the SDK, worker, and DLQ) ─────────────────
// Codes are produced by real code paths only — no dead/ambiguous entries:
//   - auth failures collapse to not_configured (credentials missing) or
//     auth_revoked (previously-valid credentials rejected, e.g. 401/403 at
//     token exchange or API level). There is no separate 'auth_failed'.
//   - deletions are NOT error codes: they are reported through
//     ConnectorSyncResult.deleted / SourceDelta.removed.
export type ConnectorErrorCode =
  | 'not_configured' // provider credentials/config missing for the workspace
  | 'auth_revoked' // previously valid credentials were rejected (401/403)
  | 'rate_limited' // provider rate limit / quota exhausted (429)
  | 'not_found' // resource does not exist (404)
  | 'network' // transport-level failure (transient)
  | 'timeout'
  | 'malformed_response' // provider returned data the contract cannot parse
  | 'unsupported' // operation not supported by this connector/capability
  | 'internal';

export class ConnectorError extends Error {
  readonly provider: string;
  readonly code: ConnectorErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(provider: string, code: ConnectorErrorCode, message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.provider = provider;
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? (code === 'network' || code === 'rate_limited' || code === 'timeout');
  }

  static isConnectorError(err: unknown): err is ConnectorError {
    return err instanceof ConnectorError;
  }
}

// ─── The Connector contract ──────────────────────────────────────────────────

/**
 * A typed provider integration. Every method REQUIRES an explicit workspaceId
 * — the framework never invents or defaults a workspace. The minimal surface
 * is the roadmap's five methods; phased connectors additionally implement
 * sync() and advertise it via capabilities.supportsPhasedSync.
 */
export interface Connector {
  readonly provider: ConnectorProvider;
  readonly displayName: string;
  readonly capabilities: ConnectorCapabilities;

  /**
   * Whether this connector can operate for the workspace (credentials
   * configured). Never throws; returns false when unconfigured.
   */
  isConfigured(workspaceId: string): boolean | Promise<boolean>;

  /**
   * Streams pages of source objects. The primary pull primitive — the same
   * pattern as GitHubClient.paginate(). Pages are yielded lazily so large
   * sources can be checkpointed between batches.
   */
  listObjects(
    workspaceId: string,
    opts?: { incremental?: boolean; include?: string[]; maxObjects?: number; signal?: AbortSignal }
  ): AsyncGenerator<SourceObject[], void, unknown>;

  /** Fetches a single object by its provider-native external id. */
  fetchObject(workspaceId: string, externalId: string): Promise<SourceObject | null>;

  /** Normalized ACL for an object; null when unsupported (capability flag). */
  fetchAcl(workspaceId: string, objectId: string): Promise<SourceAcl | null>;

  /** Provider-native delta cursor for the workspace; null when unknown. */
  getDeltaCursor(workspaceId: string): Promise<unknown | null>;

  /**
   * Acknowledges an object as processed (dedupe bookkeeping). Must be
   * idempotent. Connectors whose persistence is checkpoint-based (GitHub)
   * may implement this as a no-op.
   */
  ack(workspaceId: string, externalId: string): Promise<void>;

  /**
   * Optional phased sync orchestration (GitHub-outward). Presence is
   * advertised via capabilities.supportsPhasedSync. Returns aggregated stats
   * plus the resulting checkpoint.
   */
  sync?(opts: ConnectorSyncOptions & { checkpoint?: ConnectorSyncCheckpoint }): Promise<{
    result: ConnectorSyncResult;
    checkpoint: ConnectorSyncCheckpoint;
  }>;

  /** Optional: release long-lived sessions/tokens on shutdown. */
  close?(): Promise<void>;
}
