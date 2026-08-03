import { supabase } from '../config/supabase.js';
import { dispatchStepExecution } from '../services/integrations/http_adapters.js';
import { ExecutionPlan, ExecutedStepResult, WorkflowContext } from './types.js';

/**
 * Executor Agent: Sequential runner executing approved steps, resolving variable outputs, and recording execution logs.
 */
export async function executePlan(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<ExecutedStepResult[]> {
  const results: ExecutedStepResult[] = [];
  const stepOutputs: Record<string, any> = {};

  for (const step of plan.steps) {
    console.log(`[Executor Agent] Running Step ${step.step_number} (${step.action}) on ${step.target_system}...`);

    // 1. Resolve variable dependencies from previous step outputs (e.g. $step_1.output)
    const resolvedParams: Record<string, any> = { ...step.parameters };
    for (const [key, val] of Object.entries(resolvedParams)) {
      if (typeof val === 'string' && val.startsWith('$step_')) {
        const parts = val.split('.');
        const parentStepId = parts[0].replace('$', '');
        const parentOutput = stepOutputs[parentStepId];
        if (parentOutput) {
          resolvedParams[key] = parentOutput;
        }
      }
    }

    const targetSystem = (step.target_system || 'Slack').toLowerCase();
    const endpointConfig = { base_url: `https://api.${targetSystem}.internal` };

    // 2. Dispatch real HTTP execution via integration adapters
    const httpRes = await dispatchStepExecution(
      targetSystem,
      endpointConfig,
      resolvedParams,
      undefined
    );

    const stepResult: ExecutedStepResult = {
      step_id: step.id,
      step_number: step.step_number,
      action: step.action,
      target_system: step.target_system,
      tool_name: step.tool_name,
      outcome: httpRes.success ? 'success' : 'error',
      http_status: httpRes.status_code,
      response_data: httpRes.response_data,
      error: httpRes.error,
    };

    results.push(stepResult);
    stepOutputs[step.id] = httpRes.response_data;

    // 3. Log execution lifecycle to Supabase execution_logs audit table
    try {
      await supabase.from('execution_logs').insert({
        sop_id: plan.sop_id || null,
        agent_id: context.userId || 'mcp-agent',
        tool_name: step.tool_name || 'execute_sop_step',
        input_params: { step_number: step.step_number, target_system: step.target_system, resolvedParams },
        outcome: stepResult.outcome,
      });
    } catch (logErr) {
      console.warn('[Executor Warning] Failed to log step execution:', logErr);
    }

    if (!httpRes.success) {
      console.error(`[Executor Agent] Step ${step.step_number} failed. Halting workflow execution.`);
      break;
    }
  }

  return results;
}
