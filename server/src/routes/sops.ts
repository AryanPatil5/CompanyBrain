import { Router, Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { createVersion, confirmSOP, markStaleSOPs } from '../services/freshness.js';
import { authenticate, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { getTenantClient } from '../middleware/tenantClient.js';
import { hybridSearch } from '../services/retrieval/hybridSearch.js';
import { runWorkflow } from '../agents/orchestrator.js';
import { getConnectedEntities } from '../services/graph/graphService.js';
import { compileSopToAst, validateSopAst } from '../services/skills/sopCompiler.js';
import { discoverAndSynthesizeToolsFromSpec } from '../services/skills/openApiAutoDiscoverer.js';

const router = Router();

// Apply authentication middleware globally to all SOP routes
router.use(authenticate);

// ─── GET all SOPs ────────────────────────────────────────────

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const { category, status } = req.query;
    const client = getTenantClient(req);

    let query = client.from('skills_sops').select('*');

    // Scoped strictly by the authenticated user's workspace_id
    query = query.eq('workspace_id', workspaceId);
    
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

// ─── GET hybrid search (Reciprocal Rank Fusion RRF) ──────────

router.get('/search', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const query = (req.query.q || req.query.query || '').toString().trim();
    const limit = parseInt((req.query.limit || '10').toString(), 10);

    if (!query) {
      res.status(400).json({ error: 'Search query string "q" is required' });
      return;
    }

    const results = await hybridSearch({
      query,
      workspaceId: user.workspace_id,
      userId: user.user_id,
      role: user.role,
      limit,
    });

    res.json({ success: true, count: results.length, results });
  } catch (err) {
    console.error('[Hybrid Search Route Error]:', err);
    res.status(500).json({ error: 'Hybrid search execution failed' });
  }
});

// ─── GET Apache AGE Graph Entities & Edges ───────────────────

router.get('/graph', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    const { data: nodes } = await client.from('graph_nodes').select('*').eq('workspace_id', workspaceId).limit(50);
    const { data: edges } = await client.from('graph_edges').select('*').limit(100);

    res.json({
      success: true,
      nodes: nodes || [],
      edges: edges || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch graph data' });
  }
});

// ─── POST Multi-Agent Workflow Execution ──────────────────────

router.post('/workflow', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const { query, approval_id } = req.body;

    if (!query) {
      res.status(400).json({ error: 'Field "query" is required' });
      return;
    }

    const workflowResult = await runWorkflow(query, {
      workspaceId: user.workspace_id,
      userId: user.user_id,
      userRole: user.role,
      trustRole: user.role === 'admin' ? 'admin' : 'low_trust',
      approvalId: approval_id,
    });

    res.json(workflowResult);
  } catch (err) {
    console.error('[Workflow Execution Route Error]:', err);
    res.status(500).json({ error: 'Workflow execution failed' });
  }
});

// ─── GET pending agent approvals ─────────────────────────────

router.get('/approvals', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    // Scoped strictly by joined skills_sops workspace_id (using inner join syntax)
    const { data, error } = await client
      .from('pending_approvals')
      .select('*, skills_sops!inner(title, category, trigger_condition, execution_steps, workspace_id)')
      .eq('skills_sops.workspace_id', workspaceId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ approvals: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending approvals' });
  }
});

// ─── PATCH resolve approval (Approve or Reject) ──────────────

router.patch('/approvals/:approvalId', requireRole(['admin', 'approver']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { approvalId } = req.params;
    const { status, reason } = req.body; // 'approved' or 'rejected'
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    if (!['approved', 'rejected'].includes(status)) {
      res.status(400).json({ error: 'Status must be "approved" or "rejected"' });
      return;
    }

    // Verify ownership of the underlying SOP before modifying approval record via RLS-enforced client
    const { data: checkApproval, error: checkErr } = await client
      .from('pending_approvals')
      .select('*, skills_sops!inner(workspace_id)')
      .eq('id', approvalId)
      .single();

    if (checkErr || !checkApproval) {
      res.status(404).json({ error: 'Approval request not found' });
      return;
    }

    // TS helper to access nested joined table columns safely
    const joinedSop = checkApproval.skills_sops as any;
    if (joinedSop?.workspace_id !== workspaceId) {
      res.status(403).json({ error: 'Forbidden: approval request belongs to another workspace' });
      return;
    }

    const { data, error } = await client
      .from('pending_approvals')
      .update({
        status,
        reason: reason || `Resolved by manager`,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', approvalId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: `Agent execution ${status}`, approval: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve approval' });
  }
});

// ─── GET analytics ───────────────────────────────────────────

