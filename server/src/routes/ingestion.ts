import { logger } from '../logger.js';
import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import {
  normalizeSlack,
  normalizeGitHub,
  normalizeLinear,
  normalizeZendesk,
  normalizeEmail,
  normalizeDatabase,
  normalizeDirectTeach,
} from '../services/connectors.js';
import {
  verifySlackSignature,
  verifyGitHubSignature,
  verifyLinearSignature,
  resolveSlackWorkspaceMiddleware,
  resolveGitHubWorkspaceMiddleware,
  resolveLinearWorkspaceMiddleware,
} from './connectors.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { ingestionLimiter, webhookLimiter } from '../middleware/rateLimiter.js';
import { ingestionQueue } from '../queue/ingestionQueue.js';
import { type IngestionJobData } from '../workers/ingestionWorker.js';
import { ingestWebhookEvent } from '../ingestion/webhookPipeline.js';
import { extractWebhookEventTimestamp } from '../services/ingestion/webhookService.js';

const router = Router();

// ─── Webhook Routes (durable pipeline, Phase 2 Task 1) ─────────────
// Every accepted delivery is first persisted to `raw_source_events`
// (dedupe-keyed, at-least-once -> exactly-once recording) and then handed to
// the webhook consumer via `webhook-ingestion`. The API answers 202 with the
// durable `event_id` immediately; status can be polled at
// GET /api/ingestion/events/:event_id.

async function acceptWebhookEvent(req: Request, res: Response, input: {
  provider: string;
  source: string;
  sourceTrust: 'manual' | 'crawled';
  normalized: ReturnType<typeof normalizeSlack> | null;
  rawBody: unknown;
}): Promise<void> {
  const { provider, source, sourceTrust, normalized, rawBody } = input;
  if (!normalized) {
    res.status(400).json({ error: 'Invalid payload: missing required parameters or invalid messages format.' });
    return;
  }

  try {
    const result = await ingestWebhookEvent({
      workspaceId: normalized.workspace_id,
      provider,
      source,
      externalId: normalized.external_thread_id,
      eventTimestamp: extractWebhookEventTimestamp(provider, rawBody),
      rawPayload: rawBody,
      normalizedPayload: normalized,
      sourceTrust,
    });

    res.status(202).json({
      success: true,
      event_id: result.eventId,
      status: result.status,
      message: result.replayed
        ? 'Duplicate delivery acknowledged — event already processed.'
        : result.status === 'queued'
          ? 'Webhook event accepted and queued for processing.'
          : 'Webhook event accepted. Processing will resume automatically.',
    });
  } catch (error) {
    logger.error(`[Ingestion Error] ${source} webhook acceptance failed:`, error);
    res.status(500).json({ error: 'Internal server error during ingestion.' });
  }
}

router.post('/webhook', verifySlackSignature, resolveSlackWorkspaceMiddleware(), webhookLimiter, async (req: Request, res: Response): Promise<void> => {
  await acceptWebhookEvent(req, res, {
    provider: 'slack',
    source: 'slack',
    sourceTrust: 'crawled',
    normalized: normalizeSlack(req.body),
    rawBody: req.body,
  });
});

router.post('/webhook/github', verifyGitHubSignature, resolveGitHubWorkspaceMiddleware(), webhookLimiter, async (req: Request, res: Response): Promise<void> => {
  await acceptWebhookEvent(req, res, {
    provider: 'github',
    source: 'github',
    sourceTrust: 'crawled',
    normalized: normalizeGitHub(req.body),
    rawBody: req.body,
  });
});

router.post('/webhook/linear', verifyLinearSignature, resolveLinearWorkspaceMiddleware(), webhookLimiter, async (req: Request, res: Response): Promise<void> => {
  await acceptWebhookEvent(req, res, {
    provider: 'linear',
    source: 'linear',
    sourceTrust: 'crawled',
    normalized: normalizeLinear(req.body),
    rawBody: req.body,
  });
});

router.post('/webhook/zendesk', authenticate, ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user!;
  await acceptWebhookEvent(req, res, {
    provider: 'zendesk',
    source: 'zendesk',
    sourceTrust: 'crawled',
    normalized: normalizeZendesk({ ...req.body, workspace_id: user.workspace_id }),
    rawBody: req.body,
  });
});

router.post('/webhook/email', authenticate, ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user!;
  await acceptWebhookEvent(req, res, {
    provider: 'email',
    source: 'email',
    sourceTrust: 'crawled',
    normalized: normalizeEmail({ ...req.body, workspace_id: user.workspace_id }),
    rawBody: req.body,
  });
});

router.post('/webhook/database', authenticate, ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user!;
  await acceptWebhookEvent(req, res, {
    provider: 'database',
    source: 'database',
    sourceTrust: 'crawled',
    normalized: normalizeDatabase({ ...req.body, workspace_id: user.workspace_id }),
    rawBody: req.body,
  });
});

router.post('/webhook/teach', authenticate, ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  const user = (req as AuthenticatedRequest).user!;
  await acceptWebhookEvent(req, res, {
    provider: 'teach',
    source: 'teach',
    sourceTrust: 'manual',
    normalized: normalizeDirectTeach({ ...req.body, workspace_id: user.workspace_id }),
    rawBody: req.body,
  });
});

