import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';

const server = new FastMCP({
  name: 'Company Brain FastMCP',
  version: '2.0.0',
});

/**
 * Logs an MCP tool execution for observability.
 */
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

// ─── Tool 1: Get Approved SOP by ID ─────────────────────────

server.addTool({
  name: 'get_sop_by_id',
  description: 'Retrieves the exact step-by-step operational procedure for a given SOP ID. Only returns approved SOPs.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the approved SOP'),
    agentId: z.string().optional().describe('Identifier for the agent calling this tool'),
  }),
  execute: async ({ sopId, agentId }) => {
    const { data, error } = await supabase
      .from('skills_sops')
      .select('id, title, category, trigger_condition, preconditions, execution_steps, version, is_stale')
      .eq('id', sopId)
      .eq('status', 'Approved')
      .single();

    if (error || !data) {
      await logExecution(sopId, 'get_sop_by_id', { sopId }, 'error', agentId);
      return JSON.stringify({ error: 'SOP not found or not yet approved by team leads.' });
    }

    await logExecution(sopId, 'get_sop_by_id', { sopId }, 'success', agentId);
    return JSON.stringify(data, null, 2);
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
      .select('id, title, category, trigger_condition, version, is_stale')
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

// ─── Tool 3: Log SOP Execution Outcome ──────────────────────

server.addTool({
  name: 'log_sop_execution',
  description: 'Reports the outcome after an AI agent has executed an SOP procedure. Use this to track which SOPs are being used and their success rates.',
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

// ─── Tool 4: Get SOP with Version History ────────────────────

server.addTool({
  name: 'get_sop_with_history',
  description: 'Retrieves an approved SOP along with its version history, useful for understanding how a procedure evolved.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the SOP'),
    agentId: z.string().optional().describe('Identifier for the agent calling this tool'),
  }),
  execute: async ({ sopId, agentId }) => {
    const { data: sop, error: sopErr } = await supabase
      .from('skills_sops')
      .select('*')
      .eq('id', sopId)
      .eq('status', 'Approved')
      .single();

    if (sopErr || !sop) {
      await logExecution(sopId, 'get_sop_with_history', { sopId }, 'error', agentId);
      return JSON.stringify({ error: 'SOP not found or not yet approved.' });
    }

    const { data: versions } = await supabase
      .from('sop_versions')
      .select('version_number, changed_by, change_reason, created_at')
      .eq('sop_id', sopId)
      .order('version_number', { ascending: false })
      .limit(10);

    await logExecution(sopId, 'get_sop_with_history', { sopId }, 'success', agentId);

    return JSON.stringify({
      sop,
      version_history: versions || [],
    }, null, 2);
  },
});

export function startMCPServer() {
  server.start({
    transportType: 'httpStream',
    httpStream: { port: 8080, endpoint: '/mcp' },
  });
  console.log('🤖 Company Brain FastMCP Server v2.0 running on http://localhost:8080');
}