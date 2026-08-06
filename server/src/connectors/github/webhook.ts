// GitHub App webhook handling: signature verification, event parsing, and
// dispatch into the github-sync worker queue. Reuses the existing HMAC
// verifier and the existing workspace resolution for webhooks.

import { verifyWebhookSignature } from '../../services/ingestion/webhookService.js';
import { resolveWorkspaceForWebhook } from '../../routes/connectors.js';
import { logger } from '../../logger.js';
import type { GithubWebhookAction, GithubWebhookEventInput, GithubWebhookJobData, GithubSyncRepositoryJobData } from './types.js';

export interface GithubWebhookResult {
  handled: boolean;
  action?: string;
  workspaceId?: string;
  reason?: string;
}

export interface GithubWebhookHandlerOptions {
  queueEnabled?: boolean;
}

export class GithubWebhookHandler {
  private readonly queueEnabled: boolean;

  constructor(options: GithubWebhookHandlerOptions = {}) {
    this.queueEnabled = options.queueEnabled ?? true;
  }

  /**
   * Verifies the x-hub-signature-256 HMAC over the raw request body.
   * Uses the existing webhookService verifier so both webhook routes
   * (/api/v1/webhooks and /api/ingestion/webhook/github) behave identically.
   */
  verifySignature(rawBody: string, signatureHeader: string, secret?: string): boolean {
    return verifyWebhookSignature('github', rawBody, signatureHeader, secret || process.env.GITHUB_WEBHOOK_SECRET || '');
  }

  /**
   * Maps a GitHub webhook event to a sync action. Returns null for events
   * this connector does not act on.
   */
  parseEvent(event: string, payload: any): GithubWebhookAction | null {
    const installationId = payload?.installation?.id;
    if (!installationId) return null;

    const repository = payload?.repository;

    switch (event) {
      case 'installation': {
        const action = payload?.action;
        if (action === 'deleted') {
          return { kind: 'unmap_installation', installationId };
        }
        if (action === 'created' || action === 'unsuspend') {
          return { kind: 'sync_installation', installationId };
        }
        return { kind: 'map_installation', installationId };
      }
      case 'installation_repositories':
        return { kind: 'sync_installation', installationId };

      case 'push':
      case 'pull_request':
      case 'issues':
      case 'issue_comment':
      case 'discussion':
      case 'discussion_comment':
      case 'release': {
        if (!repository?.full_name) return null;
        return {
          kind: 'sync_repository',
          installationId,
          repository: {
            repoId: repository.id,
            fullName: repository.full_name,
            branch: event === 'push' ? (payload?.ref || '').replace('refs/heads/', '') || undefined : undefined,
          },
        };
      }

      case 'repository': {
        if (!repository?.full_name) return null;
        const action = payload?.action;
        if (action === 'deleted') {
          return { kind: 'unmap_installation', installationId };
        }
        return {
          kind: 'sync_repository',
          installationId,
          repository: { repoId: repository.id, fullName: repository.full_name },
        };
      }

      default:
        return null;
    }
  }

  /**
   * Entry point for the webhook route: resolve workspace, parse the event,
   * and enqueue a github-sync job. Mirrors the existing <200ms queue-then-ack
   * contract of /api/v1/webhooks.
   */
  async handleEvent(input: GithubWebhookEventInput): Promise<GithubWebhookResult> {
    const { event, deliveryId, payload } = input;
    const installationId: number | undefined = payload?.installation?.id;

    if (!installationId) {
      return { handled: false, reason: 'payload missing installation id' };
    }

    const workspaceId = input.workspaceId || (await resolveWorkspaceForWebhook('github', String(installationId)));
    if (!workspaceId) {
      logger.warn('github_webhook_unmapped_installation', { event, deliveryId, installationId });
      return { handled: false, reason: 'installation not mapped to a workspace' };
    }

    const action = this.parseEvent(event, payload);
    if (!action) {
      return { handled: false, reason: `unhandled event type: ${event}` };
    }

    logger.info('github_webhook_event', {
      event,
      deliveryId,
      installationId,
      workspaceId,
      action: action.kind,
      repository: action.repository?.fullName,
    });

    if (!this.queueEnabled) {
      return { handled: true, workspaceId, action: action.kind };
    }

    switch (action.kind) {
      case 'sync_repository': {
        const { githubSyncQueue } = await import('../../queue/githubSyncQueue.js');
        const jobData: GithubSyncRepositoryJobData = {
          workspaceId,
          installationId,
          repoId: action.repository!.repoId,
          fullName: action.repository!.fullName,
          branch: action.repository!.branch,
          incremental: true,
          trigger: 'webhook',
        };
        await githubSyncQueue.add('sync_repository', { job_name: 'sync_repository', ...jobData }, { jobId: `ghwh-${deliveryId}` });
        break;
      }
      case 'sync_installation': {
        const { githubSyncQueue } = await import('../../queue/githubSyncQueue.js');
        await githubSyncQueue.add(
          'sync_installation',
          { job_name: 'sync_installation', workspaceId, installationId },
          { jobId: `ghwh-${deliveryId}` }
        );
        break;
      }
      case 'map_installation':
      case 'unmap_installation': {
        // No queue work needed: installation mapping is handled by the
        // integrations callback and resolveWorkspaceForWebhook.
        break;
      }
    }

    return { handled: true, workspaceId, action: action.kind };
  }
}

export function createGithubWebhookHandler(options?: GithubWebhookHandlerOptions): GithubWebhookHandler {
  return new GithubWebhookHandler(options);
}

export type GithubWebhookJobPayload = GithubWebhookJobData;

export const GITHUB_SUPPORTED_WEBHOOK_EVENTS = [
  'push',
  'pull_request',
  'issues',
  'issue_comment',
  'discussion',
  'discussion_comment',
  'release',
  'repository',
] as const;
