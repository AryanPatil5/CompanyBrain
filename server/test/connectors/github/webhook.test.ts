// Unit tests: GitHub webhook HMAC verification, event parsing for all
// supported events, and dispatch mapping. Pure tests — queue is disabled.

import crypto from 'node:crypto';
import { createGithubWebhookHandler } from '../../../src/connectors/github/webhook.js';

function sign(rawBody: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function basePayload(installationId = 99, fullName = 'acme/brains'): any {
  return {
    installation: { id: installationId },
    repository: { id: 777, full_name: fullName, default_branch: 'main' },
  };
}

async function runWebhookTest(): Promise<boolean> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean): void => {
    if (ok) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      console.log(`  ❌ ${name}`);
    }
  };

  const handler = createGithubWebhookHandler({ queueEnabled: false });

  // ─── 1. HMAC signature verification ───
  const rawBody = JSON.stringify(basePayload());
  const valid = handler.verifySignature(rawBody, sign(rawBody, 'webhook-secret'), 'webhook-secret');
  check('Valid HMAC signature accepted', valid === true);

  const invalid = handler.verifySignature(rawBody, sign(rawBody, 'wrong-secret'), 'webhook-secret');
  check('Invalid HMAC signature rejected', invalid === false);

  const tampered = handler.verifySignature(rawBody + 'x', sign(rawBody, 'webhook-secret'), 'webhook-secret');
  check('Tampered body rejected', tampered === false);

  const missing = handler.verifySignature(rawBody, '', 'webhook-secret');
  check('Missing signature header rejected', missing === false);

  // ─── 2. All supported repo events map to sync_repository ───
  for (const event of ['push', 'pull_request', 'issues', 'issue_comment', 'discussion', 'discussion_comment', 'release', 'repository']) {
    const payload = basePayload();
    if (event === 'push') payload.ref = 'refs/heads/main';
    const action = handler.parseEvent(event, payload);
    check(`${event} → sync_repository`, action?.kind === 'sync_repository' && action.repository?.fullName === 'acme/brains');
  }

  // ─── 3. push event captures the branch ───
  const pushAction = handler.parseEvent('push', { ...basePayload(), ref: 'refs/heads/release/2.x' });
  check('push event maps ref to branch', pushAction?.repository?.branch === 'release/2.x');

  // ─── 4. Installation lifecycle events ───
  const created = handler.parseEvent('installation', { installation: { id: 5 }, action: 'created' });
  check('installation created → sync_installation', created?.kind === 'sync_installation' && created.installationId === 5);

  const deleted = handler.parseEvent('installation', { installation: { id: 5 }, action: 'deleted' });
  check('installation deleted → unmap_installation', deleted?.kind === 'unmap_installation');

  const repoAdded = handler.parseEvent('installation_repositories', { installation: { id: 5 }, action: 'added' });
  check('installation_repositories → sync_installation', repoAdded?.kind === 'sync_installation');

  // ─── 5. repository deleted → unmap ───
  const repoDeleted = handler.parseEvent('repository', { ...basePayload(), action: 'deleted' });
  check('repository deleted → unmap_installation', repoDeleted?.kind === 'unmap_installation');

  // ─── 6. Unhandled / malformed events → null ───
  check('unknown event → null', handler.parseEvent('star', basePayload()) === null);
  check('missing installation → null', handler.parseEvent('push', { repository: { full_name: 'x/y' } }) === null);
  check('missing repository → null', handler.parseEvent('push', { installation: { id: 1 } }) === null);
  check('no payload → null', handler.parseEvent('push', null) === null);

  // ─── 7. handleEvent without a mapped workspace stays safe ───
  const result = await handler.handleEvent({
    event: 'push',
    deliveryId: 'deliv-1',
    payload: basePayload(424242, 'acme/brains'),
  });
  check('handleEvent returns handled=false for unmapped installation', result.handled === false);

  console.log(`\nWebhook tests: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebhookTest().then((ok) => process.exit(ok ? 0 : 1));
}

export { runWebhookTest };
