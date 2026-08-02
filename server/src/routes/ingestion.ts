import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { extractSOPFromThread } from '../services/extractor.js';
import {
  normalizeSlack,
  normalizeGitHub,
  normalizeLinear,
  normalizeZendesk,
  normalizeEmail,
  normalizeDatabase,
  normalizeDirectTeach,
  type ThreadPayload,
} from '../services/connectors.js';
import { detectConflict, createVersion } from '../services/freshness.js';
import { verifySlackSignature, verifyGitHubSignature, verifyLinearSignature, resolveWorkspaceForWebhook } from './connectors.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { generateEmbedding } from '../services/embeddings.js';
import { getTenantClient } from '../middleware/tenantClient.js';

const router = Router();

async function processThread(payload: ThreadPayload, res: Response, req?: Request): Promise<void> {
  const { workspace_id, source, external_thread_id, channel_or_project, messages } = payload;
  const client = req ? getTenantClient(req) : supabase;

  console.log(`[Ingestion] Received ${source} webhook for thread/source: ${external_thread_id}`);

  // Store raw thread
  const { data: rawThread, error: rawErr } = await client
    .from('raw_threads')
    .upsert({
      workspace_id,
      source,
      external_thread_id,
      channel_or_project,
      raw_content: messages,
      is_processed: false,
    }, { onConflict: 'workspace_id, source, external_thread_id' })
    .select()
    .single();

  if (rawErr) {
    console.error('[Ingestion Error] Failed to store raw thread:', rawErr);
    res.status(500).json({ error: 'Database storage error for raw thread.' });
    return;
  }

  // Extract SOP via LLM with error handling for schema validation failures
  let extractedSOP;
  try {
    extractedSOP = await extractSOPFromThread(messages, workspace_id, source);
  } catch (extractErr) {
    res.status(422).json({
      success: false,
      error: 'SOP extraction failed schema validation',
    });
    return;
  }

  if (!extractedSOP) {
    res.status(200).json({
      message: 'Source payload processed, but no valid high-confidence SOP was identified.',
      raw_thread_id: rawThread.id,
    });
    return;
  }

  // Conflict detection — check if this SOP duplicates an existing one using pgvector
  const conflict = await detectConflict(
    extractedSOP.title,
    extractedSOP.trigger_condition,
    workspace_id
  );

  if (conflict.has_conflict && conflict.matching_sop_id) {
    console.log(`[Ingestion] Conflict detected with SOP "${conflict.matching_sop_title}" (similarity: ${conflict.similarity_score})`);

    await supabase.from('sop_citations').insert({
      sop_id: conflict.matching_sop_id,
      raw_thread_id: rawThread.id,
    });

    await supabase.from('raw_threads').update({ is_processed: true }).eq('id', rawThread.id);

    res.status(200).json({
      message: 'Payload processed. Duplicate/conflict detected with an existing SOP — linked as additional evidence.',
      conflict: {
        existing_sop_id: conflict.matching_sop_id,
        existing_sop_title: conflict.matching_sop_title,
        similarity_score: conflict.similarity_score,
        summary: conflict.conflict_summary,
      },
      raw_thread_id: rawThread.id,
    });
    return;
  }

  // Generate vector embedding for the SOP
  const sopEmbedding = await generateEmbedding(`${extractedSOP.title}: ${extractedSOP.trigger_condition}`);

  // Save as Draft SOP with Risk Level, Human Gate Policy, and vector embedding
  const insertPayload: Record<string, any> = {
    workspace_id,
    title: extractedSOP.title,
    category: extractedSOP.category,
    trigger_condition: extractedSOP.trigger_condition,
    preconditions: extractedSOP.preconditions,
    execution_steps: extractedSOP.execution_steps,
    risk_level: extractedSOP.risk_level || 'Low',
    requires_human_gate: extractedSOP.requires_human_gate || false,
    status: 'Draft',
    version: 1,
    last_confirmed_at: new Date().toISOString(),
    is_stale: false,
  };

  if (sopEmbedding) {
    insertPayload.embedding = sopEmbedding;
  }

  let { data: sopData, error: sopErr } = await supabase
    .from('skills_sops')
    .insert(insertPayload)
    .select()
    .single();

  if (sopErr && (sopErr.message.includes('embedding') || sopErr.message.includes('risk_level') || sopErr.message.includes('column'))) {
    console.warn('[Ingestion Warning] Column missing in schema, inserting without extended vector/risk columns.');
    delete insertPayload.embedding;
    delete insertPayload.risk_level;
    delete insertPayload.requires_human_gate;

    const retry = await supabase
      .from('skills_sops')
      .insert(insertPayload)
      .select()
      .single();

    sopData = retry.data;
    sopErr = retry.error;
  }

  if (sopErr || !sopData) {
    console.error('[Ingestion Error] Failed to store SOP draft:', sopErr);
    res.status(500).json({ error: 'Failed to create SOP record.' });
    return;
  }

  // Create initial version snapshot
  await createVersion(sopData.id, 'system', 'initial_extraction');

  // Citation link
  await supabase.from('sop_citations').insert({
    sop_id: sopData.id,
    raw_thread_id: rawThread.id,
  });

  await supabase.from('raw_threads').update({ is_processed: true }).eq('id', rawThread.id);

  console.log(`[Ingestion Success] Created Draft SOP "${sopData.title}" (ID: ${sopData.id}) [Risk: ${sopData.risk_level}]`);

  res.status(201).json({
    message: 'SOP draft successfully generated and linked.',
    sop: sopData,
  });
}

