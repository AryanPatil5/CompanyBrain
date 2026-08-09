/**
 * Hermetic test harness: in-memory Redis + BullMQ stubs.
 *
 * ioredis: every instance (including ones created lazily by BullMQ's
 * RedisConnection.duplicate()) is backed by a shared in-memory key/value store.
 * Blocking commands (BZPOPMIN/BRPOPLPUSH/...) resolve to null after ~100ms,
 * mimicking BullMQ's own block timeout, so workers never hang.
 *
 * BullMQ Worker: the run loop is stubbed (no polling, no stalled-job checker).
 * Construction, options and close() still work (verified via probe), so tests
 * that assert worker wiring (concurrency, limiter opts, event handlers) keep
 * exercising the real constructor path.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function installRedisStub(): void {
  const ioredis = require('ioredis') as any;
  const Redis = ioredis.Redis ?? ioredis.default;
  if (!Redis?.prototype) return;

  const store = new Map<string, string>();
  const pendingBlockers: Array<() => void> = [];

  const wakeBlockers = () => {
    const resolvers = pendingBlockers.splice(0);
    for (const resolve of resolvers) resolve(null);
  };

  const proto = Redis.prototype;

  proto.connect = async function () {
    this.status = 'ready';
    return this;
  };

  proto.disconnect = function () {
    this.status = 'end';
    wakeBlockers();
    return undefined;
  };

  proto.quit = async function () {
    this.status = 'end';
    wakeBlockers();
    return 'OK';
  };

  proto.duplicate = function () {
    return this;
  };

  const BLOCKING = new Set(['BZPOPMIN', 'BZPOPMAX', 'BRPOPLPUSH', 'BLMOVE', 'BRPOP', 'BRPOPPUSH']);

  proto.sendCommand = function (command: any): Promise<unknown> {
    const name = String(command?.name ?? '').toUpperCase();
    const args: unknown[] = command?.args ?? [];

    switch (name) {
      case 'INFO':
        return Promise.resolve('# Server\r\nredis_version:7.4.0\r\nredis_mode:standalone\r\n\r\n');
      case 'GET':
        return Promise.resolve(store.get(String(args[0])) ?? null);
      case 'SET':
        store.set(String(args[0]), String(args[1]));
        return Promise.resolve('OK');
      case 'SETEX':
        store.set(String(args[0]), String(args[2]));
        return Promise.resolve('OK');
      case 'DEL': {
        const existed = store.delete(String(args[0]));
        return Promise.resolve(existed ? 1 : 0);
      }
      case 'EXISTS':
        return Promise.resolve(store.has(String(args[0])) ? 1 : 0);
      case 'EXPIRE':
        return Promise.resolve(1);
      case 'TTL':
        return Promise.resolve(-1);
      case 'INCR': {
        const key = String(args[0]);
        const next = (Number(store.get(key) ?? 0) + 1);
        store.set(key, String(next));
        return Promise.resolve(next);
      }
      case 'HGET':
        return Promise.resolve(null);
      case 'HSET':
      case 'HMSET':
        return Promise.resolve(1);
      case 'HGETALL':
        return Promise.resolve({});
      case 'SMEMBERS':
      case 'SINTER':
      case 'SUNION':
        return Promise.resolve([]);
      case 'SADD':
      case 'SREM':
        return Promise.resolve(0);
      case 'LPUSH':
      case 'RPUSH':
        return Promise.resolve(1);
      case 'LRANGE':
      case 'ZRANGE':
      case 'ZRANGEBYSCORE':
      case 'ZREVRANGE':
        return Promise.resolve([]);
      case 'ZADD':
      case 'ZREM':
        return Promise.resolve(1);
      case 'KEYS':
        return Promise.resolve([...store.keys()]);
      case 'SCAN':
        return Promise.resolve(['0', [...store.keys()]]);
      case 'MULTI':
        return Promise.resolve('OK');
      case 'EXEC':
        return Promise.resolve([]);
      case 'SCRIPT':
        return Promise.resolve('0');
      case 'EVAL':
      case 'EVALSHA':
        return Promise.resolve([]);
      default:
        if (BLOCKING.has(name)) {
          return new Promise<null>((resolve) => {
            pendingBlockers.push(() => resolve(null));
            setTimeout(() => resolve(null), 100);
          });
        }
        return Promise.resolve(undefined);
    }
  };
}

export function installBullStub(): void {
  const bullmq = require('bullmq') as any;
  const Worker = bullmq.Worker;
  if (Worker?.prototype) {
    const proto = Worker.prototype;
    if (!proto.__hermeticRunPatched) {
      proto.__hermeticRunPatched = true;
      proto.run = function () {
        return Promise.resolve();
      };
    }
  }
}
