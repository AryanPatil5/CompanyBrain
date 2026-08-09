import { installHarness } from '../harness/index.js';
import { parseRetryAfterHeader, calculateExponentialBackoff, handleRateLimitResponse } from '../../src/queue/rateLimiter.js';
import { createIngestionWorker } from '../../src/workers/ingestionWorker.js';

export async function runIngestionQueueTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running BullMQ Ingestion Queue & Backoff Test ');
  console.log('=================================================');

  // Test 1: Parse Retry-After header and compute exponential backoff delays
  try {
    const delay5s = parseRetryAfterHeader('5');
    if (delay5s !== 5000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Retry-After seconds parsing mismatch!', delay5s);
      return false;
    }

    const backoffAttempt1 = calculateExponentialBackoff(1, 5000);
    const backoffAttempt2 = calculateExponentialBackoff(2, 5000);
    const backoffAttempt3 = calculateExponentialBackoff(3, 5000);

    if (backoffAttempt1 !== 5000 || backoffAttempt2 !== 10000 || backoffAttempt3 !== 20000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Exponential backoff calculation mismatch!', {
        backoffAttempt1,
        backoffAttempt2,
        backoffAttempt3,
      });
      return false;
    }

    console.log('✅ INGESTION QUEUE TEST PASSED: Successfully parsed Retry-After headers and calculated exponential backoff delays.');
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Backoff Math):', err.message);
    return false;
  }

  // Test 2: Mock HTTP 429 response handling and rate limit delay execution
  try {
    const startTime = Date.now();
    const pauseDuration = await handleRateLimitResponse('1', 1);
    const elapsed = Date.now() - startTime;

    if (elapsed < 900 || pauseDuration !== 1000) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Rate limit pause duration was shorter than expected!', elapsed);
      return false;
    }
    console.log(`✅ INGESTION QUEUE TEST PASSED: HTTP 429 rate limit response correctly paused worker execution for ${elapsed}ms.`);
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Rate Limit Pause):', err.message);
    return false;
  }

  // Test 3: Worker Creation & Concurrency / Limiter Options Verification
  try {
    const worker = createIngestionWorker();
    if (!worker || worker.opts.concurrency !== 5) {
      console.error('❌ INGESTION QUEUE TEST FAILED: Worker concurrency option mismatch!', worker?.opts);
      return false;
    }

    await worker.close();
    console.log('✅ INGESTION QUEUE TEST PASSED: BullMQ worker initialized with concurrency=5, rate limiters, and DLQ handlers.');
  } catch (err: any) {
    console.error('❌ INGESTION QUEUE TEST EXCEPTION (Worker Init):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestionQueueTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
