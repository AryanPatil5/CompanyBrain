/**
 * Hermetic test harness: installs every deterministic seam for `npm test`.
 *
 * Order matters:
 *   1. env preload (before any app module import)
 *   2. ioredis/BullMQ stubs (before suites import queue/worker modules)
 *   3. fetch router (deterministic LLM + embeddings + SSRF fixtures)
 *   4. in-memory Supabase (before suites import src/config/supabase.js)
 */
import { installHarnessEnv } from './env.js';
import { installRedisStub, installBullStub } from './redisStub.js';
import { installFetchRouter } from './fetchRouter.js';
import { installFakeSupabase } from './fakeSupabase.js';

let installed = false;

export async function installHarness(): Promise<void> {
  if (installed) return;
  installed = true;
  installHarnessEnv();
  installRedisStub();
  installBullStub();
  installFetchRouter();
  await installFakeSupabase();
}
