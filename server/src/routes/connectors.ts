import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

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
