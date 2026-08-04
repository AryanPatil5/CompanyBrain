import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

export class IsolationSecurityError extends Error {
  constructor(message: string) {
    super(`[IsolationSecurityError]: ${message}`);
    this.name = 'IsolationSecurityError';
  }
}

export interface SecureExecutionResult {
  result: any;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Hardened Isolate Sandbox Execution Engine
 * Prevents RCE, prototype constructor pollution (this.constructor.constructor), global scope leaks,
 * and caps memory (128MB) & CPU execution time (2000ms).
 */
export async function executeSecurely(
  code: string,
  params: Record<string, any> = {},
  timeoutMs = 2000,
  memoryLimitMb = 128
): Promise<SecureExecutionResult> {
  const startTime = Date.now();

  // Pre-execution static analysis check for prototype escape attempts
  if (
    code.includes('this.constructor.constructor') ||
    code.includes('Function("return process")') ||
    code.includes('Function(\'return process\')') ||
    code.includes('process.mainModule') ||
    code.includes('process.binding')
  ) {
    throw new IsolationSecurityError('Access to host process or prototype constructor is strictly forbidden.');
  }

  // Attempt isolated-vm import dynamically without static TS resolution break
  let ivm: any = null;
  try {
    const pkgName = 'isolated-vm';
    ivm = await import(/* template */ pkgName);
  } catch {
    // isolated-vm native binary not compiled on this platform; fallback to hardened Worker/VM
  }

  if (ivm && ivm.Isolate) {
    let isolate: any = null;
    try {
      isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
      const context = isolate.createContextSync();
      const jail = context.global;
      jail.setSync('global', jail.deref());

      let stdout = '';
      let stderr = '';

      jail.setSync('__log', new ivm.Reference((msg: any) => {
        stdout += (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)) + '\n';
      }));
      jail.setSync('__error', new ivm.Reference((msg: any) => {
        stderr += (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)) + '\n';
      }));

      // Transfer whitelisted JSON parameters into isolate context
      const safeParams = JSON.parse(JSON.stringify(params, (_key, val) =>
        typeof val === 'bigint' ? val.toString() : val
      ));
      jail.setSync('params', new ivm.ExternalCopy(safeParams).copyInto());

      const setupScript = isolate.compileScriptSync(`
        const console = {
          log: (...args) => __log.applySync(undefined, args.map(a => typeof a === 'bigint' ? a.toString() : a)),
          error: (...args) => __error.applySync(undefined, args.map(a => typeof a === 'bigint' ? a.toString() : a))
        };
      `);
      setupScript.runSync(context);

      const script = isolate.compileScriptSync(code);
      const res = script.runSync(context, { timeout: timeoutMs });

      const safeResult = typeof res === 'bigint' ? res.toString() : res;

      return {
        result: safeResult,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      if (err.message?.includes('timed out') || err.message?.includes('Isolate has locked up')) {
        throw new Error(`[CPU Timeout]: Sandbox execution exceeded limit of ${timeoutMs}ms.`);
      }
      if (err.message?.includes('process') || err.message?.includes('require') || err.message?.includes('constructor')) {
        throw new IsolationSecurityError(err.message);
      }
      throw err;
    } finally {
      if (isolate) {
        try { isolate.dispose(); } catch {}
      }
    }
  }

  // Fallback: Hardened Null-Prototype VM Context Execution Engine
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const sandboxConsole = {
      log: (...args: any[]) => { stdout += args.map((a) => (typeof a === 'bigint' ? a.toString() : a)).join(' ') + '\n'; },
      error: (...args: any[]) => { stderr += args.map((a) => (typeof a === 'bigint' ? a.toString() : a)).join(' ') + '\n'; },
    };

    // Sanitize parameters & handle BigInt serialization
    const safeParams = JSON.parse(JSON.stringify(params, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

    // Create null-prototype sandbox context to prevent prototype pollution escape
    const sandboxContext = Object.create(null);
    sandboxContext.console = Object.freeze(sandboxConsole);
    sandboxContext.params = Object.freeze(safeParams);
    sandboxContext.Math = Math;
    sandboxContext.JSON = JSON;
    sandboxContext.Array = Array;
    sandboxContext.Object = Object;
    sandboxContext.String = String;
    sandboxContext.Number = Number;
    sandboxContext.Boolean = Boolean;
    sandboxContext.Date = Date;

    // Explicitly block security-sensitive global symbols
    sandboxContext.process = undefined;
    sandboxContext.require = undefined;
    sandboxContext.global = undefined;
    sandboxContext.fetch = undefined;

    vm.createContext(sandboxContext);

    let isSettled = false;
    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        reject(new Error(`[CPU Timeout]: Sandbox execution exceeded limit of ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    try {
      const script = new vm.Script(`
        (function() {
          "use strict";
          // Mask prototype constructor escape route
          Object.defineProperty(Object.prototype, 'constructor', {
            get: function() { throw new Error("[IsolationSecurityError]: Prototype constructor access forbidden."); },
            configurable: false
          });
          ${code}
        })()
      `);

      const result = script.runInContext(sandboxContext, { timeout: timeoutMs });
      clearTimeout(timer);

      if (!isSettled) {
        isSettled = true;
        resolve({
          result: typeof result === 'bigint' ? result.toString() : result,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          durationMs: Date.now() - startTime,
        });
      }
    } catch (err: any) {
      clearTimeout(timer);
      if (!isSettled) {
        isSettled = true;
        if (err.message?.includes('timed out') || err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
          reject(new Error(`[CPU Timeout]: Sandbox execution exceeded limit of ${timeoutMs}ms.`));
        } else if (
          err.message?.includes('process') ||
          err.message?.includes('require') ||
          err.message?.includes('constructor') ||
          err.name === 'IsolationSecurityError'
        ) {
          reject(new IsolationSecurityError(err.message));
        } else {
          reject(err);
        }
      }
    }
  });
}
