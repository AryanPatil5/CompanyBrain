// S3-compatible storage provider (ADR-T6). Talks to MinIO locally
// (forcePathStyle, http://localhost:9000) and to any S3-compatible provider
// in production. The bucket is PRIVATE; no signed/public URLs are issued in
// Phase 3 — all access is server-side behind workspace-authenticated routes.

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { logger } from '../../logger.js';
import { StorageError, type StorageConfig, type StoredObject, type StorageProvider } from './storageProvider.js';

export function createS3StorageProvider(config: StorageConfig): StorageProvider {
  if (!config.endpoint) {
    throw new StorageError('S3 storage provider requires STORAGE_ENDPOINT.', 'configure');
  }
  if (!config.accessKey || !config.secretKey) {
    throw new StorageError('S3 storage provider requires STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY.', 'configure');
  }

  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });

  let bucketReady: Promise<void> | null = null;

  async function ensureBucket(): Promise<void> {
    if (bucketReady) return bucketReady;
    bucketReady = (async () => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
      } catch (err) {
        const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (code === 404 || code === 403) {
          try {
            await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
          } catch (createErr) {
            logger.warn('[Storage] Bucket auto-create failed; will retry on next use:', createErr);
          }
        }
      }
    })().catch((err) => {
      bucketReady = null;
      throw err;
    });
    return bucketReady;
  }

  return {
    async putObject(key, body, meta) {
      try {
        await ensureBucket();
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: meta?.contentType,
          }),
        );
        return { key, size: body.length, contentType: meta?.contentType };
      } catch (err) {
        throw new StorageError(`putObject failed: ${(err as Error).message}`, 'putObject', key);
      }
    },

    async getObject(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const body = await result.Body?.transformToByteArray();
        if (!body) return null;
        return { body: Buffer.from(body), contentType: result.ContentType };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === 'NoSuchKey' || code === 'NotFound') return null;
        throw new StorageError(`getObject failed: ${(err as Error).message}`, 'getObject', key);
      }
    },

    async headObject(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        return { key, size: result.ContentLength ?? 0, contentType: result.ContentType };
      } catch (err) {
        const code = (err as { name?: string }).name;
        if (code === 'NotFound') return null;
        throw new StorageError(`headObject failed: ${(err as Error).message}`, 'headObject', key);
      }
    },

    async deleteObject(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      } catch (err) {
        throw new StorageError(`deleteObject failed: ${(err as Error).message}`, 'deleteObject', key);
      }
    },

    async healthCheck() {
      try {
        await ensureBucket();
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        return { ok: true };
      } catch (err) {
        logger.warn('[Storage] healthCheck failed:', err);
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}

export type { StoredObject };
