import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';

const server = new FastMCP({
  name: 'Company Brain FastMCP',
  version: '2.5.0',
});

async function logExecution(
  sopId: string | null,
  toolName: string,
  inputParams: Record<string, any>,
  outcome: string = 'success',
  agentId: string = 'mcp-agent'
) {
  try {
    await supabase.from('execution_logs').insert({
      sop_id: sopId,
      agent_id: agentId,
      tool_name: toolName,
      input_params: inputParams,
      outcome,
    });
  } catch (err) {
    console.warn('[MCP] Failed to log execution:', err);
  }
}

// ─── Tool 1: Get Approved SOP by ID (with Real-Time Execution Guardrails) ──────────

server.addTool({
  name: 'get_sop_by_id',
  description: 'Retrieves the exact step-by-step operational procedure for a given SOP ID. Only returns approved SOPs. Enforces real-time human approval gates for High and Critical risk SOPs.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the approved SOP'),
    agentId: z.string().optional().describe('Identifier for the agent calling this tool'),
    agentTrustRole: z.enum(['low_trust', 'high_trust', 'admin']).optional().describe('Trust tier of the requesting agent (default: low_trust)'),
  }),
  execute: async ({ sopId, agentId, agentTrustRole }) => {
    const trustRole = agentTrustRole || 'low_trust';
    const callerId = agentId || 'autonomous-agent';

    const { data: sop, error } = await supabase
      .from('skills_sops')
      .select('id, title, category, trigger_condition, preconditions, execution_steps, version, is_stale, risk_level, requires_human_gate')
      .eq('id', sopId)
      .eq('status', 'Approved')
      .single();

    if (error || !sop) {
      await logExecution(sopId, 'get_sop_by_id', { sopId }, 'error', callerId);
      return JSON.stringify({ error: 'SOP not found or not yet approved by team leads.' });
    }

    // Real-Time Execution Guardrail & Human Gate Enforcer
    const isHighRisk = sop.risk_level === 'High' || sop.risk_level === 'Critical' || sop.requires_human_gate;

    if (isHighRisk && trustRole === 'low_trust') {
      // Check if an existing approval exists and is approved
      const { data: existingApproval } = await supabase
        .from('pending_approvals')
        .select('*')
        .eq('sop_id', sopId)
        .eq('agent_id', callerId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!existingApproval || existingApproval.status === 'pending') {
        // Create pending approval request if not present
        if (!existingApproval) {
          await supabase.from('pending_approvals').insert({
            sop_id: sopId,
            agent_id: callerId,
            requested_by: callerId,
            risk_level: sop.risk_level || 'High',
            status: 'pending',
            reason: `Agent requested High-Risk SOP: "${sop.title}"`,
            execution_context: { sop_title: sop.title, steps_count: sop.execution_steps?.length },
          });
        }

        await logExecution(sopId, 'get_sop_by_id', { sopId, gated: true }, 'gate_required', callerId);

        return JSON.stringify({
          status: 'GATE_REQUIRED',
          risk_level: sop.risk_level,
          requires_human_approval: true,
          sop_title: sop.title,
          message: `SECURITY GUARDRAIL TRIGGERED: This SOP is rated "${sop.risk_level}" risk and requires human approval before execution. Request has been submitted to the manager queue. Call 'check_approval_status' with sopId: "${sopId}".`,
          approval_status: 'pending',
        }, null, 2);
      }

      if (existingApproval.status === 'rejected') {
        await logExecution(sopId, 'get_sop_by_id', { sopId, gated: true }, 'gate_rejected', callerId);
        return JSON.stringify({
          status: 'GATE_REJECTED',
          message: `EXECUTION DENIED: Manager rejected execution request for SOP "${sop.title}". Reason: ${existingApproval.reason || 'Safety policy restriction.'}`,
        });
      }
    }

    await logExecution(sopId, 'get_sop_by_id', { sopId }, 'success', callerId);
    return JSON.stringify(sop, null, 2);
  },
});

// ─── Tool 2: Search Operating Procedures ─────────────────────

