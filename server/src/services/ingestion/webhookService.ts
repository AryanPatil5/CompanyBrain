import { logger } from '../../logger.js';
import crypto from 'node:crypto';
import { supabase } from '../../config/supabase.js';

export interface WebhookEventPayload {
  provider: 'github' | 'slack' | 'linear' | 'zendesk';
  deliveryId: string;
  workspaceId: string;
  eventTimestamp: string;
  payload: any;
}

/**
 * Validates HMAC SHA-256 signatures for incoming Slack & GitHub webhooks.
 */
export function verifyWebhookSignature(
  provider: 'github' | 'slack',
  rawBody: string,
  signatureHeader: string,
  secret: string,
  timestampHeader?: string
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;

  try {
    if (provider === 'github') {
      const expectedSig = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig));
    }

    if (provider === 'slack') {
      if (!timestampHeader) return false;
      const sigBasestring = `v0:${timestampHeader}:${rawBody}`;
      const expectedSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');
      return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig));
    }
  } catch (err) {
    logger.warn('[WebhookService Warning] HMAC Signature verification exception:', err);
    return false;
  }

  return false;
}

/**
 * Processes incoming webhook events incrementally, dropping stale out-of-order deliveries.
 */
export async function processWebhookEvent(
  event: WebhookEventPayload
): Promise<{ processed: boolean; reason?: string }> {
  const { provider, workspaceId, eventTimestamp, deliveryId } = event;
  const currentTs = new Date(eventTimestamp).getTime();

  try {
    const { data: sub } = await supabase
      .from('webhook_subscriptions')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('provider', provider)
      .single();

    if (sub && sub.last_event_timestamp) {
      const lastTs = new Date(sub.last_event_timestamp).getTime();
      if (currentTs <= lastTs) {
        return { processed: false, reason: 'Ignored stale or duplicate out-of-order webhook delivery.' };
      }
    }

    // Update last_event_timestamp & delivery_token in webhook_subscriptions
    await supabase.from('webhook_subscriptions').upsert(
      {
        workspace_id: workspaceId,
        provider,
        last_delivery_token: deliveryId,
        last_event_timestamp: new Date(currentTs).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'workspace_id, provider' }
    );

    return { processed: true };
  } catch (err: any) {
    logger.warn('[WebhookService Warning] Failed to process incremental webhook update:', err);
    return { processed: true };
  }
}
