import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { createVersion, confirmSOP, markStaleSOPs } from '../services/freshness.js';

const router = Router();

// ─── GET all SOPs ────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { workspace_id, category, status } = req.query;

    let query = supabase.from('skills_sops').select('*');

    if (workspace_id) query = query.eq('workspace_id', workspace_id as string);
    if (category) query = query.eq('category', category as string);
    if (status) query = query.eq('status', status as string);

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ sops: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch SOPs' });
  }
});

// ─── GET analytics ───────────────────────────────────────────

router.get('/analytics', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Fetch all SOPs
    const { data: sops, error: sopErr } = await supabase
      .from('skills_sops')
      .select('id, title, status, category, is_stale');

    if (sopErr) {
      res.status(500).json({ error: sopErr.message });
      return;
    }

    const allSops = sops || [];
    const total = allSops.length;

    // Count by status
    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    let staleCount = 0;

    for (const s of allSops) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      if (s.is_stale) staleCount++;
    }

    // Recent execution count (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const { count: recentExecutions } = await supabase
      .from('execution_logs')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', weekAgo.toISOString());

    // Top executed SOPs (last 30 days)
    const monthAgo = new Date();
    monthAgo.setDate(monthAgo.getDate() - 30);

    const { data: logs } = await supabase
      .from('execution_logs')
      .select('sop_id')
      .gte('created_at', monthAgo.toISOString());

    const execCounts: Record<string, number> = {};
    for (const log of logs || []) {
      if (log.sop_id) {
        execCounts[log.sop_id] = (execCounts[log.sop_id] || 0) + 1;
      }
    }

    const topExecuted = Object.entries(execCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([sop_id, count]) => {
        const sop = allSops.find((s) => s.id === sop_id);
        return { sop_id, title: sop?.title || 'Unknown', count };
      });

    // Source breakdown from raw_threads
    const { data: threads } = await supabase
      .from('raw_threads')
      .select('source');

    const bySources: Record<string, number> = {};
    for (const t of threads || []) {
      bySources[t.source] = (bySources[t.source] || 0) + 1;
    }

    res.json({
      total_sops: total,
      by_status: byStatus,
      by_category: byCategory,
      stale_count: staleCount,
      recent_executions: recentExecutions || 0,
      top_executed: topExecuted,
      sources_ingested: bySources,
    });
  } catch (err) {
    console.error('[Analytics Error]:', err);
    res.status(500).json({ error: 'Failed to compute analytics' });
  }
});

// ─── PATCH update SOP (with versioning) ──────────────────────

router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { title, category, trigger_condition, preconditions, execution_steps, status } = req.body;

    // Create a version snapshot before modifying
    const isApproval = status === 'Approved';
    await createVersion(id, 'user', isApproval ? 'approval' : 'manual_edit');

    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updatePayload.title = title;
    if (category !== undefined) updatePayload.category = category;
    if (trigger_condition !== undefined) updatePayload.trigger_condition = trigger_condition;
    if (preconditions !== undefined) updatePayload.preconditions = preconditions;
    if (execution_steps !== undefined) updatePayload.execution_steps = execution_steps;
    if (status !== undefined) updatePayload.status = status;

    // Approving also confirms freshness
    if (isApproval) {
      updatePayload.last_confirmed_at = new Date().toISOString();
      updatePayload.is_stale = false;
    }

    const { data, error } = await supabase
      .from('skills_sops')
      .update(updatePayload)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: 'SOP updated successfully', sop: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update SOP' });
  }
});

// ─── POST confirm SOP is current ─────────────────────────────

router.post('/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  try {
    const success = await confirmSOP(req.params.id);
    if (!success) {
      res.status(500).json({ error: 'Failed to confirm SOP' });
      return;
    }
    res.json({ message: 'SOP confirmed as current.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to confirm SOP' });
  }
});

// ─── GET version history ─────────────────────────────────────

router.get('/:id/versions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await supabase
      .from('sop_versions')
      .select('*')
      .eq('sop_id', req.params.id)
      .order('version_number', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ versions: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch version history' });
  }
});

// ─── POST staleness sweep ────────────────────────────────────

router.post('/check-staleness', async (req: Request, res: Response): Promise<void> => {
  try {
    const thresholdDays = parseInt(req.query.days as string) || 30;
    const count = await markStaleSOPs(thresholdDays);
    res.json({ message: `Staleness sweep complete. ${count} SOPs marked stale.`, stale_count: count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to run staleness sweep' });
  }
});

export default router;