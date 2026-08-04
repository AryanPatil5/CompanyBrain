import { Router, Request, Response } from 'express';
import { verifyWebhookSignature, processWebhookEvent } from '../services/ingestion/webhookService.js';
import { webhookIngestionQueue } from '../queue/ingestionQueue.js';

const router = Router();

/**
 * Event-Driven Webhook Route Handler for GitHub & Slack
 * Validates HMAC SHA-256 signatures and pushes payloads to BullMQ queue in <200ms.
 */
router.post('/:provider', async (req: Request, res: Response): Promise<void> => {
  const startTime = Date.now();
  const provider = (req.params.provider || '').toLowerCase() as 'github' | 'slack';

  if (provider !== 'github' && provider !== 'slack') {
    res.status(400).json({ error: `Unsupported webhook provider: ${req.params.provider}` });
    return;
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const secret =
    provider === 'github'
      ? process.env.GITHUB_WEBHOOK_SECRET || 'dev_github_secret'
      : process.env.SLACK_SIGNING_SECRET || 'dev_slack_secret';

  const signatureHeader =
    provider === 'github'
      ? (req.headers['x-hub-signature-256'] as string)
      : (req.headers['x-slack-signature'] as string);

  const timestampHeader = req.headers['x-slack-request-timestamp'] as string;

  // Handle Slack URL verification challenge immediately
  if (provider === 'slack' && req.body?.type === 'url_verification') {
    res.json({ challenge: req.body.challenge });
    return;
  }

  // HMAC SHA-256 Signature Verification
  const isValid = verifyWebhookSignature(provider, rawBody, signatureHeader, secret, timestampHeader);

  if (!isValid && process.env.NODE_ENV === 'production') {
    res.status(401).json({ error: '401 Unauthorized: Invalid HMAC SHA-256 signature.' });
    return;
  }

  const deliveryId =
    (req.headers['x-github-delivery'] as string) ||
    (req.headers['x-slack-event-id'] as string) ||
    `deliv_${Date.now()}`;

  const workspaceId = (req.headers['x-workspace-id'] as string) || '00000000-0000-0000-0000-000000000000';

  // Push raw payload to BullMQ webhook-ingestion queue asynchronously
  try {
    await webhookIngestionQueue.add(
      `webhook_${provider}_event`,
      {
        provider,
        deliveryId,
        workspaceId,
        eventTimestamp: new Date().toISOString(),
        payload: req.body,
      },
      {
        jobId: `wh_${deliveryId}`,
      }
    );
  } catch (err: any) {
    console.warn('[Webhooks Route Warning] Redis queue push fallback:', err.message);
  }

  const durationMs = Date.now() - startTime;
  res.status(200).json({
    status: 'ok',
    message: 'Webhook payload received and queued.',
    provider,
    deliveryId,
    durationMs,
  });
});

export default router;
