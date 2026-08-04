import { generateText } from '../services/aiProvider.js';
import { hybridSearch } from '../services/retrieval/hybridSearch.js';
import { getConnectedEntities } from '../services/graph/graphService.js';
import { ExecutionPlan, PlanStep, WorkflowContext } from './types.js';

/**
 * Planner Agent: Decomposes user request + GraphRAG context into a structured DAG ExecutionPlan.
 */
export async function generatePlan(
  userQuery: string,
  context: WorkflowContext
): Promise<ExecutionPlan> {
  const planId = `plan_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const workspaceId = context.workspaceId || '00000000-0000-0000-0000-000000000000';
  const userId = context.userId || 'system';
  const userRole = context.userRole || 'member';

  // 1. Fetch Hybrid Search RRF Context
  const hybridMatches = await hybridSearch({
    query: userQuery,
    workspaceId,
    userId,
    role: userRole,
    limit: 3,
  });

  const matchingSop = hybridMatches[0];

  // 2. Fetch GraphRAG Connected Entities
  let graphContext = '';
  if (matchingSop?.id) {
    const connected = await getConnectedEntities(matchingSop.id, 2);
    graphContext = connected.map((c) => `(${c.relationship}) -> ${c.node.name} [${c.node.label}]`).join(', ');
  }

  // 3. System Prompt for Planner
  const SYSTEM_PROMPT = `
You are the Lead AI Planner Agent in an Enterprise Autonomous Execution Engine.
Your task is to decompose a user query into a structured, sequential Directed Acyclic Graph (DAG) plan of execution steps.

Target Systems Available: Stripe, Slack, Postgres, GitHub, Linear, Zendesk, Vault, Admin CLI.

Format output strictly as raw JSON matching this schema:
{
  "sop_title": "string or null",
  "steps": [
    {
      "id": "step_1",
      "step_number": 1,
      "action": "action description",
      "target_system": "Stripe",
      "tool_name": "execute_sop_step",
      "parameters": { "param_name": "value" },
      "depends_on": [],
      "risk_level": "Low" | "Medium" | "High" | "Critical",
      "requires_human_gate": boolean
    }
  ]
}
Do NOT wrap output in markdown code blocks.
`;

  const userPrompt = `User Query: "${userQuery}"
Matching SOP Title: "${matchingSop?.title || 'None'}"
Trigger Condition: "${matchingSop?.trigger_condition || 'None'}"
GraphRAG Context: "${graphContext || 'None'}"

Generate the DAG ExecutionPlan:`;

  let rawOutput = '';
  try {
    rawOutput = await generateText(userPrompt, SYSTEM_PROMPT);
  } catch {
    // Fallback if AI provider is offline
  }

  let parsed: any = null;
  if (rawOutput) {
    const cleanJson = rawOutput.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    try {
      parsed = JSON.parse(cleanJson);
    } catch {
      // JSON parse error catch
    }
  }

  // Build fallback plan if LLM parsing was unsuccessful or offline
  const steps: PlanStep[] = (parsed?.steps && Array.isArray(parsed.steps) && parsed.steps.length > 0)
    ? parsed.steps.map((s: any, idx: number) => ({
        id: s.id || `step_${idx + 1}`,
        step_number: s.step_number || idx + 1,
        action: s.action || `Execute step ${idx + 1}`,
        target_system: s.target_system || 'Slack',
        tool_name: s.tool_name || 'execute_sop_step',
        parameters: s.parameters || {},
        depends_on: Array.isArray(s.depends_on) ? s.depends_on : [],
        risk_level: s.risk_level || (userQuery.toLowerCase().includes('refund') || userQuery.toLowerCase().includes('delete') ? 'High' : 'Low'),
        requires_human_gate: s.requires_human_gate || false,
      }))
    : [
        {
          id: 'step_1',
          step_number: 1,
          action: matchingSop ? `Execute triage for "${matchingSop.title}"` : `Process query "${userQuery}"`,
          target_system: matchingSop?.category === 'Billing' ? 'Stripe' : 'Slack',
          tool_name: 'execute_sop_step',
          parameters: { query: userQuery },
          depends_on: [],
          risk_level: (userQuery.toLowerCase().includes('refund') || userQuery.toLowerCase().includes('delete') || matchingSop?.requires_human_gate) ? 'High' : 'Low',
          requires_human_gate: matchingSop?.requires_human_gate || false,
        },
      ];

  return {
    id: planId,
    user_query: userQuery,
    workspace_id: workspaceId,
    steps,
    sop_id: matchingSop?.id,
    sop_title: matchingSop?.title || parsed?.sop_title || 'Autonomous Action Plan',
    created_at: new Date().toISOString(),
  };
}
