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
import { verifySlackSignature, verifyGitHubSignature, verifyLinearSignature } from './connectors.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

async function processThread(payload: ThreadPayload, res: Response): Promise<void> {
  const { workspace_id, source, external_thread_id, channel_or_project, messages } = payload;

  console.log(`[Ingestion] Received ${source} webhook for thread/source: ${external_thread_id}`);

  // Store raw thread
  const { data: rawThread, error: rawErr } = await supabase
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

  // Extract SOP via LLM
  const extractedSOP = await extractSOPFromThread(messages);

  if (!extractedSOP) {
    res.status(200).json({
      message: 'Source payload processed, but no valid high-confidence SOP was identified.',
      raw_thread_id: rawThread.id,
    });
    return;
  }

  // Conflict detection — check if this SOP duplicates an existing one
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

  // Save as Draft SOP with Risk Level & Human Gate Policy
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

  let { data: sopData, error: sopErr } = await supabase
    .from('skills_sops')
    .insert(insertPayload)
    .select()
    .single();

  if (sopErr && (sopErr.message.includes('risk_level') || sopErr.message.includes('column'))) {
    console.warn('[Ingestion Warning] risk_level column missing, inserting without migration 004 columns.');
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

export default router;