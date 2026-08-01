import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { extractSOPFromThread } from '../services/extractor.js';
import { normalizeSlack, normalizeGitHub, normalizeLinear, type ThreadPayload } from '../services/connectors.js';
import { detectConflict, createVersion } from '../services/freshness.js';

const router = Router();

/**
 * Core ingestion pipeline — shared by all source-specific routes.
 * Takes a normalized ThreadPayload and runs extraction + storage.
 */
async function processThread(payload: ThreadPayload, res: Response): Promise<void> {
  const { workspace_id, source, external_thread_id, channel_or_project, messages } = payload;

  console.log(`[Ingestion] Received ${source} webhook for thread: ${external_thread_id}`);

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
      message: 'Thread processed, but no valid high-confidence SOP was identified.',
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

    // Link the thread as an additional citation to the existing SOP
    await supabase.from('sop_citations').insert({
      sop_id: conflict.matching_sop_id,
      raw_thread_id: rawThread.id,
    });

    await supabase.from('raw_threads').update({ is_processed: true }).eq('id', rawThread.id);

    res.status(200).json({
      message: 'Thread processed. Conflict detected with an existing SOP — linked as additional evidence.',
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

  // Save as Draft SOP
  const { data: sopData, error: sopErr } = await supabase
    .from('skills_sops')
    .insert({
      workspace_id,
      title: extractedSOP.title,
      category: extractedSOP.category,
      trigger_condition: extractedSOP.trigger_condition,
      preconditions: extractedSOP.preconditions,
      execution_steps: extractedSOP.execution_steps,
      status: 'Draft',
      version: 1,
      last_confirmed_at: new Date().toISOString(),
      is_stale: false,
    })
    .select()
    .single();

  if (sopErr) {
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

  console.log(`[Ingestion Success] Created Draft SOP "${sopData.title}" (ID: ${sopData.id})`);

  res.status(201).json({
    message: 'SOP draft successfully generated and linked.',
    sop: sopData,
  });
}

// ─── Slack Webhook (original + backward-compatible) ──────────

router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = normalizeSlack(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Missing required payload parameters or invalid messages format.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    console.error('[Ingestion Critical Error]:', error);
    res.status(500).json({ error: 'Internal server error during ingestion.' });
  }
});

// ─── GitHub Webhook ──────────────────────────────────────────

router.post('/webhook/github', async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = normalizeGitHub(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Invalid GitHub webhook payload. Ensure issue/PR body or messages are present.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    console.error('[Ingestion Critical Error (GitHub)]:', error);
    res.status(500).json({ error: 'Internal server error during GitHub ingestion.' });
  }
});

// ─── Linear Webhook ──────────────────────────────────────────

router.post('/webhook/linear', async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = normalizeLinear(req.body);
    if (!payload) {
      res.status(400).json({ error: 'Invalid Linear webhook payload. Ensure issue description or messages are present.' });
      return;
    }
    await processThread(payload, res);
  } catch (error) {
    console.error('[Ingestion Critical Error (Linear)]:', error);
    res.status(500).json({ error: 'Internal server error during Linear ingestion.' });
  }
});

export default router;