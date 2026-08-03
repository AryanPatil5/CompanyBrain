import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase.js';

/**
 * Server-side lookup utility mapping external org IDs to internal workspace_id
 */
export async function resolveWorkspaceForWebhook(
  provider: 'slack' | 'github' | 'linear' | 'zendesk',
  externalOrgId: string
): Promise<string | null> {
  if (!externalOrgId) return null;

  try {
    const { data } = await supabase
      .from('integration_installations')
      .select('workspace_id')
      .eq('provider', provider)
      .eq('external_org_id', externalOrgId)
      .single();

    if (data?.workspace_id) {
      return data.workspace_id;
    }
  } catch {
    // Non-fatal lookup fallback
  }

  return null;
}

/**
 * Middleware for resolving Slack team_id to internal workspace_id before rate limiting
 */
export function resolveSlackWorkspaceMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const externalOrgId = req.body?.team_id || req.body?.team?.id;
    if (!externalOrgId) {
      return res.status(400).json({ error: 'Missing team_id in Slack webhook payload.' });
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('slack', externalOrgId);
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'This Slack workspace is not registered with Company Brain.' });
    }

    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';
    return next();
  };
}

/**
 * Middleware for resolving GitHub installation_id to internal workspace_id before rate limiting
 */
export function resolveGitHubWorkspaceMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const externalOrgId = req.body?.installation?.id || req.body?.repository?.owner?.id || req.body?.org;
    if (!externalOrgId) {
      return res.status(400).json({ error: 'Missing installation_id or owner in GitHub webhook payload.' });
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('github', String(externalOrgId));
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'This GitHub organization is not registered with Company Brain.' });
    }

    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';
    return next();
  };
}

/**
 * Middleware for resolving Linear organizationId to internal workspace_id before rate limiting
 */
export function resolveLinearWorkspaceMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const externalOrgId = req.body?.organizationId || req.body?.org_id;
    if (!externalOrgId) {
      return res.status(400).json({ error: 'Missing organizationId in Linear webhook payload.' });
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('linear', String(externalOrgId));
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'This Linear organization is not registered with Company Brain.' });
    }

    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';
    return next();
  };
}

// Middleware for Slack Webhook signature verification
export function verifySlackSignature(req: Request, res: Response, next: NextFunction) {
  const isProd = process.env.NODE_ENV === 'production';
  const slackSecret = process.env.SLACK_SIGNING_SECRET;

  if (!slackSecret) {
    if (isProd) {
      return res.status(401).json({ error: 'Unauthorized: SLACK_SIGNING_SECRET missing in production' });
    }
    return next();
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !signature) {
    return res.status(401).json({ error: 'Unauthorized: missing Slack headers' });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    return res.status(401).json({ error: 'Unauthorized: request timestamp expired' });
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac('sha256', slackSecret);
  hmac.update(baseString);
  const mySignature = `v0=${hmac.digest('hex')}`;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))) {
      return res.status(401).json({ error: 'Unauthorized: signature mismatch' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized: invalid signature length' });
  }

  return next();
}

// Middleware for GitHub Webhook signature verification
export function verifyGitHubSignature(req: Request, res: Response, next: NextFunction) {
  const isProd = process.env.NODE_ENV === 'production';
  const githubSecret = process.env.GITHUB_WEBHOOK_SECRET;

  if (!githubSecret) {
    if (isProd) {
      return res.status(401).json({ error: 'Unauthorized: GITHUB_WEBHOOK_SECRET missing in production' });
    }
    return next();
  }

  const signature = req.headers['x-hub-signature-256'] as string;

  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized: missing x-hub-signature-256 header' });
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', githubSecret);
  hmac.update(rawBody);
  const mySignature = `sha256=${hmac.digest('hex')}`;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))) {
      return res.status(401).json({ error: 'Unauthorized: GitHub signature mismatch' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized: invalid signature length' });
  }

  return next();
}

// Middleware for Linear Webhook signature verification
export function verifyLinearSignature(req: Request, res: Response, next: NextFunction) {
  const isProd = process.env.NODE_ENV === 'production';
  const linearSecret = process.env.LINEAR_WEBHOOK_SECRET;

  if (!linearSecret) {
    if (isProd) {
      return res.status(401).json({ error: 'Unauthorized: LINEAR_WEBHOOK_SECRET missing in production' });
    }
    return next();
  }

  const signature = req.headers['linear-signature'] as string;

  if (!signature) {
    return res.status(401).json({ error: 'Unauthorized: missing linear-signature header' });
  }

  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const hmac = crypto.createHmac('sha256', linearSecret);
  hmac.update(rawBody);
  const mySignature = hmac.digest('hex');

  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(mySignature))) {
      return res.status(401).json({ error: 'Unauthorized: Linear signature mismatch' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized: invalid signature length' });
  }

  return next();
}
