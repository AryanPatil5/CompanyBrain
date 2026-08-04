import crypto from 'node:crypto';
import { verifyWebhookSignature, processWebhookEvent } from '../../src/services/ingestion/webhookService.js';

export async function runWebhooksRouteTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running High-Throughput Webhooks & HMAC Test  ');
  console.log('=================================================');

  const secret = 'test_webhook_secret_key_123';
  const rawBody = JSON.stringify({ event: 'push', repository: { name: 'CompanyBrain' } });

  // Test 1: GitHub HMAC SHA-256 signature verification
  try {
    const validGithubSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const isValidGithub = verifyWebhookSignature('github', rawBody, validGithubSig, secret);

    if (!isValidGithub) {
      console.error('❌ WEBHOOK TEST FAILED: Valid GitHub HMAC SHA-256 signature failed verification!');
      return false;
    }

    const isInvalidGithub = verifyWebhookSignature('github', rawBody, 'sha256=invalid_hash', secret);
    if (isInvalidGithub) {
      console.error('❌ WEBHOOK TEST FAILED: Invalid GitHub signature was incorrectly accepted!');
      return false;
    }

    console.log('✅ WEBHOOK TEST PASSED: Successfully verified valid GitHub HMAC SHA-256 signatures and rejected invalid hashes.');
  } catch (err: any) {
    console.error('❌ WEBHOOK TEST EXCEPTION (GitHub HMAC):', err.message);
    return false;
  }

  // Test 2: Slack HMAC SHA-256 signature verification
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const validSlackSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

    const isValidSlack = verifyWebhookSignature('slack', rawBody, validSlackSig, secret, timestamp);
    if (!isValidSlack) {
      console.error('❌ WEBHOOK TEST FAILED: Valid Slack HMAC SHA-256 signature failed verification!');
      return false;
    }
    console.log('✅ WEBHOOK TEST PASSED: Successfully verified valid Slack HMAC SHA-256 signatures.');
  } catch (err: any) {
    console.error('❌ WEBHOOK TEST EXCEPTION (Slack HMAC):', err.message);
    return false;
  }

  // Test 3: Incremental Sync & Out-of-Order Timestamp Verification
  try {
    const now = new Date().toISOString();
    const staleTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago

    const workspaceId = '00000000-0000-0000-0000-000000000000';

    // Process initial event
    await processWebhookEvent({
      provider: 'github',
      deliveryId: 'deliv_1',
      workspaceId,
      eventTimestamp: now,
      payload: {},
    });

    // Attempt stale out-of-order event
    const staleRes = await processWebhookEvent({
      provider: 'github',
      deliveryId: 'deliv_stale',
      workspaceId,
      eventTimestamp: staleTime,
      payload: {},
    });

    if (staleRes.processed) {
      console.error('❌ WEBHOOK TEST FAILED: Stale out-of-order webhook delivery was NOT ignored!', staleRes);
      return false;
    }
    console.log('✅ WEBHOOK TEST PASSED: Successfully detected and ignored stale out-of-order webhook delivery.');
  } catch (err: any) {
    console.error('❌ WEBHOOK TEST EXCEPTION (Incremental Sync):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebhooksRouteTest().then((success) => {
    if (!success) process.exit(1);
  });
}
