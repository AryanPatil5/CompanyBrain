import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { dispatchStepExecution } from './integrations/http_adapters.js';

export interface McpSessionContext {
  authenticated: boolean;
  agentId: string;
  workspaceId: string;
  trustRole: 'low_trust' | 'high_trust' | 'admin';
}

export interface GateCheckResult {
  gated: boolean;
  message?: string;
  riskLevel?: string;
  sopTitle?: string;
  approvalStatus?: string;
}

/**
 * Shared production gate check function used by get_sop_by_id, execute_sop_step, and guardrail test suites.
 */
export async function checkExecutionGate(
  sop: { id: string; title: string; risk_level?: string; requires_human_gate?: boolean },
  trustRole: 'low_trust' | 'high_trust' | 'admin',
  approvalId?: string
): Promise<GateCheckResult> {
  const isHighRisk = sop.risk_level === 'High' || sop.risk_level === 'Critical' || !!sop.requires_human_gate;

  if (isHighRisk && trustRole === 'low_trust') {
    if (!approvalId) {
      return {
        gated: true,
        riskLevel: sop.risk_level || 'High',
        sopTitle: sop.title,
        approvalStatus: 'unrequested',
        message: `HIGH/CRITICAL RISK GATE ENFORCED: Real-time human manager approval is required to execute SOP "${sop.title}". Pass a valid 'approval_id' from 'request_execution_approval' tool.`,
      };
    }

    const { data: gateReq } = await supabase
      .from('pending_approvals')
      .select('id, status, sop_id, consumed_at')
      .eq('id', approvalId)
      .single();

    if (!gateReq || gateReq.sop_id !== sop.id || gateReq.status !== 'approved' || gateReq.consumed_at !== null) {
      return {
        gated: true,
        riskLevel: sop.risk_level || 'High',
        sopTitle: sop.title,
        approvalStatus: gateReq ? (gateReq.consumed_at ? 'already_consumed' : gateReq.status) : 'unrequested',
        message: `HIGH/CRITICAL RISK GATE ENFORCED: Approval ticket #${approvalId} is invalid, unapproved, or has already been consumed. A fresh manager approval is required.`,
      };
    }
  }

  return { gated: false };
}

/**
 * Verifies a FastMCP token against public.agent_registry table.
 */
export async function authenticateMcpToken(token?: string): Promise<McpSessionContext> {
  const unauthenticated: McpSessionContext = {
    authenticated: false,
    agentId: 'unauthenticated',
    workspaceId: '00000000-0000-0000-0000-000000000000',
    trustRole: 'low_trust',
  };

  if (!token) return unauthenticated;

  const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
  if (!cleanToken) return unauthenticated;

  try {
    const { data } = await supabase
      .from('agent_registry')
      .select('agent_id, workspace_id, trust_role')
      .eq('token', cleanToken)
      .single();

    if (data) {
      return {
        authenticated: true,
        agentId: data.agent_id,
        workspaceId: data.workspace_id,
        trustRole: (data.trust_role as any) || 'low_trust',
      };
    }
  } catch {
    // Non-fatal query catch
  }

  // Fallback tokens strictly gated behind process.env.NODE_ENV !== 'production'
  if (process.env.NODE_ENV !== 'production') {
    if (cleanToken === 'mcp-admin-key-99') {
      return { authenticated: true, agentId: 'admin-worker-01', workspaceId: '00000000-0000-0000-0000-000000000000', trustRole: 'admin' };
    }
    if (cleanToken === 'mcp-hightrust-key-02') {
      return { authenticated: true, agentId: 'trusted-runner-02', workspaceId: '00000000-0000-0000-0000-000000000000', trustRole: 'high_trust' };
    }
    if (cleanToken === 'mcp-lowtrust-key-01') {
      return { authenticated: true, agentId: 'subagent-lowtrust', workspaceId: '00000000-0000-0000-0000-000000000000', trustRole: 'low_trust' };
    }
  }

  return unauthenticated;
}

const server = new FastMCP({
  name: 'Company Brain FastMCP',
  version: '2.5.0',
  authenticate: async (request: any): Promise<Record<string, unknown>> => {
    const authHeader = request.headers?.['authorization'] || request.headers?.['x-api-key'];
    const session = await authenticateMcpToken(authHeader);
    if (!session.authenticated) {
      throw new Error('Unauthorized: Invalid or missing FastMCP Bearer token / API key.');
    }
    return session as unknown as Record<string, unknown>;
  },
});

