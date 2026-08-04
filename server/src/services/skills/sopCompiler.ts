import { generateText } from '../aiProvider.js';
import { SopAST, SopASTInput, SopASTStep } from './sopTypes.js';

/**
 * Validates a compiled SopAST object for required structural fields.
 */
export function validateSopAst(ast: SopAST): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!ast.id) errors.push('AST missing required property "id".');
  if (!ast.title) errors.push('AST missing required property "title".');
  if (!ast.triggerCondition) errors.push('AST missing required property "triggerCondition".');
  if (!Array.isArray(ast.steps) || ast.steps.length === 0) {
    errors.push('AST must contain at least one step in "steps" array.');
  } else {
    ast.steps.forEach((step, idx) => {
      if (typeof step.stepNumber !== 'number') errors.push(`Step at index ${idx} missing "stepNumber".`);
      if (!step.action) errors.push(`Step ${step.stepNumber || idx} missing "action" description.`);
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Automated SOP Compiler
 * Parses raw Markdown / unstructured SOP text into a structured, executable AST (Abstract Syntax Tree)
 * with decision branches, parameter inputs, and target API system tools.
 */
export async function compileSopToAst(
  markdownText: string,
  options?: { sopId?: string; title?: string }
): Promise<SopAST> {
  const sopId = options?.sopId || `sop_ast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const cleanMd = markdownText.trim();

  // 1. Rule-based title extraction
  const titleMatch = cleanMd.match(/^#\s+(.+)$/m);
  const title = options?.title || (titleMatch ? titleMatch[1].trim() : 'Automated Enterprise SOP');

  // 2. Rule-based trigger condition extraction
  const triggerMatch = cleanMd.match(/(?:trigger|when|condition):\s*(.+)$/im);
  const triggerCondition = triggerMatch ? triggerMatch[1].trim() : `Execute ${title} procedure`;

  // 3. Extract inputs
  const requiredInputs: SopASTInput[] = [];
  const inputMatches = cleanMd.matchAll(/-\s*([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z]+)\s*\(([^)]+)\)/g);
  for (const match of inputMatches) {
    requiredInputs.push({
      name: match[1].trim(),
      type: match[2].trim(),
      description: match[3].trim(),
      required: true,
    });
  }

  if (requiredInputs.length === 0) {
    requiredInputs.push({
      name: 'ticket_id',
      type: 'string',
      description: 'System operational ticket ID',
      required: true,
    });
  }

  // 4. Extract steps
  const steps: SopASTStep[] = [];
  const stepLines = cleanMd.split('\n').filter((l) => /^\d+\.\s+/.test(l.trim()));

  if (stepLines.length > 0) {
    stepLines.forEach((line, idx) => {
      const stepNumber = idx + 1;
      const actionText = line.replace(/^\d+\.\s+/, '').trim();

      // System detection
      let targetSystem = 'Internal';
      if (/slack/i.test(actionText)) targetSystem = 'Slack';
      else if (/stripe/i.test(actionText)) targetSystem = 'Stripe';
      else if (/postgres|database|pg/i.test(actionText)) targetSystem = 'Postgres';
      else if (/k8s|kubernetes/i.test(actionText)) targetSystem = 'Kubernetes';
      else if (/github|gh/i.test(actionText)) targetSystem = 'GitHub';

      // Human approval gate detection
      const requiresHumanApproval =
        /approval|manager|refund|delete|critical|high risk/i.test(actionText);

      // Condition detection
      const conditionMatch = actionText.match(/if\s+([^,.]+)/i);
      const condition = conditionMatch ? conditionMatch[1].trim() : undefined;

      steps.push({
        stepNumber,
        action: actionText,
        targetSystem,
        condition,
        onSuccessNextStep: stepNumber < stepLines.length ? stepNumber + 1 : undefined,
        requiresHumanApproval,
      });
    });
  } else {
    // Fallback step generation if unstructured text
    steps.push({
      stepNumber: 1,
      action: 'Validate operational request parameters',
      targetSystem: 'Internal',
      onSuccessNextStep: 2,
      requiresHumanApproval: false,
    });
    steps.push({
      stepNumber: 2,
      action: 'Execute automated workflow action',
      targetSystem: 'Slack',
      requiresHumanApproval: /refund|approval/i.test(cleanMd),
    });
  }

  const ast: SopAST = {
    id: sopId,
    title,
    triggerCondition,
    requiredInputs,
    steps,
  };

  // LLM Refinement Prompt for complex AST structuring
  try {
    const prompt = `Convert the following markdown SOP into a structured JSON AST:
${cleanMd}

Return JSON with structure:
{"title": "string", "triggerCondition": "string", "steps": [{"stepNumber": number, "action": "string", "targetSystem": "string", "requiresHumanApproval": boolean}]}`;

    const llmOut = await generateText(prompt, 'You are an Enterprise SOP AST Compiler.');
    const jsonMatch = llmOut.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.title) ast.title = parsed.title;
      if (parsed.triggerCondition) ast.triggerCondition = parsed.triggerCondition;
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        ast.steps = parsed.steps.map((s: any, idx: number) => ({
          stepNumber: s.stepNumber || idx + 1,
          action: s.action || 'Execute step',
          targetSystem: s.targetSystem || 'Internal',
          requiresHumanApproval: Boolean(s.requiresHumanApproval),
        }));
      }
    }
  } catch (llmErr) {
    console.warn('[SopCompiler Warning] LLM AST refinement error, using rule-based AST:', llmErr);
  }

  return ast;
}
