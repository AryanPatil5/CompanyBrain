import { e2bSandboxEngine, IsolationSecurityError } from './e2bSandboxEngine.js';

export { IsolationSecurityError };

export interface SecureExecutionResult {
  result: any;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Hardened Isolate Sandbox Execution Engine Wrapper
 * Delegates all runtime code execution to E2BSandboxEngine (E2B MicroVM / Isolated Container),
 * preventing host process env leaks and prototype constructor RCE attacks without Node's native vm module in production.
 */
export async function executeSecurely(
  code: string,
  params: Record<string, any> = {},
  timeoutMs = 2000,
  _memoryLimitMb = 128
): Promise<SecureExecutionResult> {
  const startTime = Date.now();

  const envVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    envVars[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  const res = await e2bSandboxEngine.executeScript(code, envVars, timeoutMs);

  return {
    result: res.result,
    stdout: res.stdout,
    stderr: res.stderr,
    durationMs: Date.now() - startTime,
  };
}
