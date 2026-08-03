import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for authenticated ingestion routes (/teach, /zendesk, /email, /database).
 * Restricts client requests to 30 requests per minute per IP / workspace.
 */
export const ingestionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Limit each IP / workspace to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    error: 'Too many ingestion requests. Please wait before submitting additional operational knowledge.',
  },
  keyGenerator: (req) => {
    const userWorkspace = (req as any).user?.workspace_id;
    return userWorkspace || req.ip || 'anonymous';
  },
});

/**
 * Higher-throughput rate limiter for webhook routes (/webhook, /webhook/github, /webhook/linear).
 * Restricts webhooks to 60 requests per minute per resolved workspace_id.
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Limit each resolved workspace to 60 webhook events per minute
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  message: {
    error: 'Too many webhook events received for this workspace. Request rate throttled.',
  },
  keyGenerator: (req) => {
    const workspaceId = req.body?.workspace_id;
    return workspaceId || req.ip || 'anonymous';
  },
});