// Durable event status endpoint (Phase 2 Task 1): polls the raw_source_events
// ledger row for a previously accepted webhook delivery.
router.get('/events/:eventId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const { data, error } = await supabase
      .from('raw_source_events')
      .select('*')
      .eq('id', req.params.eventId)
      .maybeSingle();

    if (error) {
      logger.error('[Ingestion Error] Failed to read webhook event:', error);
      res.status(500).json({ error: 'Internal server error fetching webhook event.' });
      return;
    }

    if (!data) {
      res.status(404).json({ error: 'Webhook event not found.' });
      return;
    }

    if (data.workspace_id !== user.workspace_id) {
      res.status(404).json({ error: 'Webhook event not found.' });
      return;
    }

    res.json({
      event_id: data.id,
      status: data.status,
      provider: data.provider,
      source: data.source,
      external_id: data.external_id,
      event_timestamp: data.event_timestamp,
      source_trust: data.source_trust,
      resulting_thread_id: data.resulting_thread_id,
      sop_id: data.sop_id,
      error_message: data.error_message,
      created_at: data.created_at,
      processed_at: data.processed_at,
    });
  } catch (error) {
    logger.error('[Ingestion Error] Webhook event status lookup failed:', error);
    res.status(500).json({ error: 'Internal server error fetching webhook event.' });
  }
});

// ─── Asynchronous Crawler Worker Queue Endpoints ─────────────

const VALID_JOB_NAMES = new Set(['crawl_slack', 'crawl_github', 'crawl_linear', 'crawl_zendesk', 'crawl_email', 'crawl_db', 'all']);

router.post('/run', authenticate, ingestionLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const requestedJob = req.body?.job_name || req.body?.source || 'all';

    if (!VALID_JOB_NAMES.has(requestedJob)) {
      res.status(400).json({
        error: `Invalid job_name. Must be one of: ${Array.from(VALID_JOB_NAMES).join(', ')}`,
      });
      return;
    }

    const jobData: IngestionJobData = {
      job_name: requestedJob as IngestionJobData['job_name'],
      workspace_id: user.workspace_id,
      requested_by: user.user_id,
      inbox: req.body?.inbox,
      target_system: req.body?.target_system,
    };

    let jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    try {
      const job = await ingestionQueue.add(requestedJob, jobData);
      if (job?.id) {
        jobId = String(job.id);
      }
    } catch (queueErr) {
      logger.warn('[Ingestion Queue Warning] Failed to enqueue to Redis BullMQ, returning fallback jobId:', queueErr);
    }

    res.status(202).json({
      success: true,
      jobId,
      status: 'queued',
      message: 'Ingestion job enqueued successfully.',
    });
  } catch (error) {
    logger.error('[Ingestion Run Error]:', error);
    res.status(500).json({ error: 'Internal server error while queueing ingestion job.' });
  }
});

router.get('/jobs/:jobId', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params;
    let job = null;
    try {
      job = await ingestionQueue.getJob(jobId);
    } catch {
      // Redis unavailable or job expired
    }

    if (!job) {
      res.status(404).json({ error: 'Job not found or expired.' });
      return;
    }

    const state = await job.getState();
    const progress = job.progress;

    res.json({
      jobId: job.id,
      name: job.name,
      status: state,
      progress,
      failedReason: job.failedReason || null,
      returnvalue: job.returnvalue || null,
      created_at: new Date(job.timestamp).toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'Internal server error fetching job status.' });
  }
});

// ─── Interactive Elicitation Endpoint ──────────────────────

router.post('/interview', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const sopDraft = req.body.sop || req.body;
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
    const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

    const prompt = `You are an Enterprise Knowledge Engineer conducting an interactive elicitation interview for an SOP draft.
Analyze this incomplete SOP draft:
Title: "${sopDraft.title || 'Untitled'}"
Category: "${sopDraft.category || 'Operations'}"
Trigger Condition: "${sopDraft.trigger_condition || 'Unspecified'}"
Preconditions: ${JSON.stringify(sopDraft.preconditions || [])}
Execution Steps: ${JSON.stringify(sopDraft.execution_steps || [])}
Risk Level: "${sopDraft.risk_level || 'Low'}"

Identify missing edge cases, unspecified rollback/failure procedures, unhandled error conditions, or missing risk parameters.
Generate EXACTLY 2 to 3 concise, specific clarifying questions for the human operator to complete this SOP.
Return ONLY raw JSON matching this schema:
{
  "questions": [
    "question 1 text",
    "question 2 text",
    "question 3 text"
  ]
}`;

    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5001',
        'X-Title': 'Company Brain',
      },
      body: JSON.stringify({
        model: 'inclusionai/ling-3.0-flash:free',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM interview elicitation failed (${response.status})`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content?.trim() || '';
    const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const parsed = JSON.parse(cleanJson);

    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      res.status(502).json({
        success: false,
        error: 'Unable to generate interview questions for this SOP draft. Please try again or fill in the missing fields manually.',
      });
      return;
    }

    res.json({
      success: true,
      questions: parsed.questions,
    });
  } catch (err) {
    logger.error('[Interview Elicitation Error]:', err);
    res.status(502).json({
      success: false,
      error: 'Unable to generate interview questions for this SOP draft. Please try again or fill in the missing fields manually.',
    });
  }
});

export default router;