router.get('/analytics', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    const { data: sops, error: sopErr } = await client
      .from('skills_sops')
      .select('id, title, status, category, is_stale, risk_level')
      .eq('workspace_id', workspaceId);

    if (sopErr) {
      res.status(500).json({ error: sopErr.message });
      return;
    }

    const allSops = sops || [];
    const total = allSops.length;

    const byStatus: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    const byRisk: Record<string, number> = {};
    let staleCount = 0;

    for (const s of allSops) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
      byCategory[s.category] = (byCategory[s.category] || 0) + 1;
      byRisk[s.risk_level || 'Low'] = (byRisk[s.risk_level || 'Low'] || 0) + 1;
      if (s.is_stale) staleCount++;
    }

    // Pending agent execution approvals count for this workspace
    const { count: pendingApprovalsCount } = await client
      .from('pending_approvals')
      .select('id, skills_sops!inner(workspace_id)', { count: 'exact', head: true })
      .eq('skills_sops.workspace_id', workspaceId)
      .eq('status', 'pending');

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    // Scoped execution logs matching workspace_id
    const { count: recentExecutions } = await client
      .from('execution_logs')
      .select('id, skills_sops!inner(workspace_id)', { count: 'exact', head: true })
      .eq('skills_sops.workspace_id', workspaceId)
      .gte('created_at', weekAgo.toISOString());

    const { data: threads } = await client
      .from('raw_threads')
      .select('source')
      .eq('workspace_id', workspaceId);

    const bySources: Record<string, number> = {};
    for (const t of threads || []) {
      bySources[t.source] = (bySources[t.source] || 0) + 1;
    }

    res.json({
      total_sops: total,
      by_status: byStatus,
      by_category: byCategory,
      by_risk: byRisk,
      stale_count: staleCount,
      pending_approvals_count: pendingApprovalsCount || 0,
      recent_executions: recentExecutions || 0,
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
    const { title, category, trigger_condition, preconditions, execution_steps, status, risk_level, requires_human_gate } = req.body;
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    // Check if the SOP belongs to the user's workspace
    const { data: checkSop } = await client
      .from('skills_sops')
      .select('workspace_id')
      .eq('id', id)
      .single();

    if (!checkSop) {
      res.status(404).json({ error: 'SOP not found' });
      return;
    }

    if (checkSop.workspace_id !== workspaceId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const isApproval = status === 'Approved';

    // Restrict approval status updates to admin and approver roles
    if (isApproval && !['admin', 'approver'].includes(user.role)) {
      res.status(403).json({ error: 'Forbidden: only admins or approvers can approve SOPs' });
      return;
    }

    await createVersion(id, 'user', isApproval ? 'approval' : 'manual_edit');

    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() };
    if (title !== undefined) updatePayload.title = title;
    if (category !== undefined) updatePayload.category = category;
    if (trigger_condition !== undefined) updatePayload.trigger_condition = trigger_condition;
    if (preconditions !== undefined) updatePayload.preconditions = preconditions;
    if (execution_steps !== undefined) updatePayload.execution_steps = execution_steps;
    if (status !== undefined) updatePayload.status = status;
    if (risk_level !== undefined) updatePayload.risk_level = risk_level;
    if (requires_human_gate !== undefined) updatePayload.requires_human_gate = requires_human_gate;

    if (isApproval) {
      updatePayload.last_confirmed_at = new Date().toISOString();
      updatePayload.is_stale = false;
    }

    const { data, error } = await client
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
    const { id } = req.params;
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    // Check if the SOP belongs to the user's workspace
    const { data: checkSop } = await client
      .from('skills_sops')
      .select('workspace_id')
      .eq('id', id)
      .single();

    if (!checkSop) {
      res.status(404).json({ error: 'SOP not found' });
      return;
    }

    if (checkSop.workspace_id !== workspaceId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const success = await confirmSOP(id);
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
    const { id } = req.params;
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    // Check if the SOP belongs to the user's workspace
    const { data: checkSop } = await client
      .from('skills_sops')
      .select('workspace_id')
      .eq('id', id)
      .single();

    if (!checkSop) {
      res.status(404).json({ error: 'SOP not found' });
      return;
    }

    if (checkSop.workspace_id !== workspaceId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { data, error } = await client
      .from('sop_versions')
      .select('*')
      .eq('sop_id', id)
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

// ─── DELETE SOP ──────────────────────────────────────────────

router.delete('/:id', requireRole(['admin', 'approver']), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id;
    const client = getTenantClient(req);

    // Check if the SOP belongs to the user's workspace
    const { data: checkSop } = await client
      .from('skills_sops')
      .select('workspace_id')
      .eq('id', id)
      .single();

    if (!checkSop) {
      res.status(404).json({ error: 'SOP not found' });
      return;
    }

    if (checkSop.workspace_id !== workspaceId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { error } = await client
      .from('skills_sops')
      .delete()
      .eq('id', id);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.json({ message: 'SOP deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete SOP' });
  }
});

// ─── POST Compile SOP Markdown to AST ──────────────────────────

router.post('/compile', async (req: Request, res: Response): Promise<void> => {
  try {
    const { markdownText, title } = req.body;
    if (!markdownText || typeof markdownText !== 'string') {
      res.status(400).json({ error: 'Body parameter "markdownText" is required.' });
      return;
    }

    const ast = await compileSopToAst(markdownText, { title });
    const validation = validateSopAst(ast);

    res.json({
      success: validation.valid,
      ast,
      validation,
    });
  } catch (err: any) {
    res.status(500).json({ error: `SOP compilation failed: ${err.message}` });
  }
});

router.post('/auto-discover-tools', async (req: Request, res: Response): Promise<void> => {
  try {
    const user = (req as AuthenticatedRequest).user!;
    const workspaceId = user.workspace_id || '00000000-0000-0000-0000-000000000000';
    const { specUrl, specJson } = req.body;

    if (!specUrl && !specJson) {
      res.status(400).json({ error: 'Either "specUrl" or "specJson" is required.' });
      return;
    }

    const result = await discoverAndSynthesizeToolsFromSpec(specUrl || specJson, workspaceId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: `Tool auto-discovery failed: ${err.message}` });
  }
});

export default router;