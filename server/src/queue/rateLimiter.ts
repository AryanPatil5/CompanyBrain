/**
 * Rate Limiter & Exponential Backoff Utility for BullMQ Ingestion Queues
 * Parses HTTP 429 Retry-After headers and calculates exponential delay windows.
 */

export function parseRetryAfterHeader(retryAfterHeader?: string | null): number | null {
  if (!retryAfterHeader) return null;
  const seconds = parseInt(retryAfterHeader, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }
  const date = Date.parse(retryAfterHeader);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

export function calculateExponentialBackoff(attempt: number, baseDelayMs = 5000, maxDelayMs = 60000): number {
  const delay = baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(delay, maxDelayMs);
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleRateLimitResponse(
  retryAfterHeader?: string | null,
  attempt: number = 1
): Promise<number> {
  const retryAfterMs = parseRetryAfterHeader(retryAfterHeader);
  const delayMs = retryAfterMs !== null ? retryAfterMs : calculateExponentialBackoff(attempt);
  console.log(`[RateLimiter] HTTP 429 Rate Limit Encountered. Pausing execution for ${delayMs}ms (Attempt #${attempt})...`);
  await sleep(delayMs);
  return delayMs;
}