// ─── Webhook Routes ──────────────────────────────────────────

router.post('/webhook', verifySlackSignature, async (req: Request, res: Response): Promise<void> => {
  try {
    const externalOrgId = req.body.team_id || req.body.team?.id;
    if (!externalOrgId) {
      res.status(400).json({ error: 'Missing team_id in Slack webhook payload.' });
      return;
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('slack', externalOrgId);
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'This Slack workspace is not registered with Company Brain.' });
      return;
    }

    // Override req.body.workspace_id with verified server-side workspace ID
    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';

    const payload = normalizeSlack(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Missing required payload parameters or invalid messages format.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    console.error('[Ingestion Error]:', error);
    res.status(500).json({ error: 'Internal server error during ingestion.' });
  }
});

router.post('/webhook/github', verifyGitHubSignature, async (req: Request, res: Response): Promise<void> => {
  try {
    const externalOrgId = req.body.installation?.id || req.body.repository?.owner?.id || req.body.org;
    if (!externalOrgId) {
      res.status(400).json({ error: 'Missing installation_id or owner in GitHub webhook payload.' });
      return;
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('github', String(externalOrgId));
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'This GitHub organization is not registered with Company Brain.' });
      return;
    }

    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';

    const payload = normalizeGitHub(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Invalid GitHub payload.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during GitHub ingestion.' });
  }
});

router.post('/webhook/linear', verifyLinearSignature, async (req: Request, res: Response): Promise<void> => {
  try {
    const externalOrgId = req.body.organizationId || req.body.org_id;
    if (!externalOrgId) {
      res.status(400).json({ error: 'Missing organizationId in Linear webhook payload.' });
      return;
    }

    const serverWorkspaceId = await resolveWorkspaceForWebhook('linear', String(externalOrgId));
    if (!serverWorkspaceId && process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'This Linear organization is not registered with Company Brain.' });
      return;
    }

    req.body.workspace_id = serverWorkspaceId || req.body.workspace_id || '00000000-0000-0000-0000-000000000000';

    const payload = normalizeLinear(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Invalid Linear payload.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during Linear ingestion.' });
  }
});

router.post('/webhook/zendesk', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const payload = normalizeZendesk({
      ...req.body,
      workspace_id: user.workspace_id
    });
    if (!payload) {
      res.status(400).json({ error: 'Invalid Zendesk support payload.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during Zendesk ingestion.' });
  }
});

router.post('/webhook/email', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const payload = normalizeEmail({
      ...req.body,
      workspace_id: user.workspace_id
    });
    if (!payload) {
      res.status(400).json({ error: 'Invalid email payload.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during Email ingestion.' });
  }
});

router.post('/webhook/database', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const payload = normalizeDatabase({
      ...req.body,
      workspace_id: user.workspace_id
    });
    if (!payload) {
      res.status(400).json({ error: 'Invalid database runbook payload.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error during Database ingestion.' });
  }
});

router.post('/webhook/teach', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const payload = normalizeDirectTeach({
      ...req.body,
      workspace_id: user.workspace_id
    });
    if (!payload) {
      res.status(400).json({ error: 'Invalid tacit knowledge payload. Ensure title and description are provided.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    console.error('[Direct Teach Ingestion Error]:', error);
    res.status(500).json({ error: 'Internal server error during Tacit Knowledge ingestion.' });
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
    console.error('[Interview Elicitation Error]:', err);
    res.status(502).json({
      success: false,
      error: 'Unable to generate interview questions for this SOP draft. Please try again or fill in the missing fields manually.',
    });
  }
});

export default router;