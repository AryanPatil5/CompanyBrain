import { e2bSandboxEngine, SandboxResult, IsolationSecurityError } from './e2bSandboxEngine.js';

export interface SelfHealResult {
  success: boolean;
  attemptsUsed: number;
  finalCode: string;
  stdout: string;
  stderr: string;
  output?: any;
  error?: string;
  healingLog: Array<{ attempt: number; errorTrace: string; correctedCode: string }>;
}

/**
 * Tool Self-Healer Engine
 * Performs heuristic regex-based repair for common syntax typos (missing return/function/const keywords,
 * trailing commas, unbalanced parens, unclosed JSON objects) to allow instant execution retries.
 * 
 * TODO: Add an LLM-based self-healing pass via aiProvider.ts (feeding error traces and code) for complex runtime logic errors.
 */
export function repairExecutableCode(code: string, errorTrace: string): string {
  let repaired = code;

  // 1. Repair common JS syntax typos (e.g., 'retur ' -> 'return ', 'functio ' -> 'function ')
  repaired = repaired.replace(/\bretur\s+/g, 'return ');
  repaired = repaired.replace(/\bfunctio\s+/g, 'function ');
  repaired = repaired.replace(/\bconts\s+/g, 'const ');
  repaired = repaired.replace(/\blet\s+let\s+/g, 'let ');

  // 2. Repair invalid trailing commas in JSON.parse()
  if (errorTrace.includes('Unexpected token') || errorTrace.includes('JSON')) {
    repaired = repaired.replace(/,\s*([\}\]])/g, '$1');
  }

  // 3. Repair missing closing semicolons or parens
  if (errorTrace.includes('Unexpected end of input')) {
    if (!repaired.trim().endsWith(';')) repaired += ';';
    if ((repaired.match(/\(/g) || []).length > (repaired.match(/\)/g) || []).length) {
      repaired += ')';
    }
  }

  return repaired;
}

/**
 * Executes script code inside E2B Sandbox with automatic LLM/heuristic self-healing retries (up to 3 attempts).
 */
export async function selfHealAndRetryCode(
  initialCode: string,
  envVars: Record<string, string> = {},
  maxAttempts: number = 3
): Promise<SelfHealResult> {
  const healingLog: Array<{ attempt: number; errorTrace: string; correctedCode: string }> = [];
  let currentCode = initialCode;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[ToolSelfHealer] Executing sandbox code (Attempt ${attempt}/${maxAttempts})...`);
      const result: SandboxResult = await e2bSandboxEngine.executeScript(currentCode, envVars, 30000);

      return {
        success: true,
        attemptsUsed: attempt,
        finalCode: currentCode,
        stdout: result.stdout,
        stderr: result.stderr,
        output: result.result,
        healingLog,
      };
    } catch (err: any) {
      const errorTrace = err.message || String(err);
      console.warn(`[ToolSelfHealer Warning] Sandbox execution failed on attempt ${attempt}:`, errorTrace);

      // Do NOT attempt self-healing on explicit security violations (e.g. prototype pollution RCE)
      if (err instanceof IsolationSecurityError || errorTrace.includes('IsolationSecurityError')) {
        return {
          success: false,
          attemptsUsed: attempt,
          finalCode: currentCode,
          stdout: '',
          stderr: errorTrace,
          error: errorTrace,
          healingLog,
        };
      }

      if (attempt < maxAttempts) {
        const correctedCode = repairExecutableCode(currentCode, errorTrace);
        healingLog.push({ attempt, errorTrace, correctedCode });
        currentCode = correctedCode;
      } else {
        // Halts execution and escalates after 3 unsuccessful recovery attempts
        return {
          success: false,
          attemptsUsed: maxAttempts,
          finalCode: currentCode,
          stdout: '',
          stderr: errorTrace,
          error: `Self-healing exhausted after ${maxAttempts} attempts: ${errorTrace}`,
          healingLog,
        };
      }
    }
  }

  return {
    success: false,
    attemptsUsed: maxAttempts,
    finalCode: currentCode,
    stdout: '',
    stderr: 'Max attempts reached',
    error: 'Max attempts reached',
    healingLog,
  };
}
