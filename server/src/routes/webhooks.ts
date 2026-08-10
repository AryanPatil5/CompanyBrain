import { Router, Request, Response } from 'express';
import { verifyWebhookSignature } from '../services/ingestion/webhookService.js';
import { normalizeSlack, normalizeSlackEvent } from '../services/connectors.js';
import { ingestWebhookEvent } from '../ingestion/webhookPipeline.js';
import { extractWebhookEventTimestamp } from '../services/ingestion/webhookService.js';
import { createGithubWebhookHandler } from '../connectors/github/webhook.js';
import { logger } from '../logger.js';

const router = Router();

const DEV_DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Event-Driven Webhook Route Handler for GitHub & Slack.
 * Validates HMAC SHA-256 signatures. Slack deliveries run through the
 * canonical durable webhook pipeline (raw_source_events -> webhook-ingestion
 * queue -> webhook worker) so the consumer only ever sees the canonical
 * { eventId, workspaceId } job payload.
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

  const workspaceId = (req.headers['x-workspace-id'] as string) || DEV_DEFAULT_WORKSPACE_ID;

  // GitHub webhooks are dispatched through the GitHub connector so events are
  // parsed into sync jobs on the github-sync queue (consumed by githubSyncWorker).
  if (provider === 'github') {
    try {
      const githubHandler = createGithubWebhookHandler();
      const result = await githubHandler.handleEvent({
        event: (req.headers['x-github-event'] as string) || 'push',
        deliveryId,
        payload: req.body,
        workspaceId,
      });
      if (!result.handled) {
        logger.info('github_webhook_not_handled', { deliveryId, reason: result.reason });
      }
    } catch (err: any) {
      logger.warn('github_webhook_dispatch_failed', { deliveryId, error: err.message });
    }

    const durationMs = Date.now() - startTime;
    res.status(200).json({
      status: 'ok',
      message: 'Webhook payload received and queued.',
      provider,
      deliveryId,
      durationMs,
    });
    return;
  }

  // Slack: normalize (custom ThreadPayload envelope first, real Slack Events
  // API payloads second), then hand off to the durable pipeline.
  const normalized = normalizeSlack(req.body) ?? normalizeSlackEvent(req.body, workspaceId);
  if (!normalized) {
    // Non-SOP Slack events (channel joins, message deletions, etc.): ack so
    // Slack does not retry, but ingest nothing.
    const durationMs = Date.now() - startTime;
    res.status(200).json({
      status: 'ok',
      message: 'Event acknowledged, nothing to ingest.',
      provider,
      deliveryId,
      durationMs,
    });
    return;
  }

  try {
    const result = await ingestWebhookEvent({
      workspaceId,
      provider: 'slack',
      source: 'slack',
      externalId: normalized.external_thread_id,
      eventTimestamp: extractWebhookEventTimestamp('slack', req.body),
      rawPayload: req.body,
      normalizedPayload: normalized,
      sourceTrust: 'crawled',
    });

    const durationMs = Date.now() - startTime;
    res.status(202).json({
      status: 'ok',
      message: 'Webhook payload received and queued.',
      provider,
      deliveryId,
      event_id: result.eventId,
      event_status: result.status,
      durationMs,
    });
  } catch (err: any) {
    logger.error('[Webhooks Route Error] Failed to ingest Slack event:', err);
    res.status(500).json({ error: 'Internal server error during ingestion.' });
  }
});

export default router;
