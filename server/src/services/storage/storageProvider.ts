// ADR-T6 storageProvider interface + factory (Phase 3).
//
// Object storage is a first-class corpus backend: raw source objects and
// uploads live in an S3-compatible bucket behind this interface; Postgres
// stores fingerprints + URIs + metadata, never blobs. MinIO (compose/Helm,
// Phase 0) is the local substrate; any S3-compatible provider (AWS S3, GCS
// XML-API, Supabase Storage) is the production substrate behind the same
// interface.
//
// Phase 3 rules:
//   - private bucket, server-side access only — no signed/public URLs
//   - content-addressed object keys: raw/{workspace_id}/{sha256}.{ext}
//   - the in-memory implementation exists ONLY for hermetic tests/dev and is
//     refused in production (mirrors the KEY_PROVIDER refusal precedent)
//   - storage failures are explicit (typed StorageError) and observable
//     (surfaced through /health dependencies)

import { createHash } from 'node:crypto';
import { logger } from '../../logger.js';
import { createS3StorageProvider } from './s3StorageProvider.js';
import { createInMemoryStorageProvider } from './inMemoryStorageProvider.js';

export interface StoredObject {
  key: string;
  size: number;
  contentType?: string;
}

export interface StorageProvider {
  /** Stores a buffer under `key`. Content-addressed keys make PUTs idempotent. */
  putObject(key: string, body: Buffer, meta?: { contentType?: string }): Promise<StoredObject>;
  /** Returns the object or null when the key does not exist. */
  getObject(key: string): Promise<{ body: Buffer; contentType?: string } | null>;
  /** Returns size/content-type or null when the key does not exist. */
  headObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
  /** Connectivity probe surfaced via /health dependencies. Never throws. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly key?: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/**
 * Content-addressed object key (ADR-T6 / Phase 3 architecture decision):
 *   raw/{workspace_id}/{sha256(content)}.{validated-extension}
 *
 * The extension is derived from a validated MIME type — NEVER from an
 * untrusted client filename. Same content => same key => idempotent PUT.
 */
export function objectKeyFor(workspaceId: string, contentHash: string, mimeType?: string): string {
  const ext = extensionForMime(mimeType);
  return `raw/${workspaceId}/${contentHash}${ext}`;
}

export function hashBytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** MIME -> extension mapping for content-addressed object keys. */
export function extensionForMime(mimeType?: string): string {
  if (!mimeType) return '';
  switch (mimeType.toLowerCase().split(';')[0].trim()) {
    case 'application/pdf':
      return '.pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    case 'application/vnd.ms-excel':
      return '.xls';
    case 'text/csv':
      return '.csv';
    case 'text/plain':
    case 'text/markdown':
      return '.txt';
    case 'application/json':
      return '.json';
    default:
      return '';
  }
}

export type StorageProviderKind = 's3' | 'memory';

export interface StorageConfig {
  provider: StorageProviderKind;
  endpoint?: string;
  bucket: string;
  accessKey?: string;
  secretKey?: string;
  region: string;
  forcePathStyle: boolean;
}

export function readStorageConfig(): StorageConfig | null {
  const endpoint = process.env.STORAGE_ENDPOINT?.trim();
  const bucket = process.env.STORAGE_BUCKET?.trim();
  const explicit = process.env.STORAGE_PROVIDER?.trim();

  const isProduction = process.env.NODE_ENV === 'production';

  if (explicit === 'memory') {
    if (isProduction) {
      throw new StorageError(
        'In-memory storage provider is refused in production (NODE_ENV=production).',
        'configure',
      );
    }
    return { provider: 'memory', bucket: bucket || 'company-brain', region: 'us-east-1', forcePathStyle: true };
  }

  // No endpoint configured: storage is unavailable (not a boot failure). The
  // upload path must treat a null provider as 503 — never silently fall back.
  if (!endpoint) {
    return null;
  }

  return {
    provider: 's3',
    endpoint,
    bucket: bucket || 'company-brain',
    accessKey: process.env.STORAGE_ACCESS_KEY?.trim(),
    secretKey: process.env.STORAGE_SECRET_KEY?.trim(),
    region: process.env.STORAGE_REGION?.trim() || 'us-east-1',
    forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE !== 'false',
  };
}

export function createStorageProvider(config: StorageConfig): StorageProvider {
  if (config.provider === 'memory') {
    return createInMemoryStorageProvider();
  }
  return createS3StorageProvider(config);
}

let providerInstance: StorageProvider | null = null;
let providerConfigError: Error | null = null;

/**
 * Returns the process-wide storage provider, or null when storage is not
 * configured (STORAGE_ENDPOINT unset). The upload path must treat null as
 * "storage unavailable" (503) — never fall back to a default provider. In
 * production the in-memory provider is refused with a thrown StorageError
 * (explicit failure, not a silent fallback).
 */
export function getStorageProvider(): StorageProvider | null {
  if (providerInstance) return providerInstance;
  if (providerConfigError) throw providerConfigError;

  try {
    const config = readStorageConfig();
    if (!config) {
      logger.warn('[Storage] Storage not configured: STORAGE_ENDPOINT is unset; upload ingestion is unavailable.');
      return null;
    }
    providerInstance = createStorageProvider(config);
    return providerInstance;
  } catch (err) {
    providerConfigError = err instanceof Error ? err : new Error(String(err));
    throw providerConfigError;
  }
}

/** /health dependency probe. Never throws; reports ok/unavailable. */
export async function checkStorage(): Promise<boolean> {
  try {
    const provider = getStorageProvider();
    if (!provider) return false;
    const result = await provider.healthCheck();
    return result.ok;
  } catch {
    return false;
  }
}

/** Test seam: resets the cached provider so suites can inject their own. */
export function resetStorageProviderForTest(): void {
  providerInstance = null;
  providerConfigError = null;
}

/** Test seam: installs an explicit provider (e.g. the in-memory one). */
export function setStorageProviderForTest(provider: StorageProvider | null): void {
  providerInstance = provider;
  providerConfigError = null;
}
