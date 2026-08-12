// In-memory storage provider — hermetic tests / local dev only.
//
// The factory in storageProvider.ts refuses this provider when
// NODE_ENV=production, so it can never silently back a production upload
// path. Identical semantics to the S3 provider: content-addressed keys,
// private access, typed StorageError on failure.

import { StorageError, type StoredObject, type StorageProvider } from './storageProvider.js';

interface MemoryObject {
  body: Buffer;
  contentType?: string;
}

export function createInMemoryStorageProvider(): StorageProvider {
  const objects = new Map<string, MemoryObject>();

  return {
    async putObject(key, body, meta) {
      objects.set(key, { body, contentType: meta?.contentType });
      return { key, size: body.length, contentType: meta?.contentType };
    },

    async getObject(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { body: Buffer.from(obj.body), contentType: obj.contentType };
    },

    async headObject(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return { key, size: obj.body.length, contentType: obj.contentType } satisfies StoredObject;
    },

    async deleteObject(key) {
      if (!objects.delete(key)) {
        throw new StorageError(`deleteObject: key not found: ${key}`, 'deleteObject', key);
      }
    },

    async healthCheck() {
      return { ok: true };
    },
  };
}