server.addTool({
  name: 'search_operational_sops',
  description: 'Searches Company Brain for approved procedures related to support, engineering, or billing tasks.',
  parameters: z.object({
    category: z.enum(['Engineering', 'Support', 'Billing', 'Operations', 'Security']).optional(),
    keyword: z.string().describe('Keyword or scenario to search for (e.g. "rate limit", "refund")'),
    agentId: z.string().optional().describe('Identifier for the agent calling this tool'),
  }),
  execute: async ({ category, keyword, agentId }) => {
    let query = supabase
      .from('skills_sops')
      .select('id, title, category, trigger_condition, version, is_stale, risk_level, requires_human_gate')
      .eq('status', 'Approved')
      .ilike('title', `%${keyword}%`);

    if (category) {
      query = query.eq('category', category);
    }

    const { data, error } = await query.limit(5);

    if (error) {
      await logExecution(null, 'search_operational_sops', { category, keyword }, 'error', agentId);
      return JSON.stringify({ error: 'Failed to search skills library.' });
    }

    await logExecution(null, 'search_operational_sops', { category, keyword }, 'success', agentId);
    return JSON.stringify({ matches: data });
  },
});

// ─── Tool 3: Request Execution Approval ──────────────────────

server.addTool({
  name: 'request_execution_approval',
  description: 'Submits a real-time execution approval request to human managers for a High/Critical risk SOP.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the High-Risk SOP'),
    agentId: z.string().describe('Identifier for the requesting agent'),
    reason: z.string().describe('Reason or context for requesting execution'),
  }),
  execute: async ({ sopId, agentId, reason }) => {
    const { data: sop } = await supabase.from('skills_sops').select('title, risk_level').eq('id', sopId).single();

    const { data, error } = await supabase.from('pending_approvals').insert({
      sop_id: sopId,
      agent_id: agentId,
      requested_by: agentId,
      risk_level: sop?.risk_level || 'High',
      status: 'pending',
      reason,
      execution_context: { sop_title: sop?.title },
    }).select().single();

    if (error) {
      return JSON.stringify({ error: 'Failed to submit approval request.' });
    }

    return JSON.stringify({
      message: 'Approval request queued for human review.',
      approval_id: data.id,
      status: 'pending',
    });
  },
});

// ─── Tool 4: Check Execution Approval Status ─────────────────

server.addTool({
  name: 'check_approval_status',
  description: 'Checks if a human manager has approved an execution request for a High-Risk SOP.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the SOP'),
    agentId: z.string().describe('Identifier for the requesting agent'),
  }),
  execute: async ({ sopId, agentId }) => {
    const { data, error } = await supabase
      .from('pending_approvals')
      .select('*')
      .eq('sop_id', sopId)
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return JSON.stringify({ status: 'not_found', message: 'No approval request found for this SOP/agent combination.' });
    }

    return JSON.stringify({
      approval_id: data.id,
      status: data.status, // 'pending', 'approved', 'rejected'
      reason: data.reason,
      resolved_at: data.resolved_at,
    });
  },
});

// ─── Tool 5: Log SOP Execution Outcome ──────────────────────

server.addTool({
  name: 'log_sop_execution',
  description: 'Reports the outcome after an AI agent has executed an SOP procedure. Use this to track execution outcomes and reliability.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the SOP that was executed'),
    agentId: z.string().describe('Identifier for the agent that executed the SOP'),
    outcome: z.enum(['success', 'partial', 'error']).describe('Result of the execution'),
    notes: z.string().optional().describe('Optional notes about the execution'),
  }),
  execute: async ({ sopId, agentId, outcome, notes }) => {
    await logExecution(sopId, 'log_sop_execution', { notes }, outcome, agentId);
    return JSON.stringify({ logged: true, sop_id: sopId, outcome });
  },
});

export function startMCPServer() {
  server.start({
    transportType: 'httpStream',
    httpStream: { port: 8080, endpoint: '/mcp' },
  });
  console.log('[INFO] Company Brain FastMCP Server v2.5 (Guardrails Enabled) running on http://localhost:8080');
}