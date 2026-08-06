export interface SandboxResult {
  stdout: string;
  stderr: string;
  result?: any;
  exitCode: number;
  durationMs: number;
}

export class IsolationSecurityError extends Error {
  constructor(message: string) {
    super(`[IsolationSecurityError]: ${message}`);
    this.name = 'IsolationSecurityError';
  }
}

/**
 * Isolated MicroVM Execution Engine via E2B Code Interpreter SDK
 * Safely executes untrusted JavaScript / Python tools inside ephemeral microVMs,
 * preventing host process env leak and prototype constructor RCE attacks.
 */
export class E2BSandboxEngine {
  /**
   * Executes script code inside an isolated E2B microVM session.
   */
  public async executeScript(
    code: string,
    envVars: Record<string, string> = {},
    timeoutMs: number = 30000
  ): Promise<SandboxResult> {
    const startTime = Date.now();
    const apiKey = process.env.E2B_API_KEY;
    const isProdMode = process.env.NODE_ENV === 'production';

    // Static pre-execution static analysis check for prototype RCE escape attempts
    if (
      code.includes('this.constructor.constructor') ||
      code.includes('Function("return process")') ||
      code.includes('Function(\'return process\')') ||
      code.includes('process.mainModule') ||
      code.includes('process.binding')
    ) {
      throw new IsolationSecurityError('Access to host process or prototype constructor is strictly forbidden.');
    }

    // Try E2B SDK execution if API key is present
    if (apiKey) {
      let sandbox: any = null;
      try {
        const pkgName = '@e2b/code-interpreter';
        const { CodeInterpreter } = await import(/* template */ pkgName);

        sandbox = await CodeInterpreter.create({ apiKey });
        const execution = await sandbox.notebook.execCell(code, { envVars, timeoutMs });

        const stdout = execution.logs.stdout.join('\n').trim();
        const stderr = execution.logs.stderr.join('\n').trim();

        return {
          stdout,
          stderr,
          result: execution.results?.[0]?.text || execution.text,
          exitCode: execution.error ? 1 : 0,
          durationMs: Date.now() - startTime,
        };
      } catch (err: any) {
        if (err.message?.includes('timeout') || err.message?.includes('timed out')) {
          throw new Error(`[CPU Timeout]: MicroVM execution exceeded limit of ${timeoutMs}ms.`);
        }
        throw err;
      } finally {
        if (sandbox) {
          try {
            await sandbox.kill();
          } catch {}
        }
      }
    }

    // Production mode guardrail: Node native VM is forbidden in production without E2B MicroVM
    if (isProdMode) {
      throw new Error('[MicroVM Security Enforcement]: Native Node VM is strictly forbidden in production. Configure E2B_API_KEY.');
    }

    // Isolated fallback execution for dev / test mode without E2B API Key.
    // Uses a real V8 isolate (isolated-vm) so CPU-bound infinite loops are
    // preempted via a hard timeout instead of blocking the host event loop.
    return new Promise((resolve, reject) => {
      let isSettled = false;
      let stdout = '';
      let stderr = '';
      let isolate: any = null;

      const settle = (action: () => void) => {
        if (isSettled) return;
        isSettled = true;
        try {
          isolate?.dispose();
        } catch {
          // Best-effort cleanup
        }
        action();
      };

      (async () => {
        const ivmModule: any = await import('isolated-vm');
        const ivm = ivmModule.default || ivmModule;

        isolate = new ivm.Isolate({ memoryLimit: 128 });
        const context = isolate.createContextSync();

        const logFn = new ivm.Reference((...args: unknown[]) => {
          stdout += args.map(String).join(' ') + '\n';
        });
        const errFn = new ivm.Reference((...args: unknown[]) => {
          stderr += args.map(String).join(' ') + '\n';
        });

        context.global.setSync('__sandboxLog', logFn);
        context.global.setSync('__sandboxErr', errFn);
        context.global.setSync('env', new ivm.ExternalCopy(envVars).copyInto());

        const script = isolate.compileScriptSync(
          `"use strict";
          const console = {
            log: (...args) => __sandboxLog.applySync(undefined, args),
            error: (...args) => __sandboxErr.applySync(undefined, args),
          };
          const __result = (function (env, console) {
            ${code}
          })(env, console);
          __result;`
        );

        const res = script.runSync(context, { timeout: timeoutMs });

        settle(() => {
          resolve({
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            result: res,
            exitCode: 0,
            durationMs: Date.now() - startTime,
          });
        });
      })().catch((err: any) => {
        settle(() => {
          if (err?.message?.includes('timed out') || err?.message?.includes('Timeout')) {
            reject(new Error(`[CPU Timeout]: MicroVM execution exceeded limit of ${timeoutMs}ms.`));
          } else if (err?.message?.includes('IsolationSecurityError') || err?.name === 'IsolationSecurityError') {
            reject(new IsolationSecurityError(err.message));
          } else {
            reject(err);
          }
        });
      });
    });
  }
}

export const e2bSandboxEngine = new E2BSandboxEngine();