/**
 * Logs tool executions to execution_logs for observability
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

// ─── Tool 1: Get Approved SOP by ID (Authenticated Session) ───────────

server.addTool({
  name: 'get_sop_by_id',
  description: 'Retrieves the exact step-by-step operational procedure for a given SOP ID. Requires a valid FastMCP session token. Only returns approved SOPs. Enforces real-time human approval gates for High and Critical risk SOPs.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the approved SOP'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
  }),
  execute: async ({ sopId, mcpToken }) => {
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    const { data: sop, error } = await supabase
      .from('skills_sops')
      .select('id, title, category, trigger_condition, preconditions, execution_steps, version, is_stale, risk_level, requires_human_gate')
      .eq('id', sopId)
      .eq('status', 'Approved')
      .single();

    if (error || !sop) {
      await logExecution(sopId, 'get_sop_by_id', { sopId }, 'error', session.agentId);
      return JSON.stringify({ error: 'SOP not found or not yet approved by team leads.' });
    }

    // Call shared production checkExecutionGate function
    const gateRes = await checkExecutionGate(sop, session.trustRole);
    if (gateRes.gated) {
      await logExecution(sopId, 'get_sop_by_id', { sopId, blocked: true }, 'blocked_gated', session.agentId);
      return JSON.stringify({
        gated: true,
        risk_level: sop.risk_level,
        requires_human_gate: true,
        sop_title: sop.title,
        message: gateRes.message,
      });
    }

    await logExecution(sopId, 'get_sop_by_id', { sopId }, 'success', session.agentId);

    return JSON.stringify({
      gated: false,
      sop_id: sop.id,
      title: sop.title,
      category: sop.category,
      trigger_condition: sop.trigger_condition,
      preconditions: sop.preconditions,
      execution_steps: sop.execution_steps,
      version: sop.version,
      is_stale: sop.is_stale,
      risk_level: sop.risk_level,
    });
  },
});

// ─── Tool 2: Search Approved Operational SOPs ─────────────────

server.addTool({
  name: 'search_operational_sops',
  description: 'Searches Company Brain for approved operational procedures matching a category or keyword query.',
  parameters: z.object({
    query: z.string().optional().describe('Keyword search term to match against SOP title or trigger condition'),
    category: z.enum(['Engineering', 'Support', 'Billing', 'Operations', 'Security']).optional().describe('Category filter'),
    mcpToken: z.string().optional().describe('FastMCP API token'),
  }),
  execute: async ({ query, category, mcpToken }) => {
    if (mcpToken) {
      const session = await authenticateMcpToken(mcpToken);
      if (!session.authenticated) {
        return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
      }
    }

    let dbQuery = supabase
      .from('skills_sops')
      .select('id, title, category, trigger_condition, risk_level, version, is_stale')
      .eq('status', 'Approved');

    if (category) {
      dbQuery = dbQuery.eq('category', category);
    }

    const { data: sops, error } = await dbQuery;

    if (error) {
      return JSON.stringify({ error: 'Failed to query skills database.' });
    }

    let results = sops || [];

    if (query) {
      const qLower = query.toLowerCase();
      results = results.filter(
        (s) => s.title.toLowerCase().includes(qLower) || (s.trigger_condition || '').toLowerCase().includes(qLower)
      );
    }

    return JSON.stringify({
      count: results.length,
      sops: results,
    });
  },
});

// ─── Tool 3: Get SOP With Version History ─────────────────────

server.addTool({
  name: 'get_sop_with_history',
  description: 'Retrieves an approved SOP alongside its complete version evolution history and change reasons. Only returns approved SOPs.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the approved SOP'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
  }),
  execute: async ({ sopId, mcpToken }) => {
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    const { data: sop, error } = await supabase
      .from('skills_sops')
      .select('*')
      .eq('id', sopId)
      .eq('status', 'Approved')
      .single();

    if (error || !sop) {
      return JSON.stringify({ error: 'SOP not found or not yet approved by team leads.' });
    }

    const { data: versions } = await supabase
      .from('sop_versions')
      .select('version_number, changed_by, change_reason, created_at')
      .eq('sop_id', sopId)
      .order('version_number', { ascending: false });

    return JSON.stringify({
      sop,
      version_history: versions || [],
    });
  },
});

// ─── Tool 4: Request Execution Approval (Human-in-the-Loop Gating) ───

server.addTool({
  name: 'request_execution_approval',
  description: 'Submits a real-time human approval request ticket to the manager dashboard when an AI agent needs to execute a High or Critical risk SOP.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the High/Critical risk SOP'),
    reason: z.string().describe('Detailed context and reason why execution is required'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
    executionContext: z.record(z.any()).optional().describe('Input parameters or runtime variables for this execution'),
  }),
  execute: async ({ sopId, reason, mcpToken, executionContext }) => {
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    const { data: sop } = await supabase
      .from('skills_sops')
      .select('title, risk_level')
      .eq('id', sopId)
      .single();

    if (!sop) {
      return JSON.stringify({ error: 'SOP not found.' });
    }

    const { data: approval, error } = await supabase
      .from('pending_approvals')
      .insert({
        sop_id: sopId,
        agent_id: session.agentId,
        requested_by: 'mcp-agent',
        risk_level: sop.risk_level || 'High',
        status: 'pending',
        reason,
        execution_context: executionContext || {},
      })
      .select()
      .single();

    if (error) {
      return JSON.stringify({ error: 'Failed to create approval request ticket.' });
    }

    await logExecution(sopId, 'request_execution_approval', { approval_id: approval.id }, 'pending', session.agentId);

    return JSON.stringify({
      success: true,
      approval_id: approval.id,
      status: 'pending',
      message: `Execution ticket #${approval.id} submitted to manager approval queue for SOP "${sop.title}". Poll 'check_approval_status' tool to wait for manager approval.`,
    });
  },
});

// ─── Tool 5: Check Approval Status ───────────────────────────

server.addTool({
  name: 'check_approval_status',
  description: 'Checks the resolution status of a pending human manager approval ticket.',
  parameters: z.object({
    approvalId: z.string().uuid().describe('The UUID of the pending approval request'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
  }),
  execute: async ({ approvalId, mcpToken }) => {
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    const { data, error } = await supabase
      .from('pending_approvals')
      .select('id, status, reason, resolved_at, sop_id')
      .eq('id', approvalId)
      .single();

    if (error || !data) {
      return JSON.stringify({ error: 'Approval request ticket not found.' });
    }

    return JSON.stringify({
      approval_id: data.id,
      status: data.status,
      reason: data.reason,
      resolved_at: data.resolved_at,
    });
  },
});

// ─── Tool 6: Execute SOP Step (Authenticated & Role-Derived Execution Layer) ───

server.addTool({
  name: 'execute_sop_step',
  description: 'Executes a specific step of an approved SOP against target integration systems (Stripe, GitHub, Postgres, Slack, Admin CLI, Vault, Zendesk). Requires a valid FastMCP API token. Enforces human-in-the-loop approval gates for High/Critical risk SOPs.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the approved SOP'),
    stepNumber: z.number().describe('The step number to execute (1-indexed)'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
    approvalId: z.string().uuid().optional().describe('Required approval_id for High/Critical risk SOPs'),
    parameters: z.record(z.any()).optional().describe('Input parameters or thresholds for this step execution'),
  }),
  execute: async ({ sopId, stepNumber, mcpToken, approvalId, parameters }) => {
    // 1. Authenticate session token and derive role & workspace strictly on server
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    const callerId = session.agentId;
    const trustRole = session.trustRole;

    // 2. Fetch SOP and verify status is Approved
    const { data: sop, error: sopErr } = await supabase
      .from('skills_sops')
      .select('id, title, status, risk_level, requires_human_gate, execution_steps, workspace_id')
      .eq('id', sopId)
      .single();

    if (sopErr || !sop) {
      await logExecution(sopId, 'execute_sop_step', { stepNumber }, 'error', callerId);
      return JSON.stringify({ error: 'SOP not found.' });
    }

    if (sop.status !== 'Approved') {
      await logExecution(sopId, 'execute_sop_step', { stepNumber, status: sop.status }, 'rejected_unapproved', callerId);
      return JSON.stringify({ error: `SOP "${sop.title}" is in '${sop.status}' status. Only 'Approved' SOPs can be executed.` });
    }

    // 3. Call shared production checkExecutionGate function
    const gateRes = await checkExecutionGate(sop, trustRole, approvalId);
    if (gateRes.gated) {
      await logExecution(sopId, 'execute_sop_step', { stepNumber, blocked: true }, 'blocked_gated', callerId);
      return JSON.stringify({
        error: `HUMAN GATE REQUIRED: SOP "${sop.title}" requires human manager approval before step execution. Please submit an execution ticket using 'request_execution_approval'.`,
        approval_status: gateRes.approvalStatus,
        message: gateRes.message,
      });
    }

    // Gap D Fix: Claim approval ticket atomically BEFORE target system dispatch (prevents TOCTOU race window)
    if (approvalId) {
      const { data: claimedTicket, error: claimErr } = await supabase
        .from('pending_approvals')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', approvalId)
        .is('consumed_at', null)
        .select()
        .single();

      if (claimErr || !claimedTicket) {
        await logExecution(sopId, 'execute_sop_step', { stepNumber, blocked: true }, 'blocked_already_consumed', callerId);
        return JSON.stringify({
          error: `HUMAN GATE REQUIRED: Approval ticket #${approvalId} has already been claimed/consumed or is invalid. A fresh manager approval is required.`,
          approval_status: 'already_consumed',
        });
      }
    }

    // 4. Locate Step Definition
    const steps = Array.isArray(sop.execution_steps) ? sop.execution_steps : [];
    const stepDef = steps.find((s: any) => s.step_number === stepNumber) || steps[stepNumber - 1];

    if (!stepDef) {
      await logExecution(sopId, 'execute_sop_step', { stepNumber, total_steps: steps.length }, 'error', callerId);
      return JSON.stringify({ error: `Step ${stepNumber} not found in SOP execution steps.` });
    }

    const targetSystem = (stepDef.target_system || stepDef.target || 'admin_cli').toLowerCase();

    // 5. Look up target integration in `integration_connections` table
    const { data: conn } = await supabase
      .from('integration_connections')
      .select('integration_name, endpoint_config, credential_ref')
      .eq('integration_name', targetSystem)
      .limit(1)
      .single();

    const endpointConfig = conn?.endpoint_config || { base_url: `https://api.${targetSystem}.internal` };
    const credentialRef = conn?.credential_ref;

    // 6. Execute real HTTP step dispatch using http_adapters
    const httpRes = await dispatchStepExecution(
      targetSystem,
      endpointConfig,
      parameters || stepDef.parameters || {},
      credentialRef
    );

    const executionId = `exec_${Date.now()}_step_${stepNumber}`;
    const dispatchDetails = {
      action: stepDef.action || stepDef.instruction,
      target_system: targetSystem,
      http_status: httpRes.status_code,
      response_data: httpRes.response_data,
      dispatched_at: new Date().toISOString(),
    };

    const outcome = httpRes.success ? 'success' : 'error';

    // 7. Automatically log outcome to execution_logs
    await logExecution(sopId, 'execute_sop_step', { stepNumber, targetSystem, executionId, dispatchDetails, error: httpRes.error }, outcome, callerId);

    return JSON.stringify({
      success: httpRes.success,
      execution_id: executionId,
      sop_id: sopId,
      sop_title: sop.title,
      step_number: stepNumber,
      target_system: targetSystem,
      outcome,
      http_status: httpRes.status_code,
      dispatch_details: dispatchDetails,
      error: httpRes.error,
    });
  },
});

// ─── Tool 7: Log SOP Execution Outcome ──────────────────────

server.addTool({
  name: 'log_sop_execution',
  description: 'Reports the outcome after an AI agent has executed an SOP procedure. Requires valid FastMCP API token to prevent identity spoofing.',
  parameters: z.object({
    sopId: z.string().uuid().describe('The UUID of the SOP that was executed'),
    mcpToken: z.string().describe('Authenticated FastMCP API token'),
    outcome: z.enum(['success', 'partial', 'error']).describe('Result of the execution'),
    notes: z.string().optional().describe('Optional notes about the execution'),
    agentLabel: z.string().optional().describe('Optional display label or agent name'),
  }),
  execute: async ({ sopId, mcpToken, outcome, notes, agentLabel }) => {
    const session = await authenticateMcpToken(mcpToken);
    if (!session.authenticated) {
      return JSON.stringify({ error: 'Unauthorized: Invalid or missing FastMCP API token.' });
    }

    await logExecution(sopId, 'log_sop_execution', { notes, agent_label: agentLabel }, outcome, session.agentId);
    return JSON.stringify({ logged: true, sop_id: sopId, authenticated_agent_id: session.agentId, outcome });
  },
});

export function startMCPServer() {
  server.start({
    transportType: 'httpStream',
    httpStream: { port: 8080, endpoint: '/mcp' },
  });
  console.log('[INFO] Company Brain FastMCP Server v2.5 (Token Authentication & Role Binding Active) running on http://localhost:8080');
}