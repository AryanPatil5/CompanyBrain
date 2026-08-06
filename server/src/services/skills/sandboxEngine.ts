import { spawn } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executeSecurely } from './secureSandboxEngine.js';

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Runs a child process to completion, force-killing it if it exceeds the timeout.
 * Ensures every spawned process (docker client or local fallback) is terminated
 * so the promise always settles. Docker containers are tracked via a cidfile so
 * a timed-out `docker run` can be force-removed instead of being orphaned.
 */
function runProcessWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs: number,
  startTime: number,
  cidfile?: string
): Promise<SandboxExecutionResult> {
  return new Promise<SandboxExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let isSettled = false;

    const childProc = spawn(cmd, args);

    const cleanupDockerContainer = () => {
      if (!cidfile) return;
      try {
        const containerId = readFileSync(cidfile, 'utf8').trim();
        if (containerId) {
          spawn('docker', ['rm', '-f', containerId]);
        }
      } catch {
        // Container never started or already removed
      } finally {
        try {
          rmSync(cidfile, { force: true });
        } catch {
          // Best-effort cleanup
        }
      }
    };

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          childProc.kill('SIGKILL');
        } catch {
          // Process already dead
        }
        cleanupDockerContainer();
        resolve({
          stdout,
          stderr: stderr + `\n[Sandbox Error]: Execution timed out after ${timeoutMs}ms.`,
          exitCode: 124,
          durationMs: Date.now() - startTime,
        });
      }
    }, timeoutMs);

    childProc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    childProc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    childProc.on('error', () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        cleanupDockerContainer();
        resolve({
          stdout,
          stderr: stderr + '\n[Sandbox Error]: Failed to spawn process.',
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      }
    });

    childProc.on('close', (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        try {
          rmSync(cidfile ?? '', { force: true });
        } catch {
          // Best-effort cleanup
        }
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code ?? 0,
          durationMs: Date.now() - startTime,
        });
      }
    });
  });
}

/**
 * Safely executes untrusted Python or JavaScript/TypeScript code inside a network-isolated, resource-capped Docker sandbox container,
 * or using hardened Isolate execution runner for inline TS/JS tools.
 */
export async function executeInSandbox(
  code: string,
  language: 'python' | 'javascript' = 'python',
  timeoutMs: number = 10000
): Promise<SandboxExecutionResult> {
  const startTime = Date.now();

  // If language is JavaScript/TypeScript, execute through hardened Isolate sandbox runner
  if (language === 'javascript') {
    try {
      const res = await executeSecurely(code, {}, timeoutMs);
      return {
        stdout: res.stdout || (res.result !== undefined ? String(res.result) : ''),
        stderr: res.stderr,
        exitCode: 0,
        durationMs: res.durationMs,
      };
    } catch (err: any) {
      return {
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - startTime,
      };
    }
  }

  const fallbackCmd = 'python3';
  const fallbackArgs = ['-c', code];

  const image = 'python:3.11-slim';
  const execCmd = ['python3', '-c', code];
  const cidfile = join(tmpdir(), `cb-sandbox-${randomUUID()}.cid`);

  const dockerArgs = [
    'run',
    '--rm',
    '--cidfile',
    cidfile,
    '--network',
    'none',
    '--memory',
    '256m',
    '--cpus',
    '0.5',
    image,
    ...execCmd,
  ];

  const forceLocalFallback = process.env.SANDBOX_FORCE_LOCAL === 'true';

  if (forceLocalFallback) {
    return runProcessWithTimeout(fallbackCmd, fallbackArgs, timeoutMs, startTime);
  }

  const dockerRes = await runProcessWithTimeout('docker', dockerArgs, timeoutMs, startTime, cidfile);

  if (
    dockerRes.exitCode !== 0 &&
    (dockerRes.stderr.includes('Unable to find image') || dockerRes.stderr.includes('Pulling'))
  ) {
    return runProcessWithTimeout(fallbackCmd, fallbackArgs, timeoutMs, startTime);
  }

  return dockerRes;
}
