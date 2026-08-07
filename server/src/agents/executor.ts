import { logger } from '../logger.js';
import { supabase } from '../config/supabase.js';
import { dispatchStepExecution } from '../services/integrations/http_adapters.js';
import { ExecutionPlan, ExecutedStepResult, WorkflowContext } from './types.js';
import { verifyAnswerGrounding } from '../services/retrieval/groundingGuardrail.js';
import { selfHealAndRetryCode } from '../services/skills/toolSelfHealer.js';

/**
 * Executor Agent: Sequential runner executing approved steps, resolving variable outputs,
 * enforcing output grounding, and performing self-healing sandbox retries on failure.
 */
export async function executePlan(
  plan: ExecutionPlan,
  context: WorkflowContext
): Promise<ExecutedStepResult[]> {
  const results: ExecutedStepResult[] = [];
  const stepOutputs: Record<string, any> = {};

  for (const step of plan.steps) {
    logger.info(`[Executor Agent] Running Step ${step.step_number} (${step.action}) on ${step.target_system}...`);

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

    // 2. Dispatch HTTP execution via integration adapters
    let httpRes = await dispatchStepExecution(
      targetSystem,
      endpointConfig,
      resolvedParams,
      undefined
    );

    // 3. Self-healing Retry Engine: If execution failed, attempt automatic code/parameter repair up to 3 times
    if (!httpRes.success && step.parameters?.code) {
      logger.warn(`[Executor Agent] Step ${step.step_number} failed. Triggering ToolSelfHealer sandbox recovery...`);
      const healResult = await selfHealAndRetryCode(step.parameters.code, {}, 3);
      if (healResult.success) {
        httpRes = {
          success: true,
          status_code: 200,
          response_data: healResult.output || { message: healResult.stdout || 'Self-healed execution succeeded.' },
        };
        logger.info(`[Executor Agent] Step ${step.step_number} self-healed successfully after ${healResult.attemptsUsed} attempts.`);
      }
    }

    // 4. Grounding Guardrail Check: Verify output claims are grounded in source SOP context
    let finalResponseData = httpRes.response_data;
    if (httpRes.response_data && typeof httpRes.response_data === 'object' && httpRes.response_data.message) {
      const grounding = await verifyAnswerGrounding(httpRes.response_data.message, [
        { title: plan.sop_title, content: plan.user_query },
      ]);
      if (!grounding.grounded) {
        logger.warn(`[Executor Warning] Step ${step.step_number} output flagged by Grounding Guardrail:`, grounding.hallucinatedClaims);
        finalResponseData = {
          ...httpRes.response_data,
          warning: 'Ungrounded claims intercepted by Grounding Guardrail.',
          grounding_sanitized: grounding.sanitizedResponse,
        };
      }
    }

    const stepResult: ExecutedStepResult = {
      step_id: step.id,
      step_number: step.step_number,
      action: step.action,
      target_system: step.target_system,
      tool_name: step.tool_name,
      outcome: httpRes.success ? 'success' : 'error',
      http_status: httpRes.status_code,
      response_data: finalResponseData,
      error: httpRes.error,
    };

    results.push(stepResult);
    stepOutputs[step.id] = finalResponseData;

    // 5. Log execution lifecycle to Supabase execution_logs audit table
    try {
      await supabase.from('execution_logs').insert({
        sop_id: plan.sop_id || null,
        agent_id: context.userId || 'mcp-agent',
        tool_name: step.tool_name || 'execute_sop_step',
        input_params: { step_number: step.step_number, target_system: step.target_system, resolvedParams },
        outcome: stepResult.outcome,
      });
    } catch (logErr) {
      logger.warn('[Executor Warning] Failed to log step execution:', logErr);
    }

    if (!httpRes.success) {
      logger.error(`[Executor Agent] Step ${step.step_number} failed after self-healing attempts. Halting workflow execution.`);
      break;
    }
  }

  return results;
}
