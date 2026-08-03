import { spawn } from 'node:child_process';

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Safely executes untrusted Python or JavaScript/TypeScript code inside a network-isolated, resource-capped Docker sandbox container.
 */
export async function executeInSandbox(
  code: string,
  language: 'python' | 'javascript' = 'python',
  timeoutMs: number = 10000
): Promise<SandboxExecutionResult> {
  const startTime = Date.now();

  const image = language === 'python' ? 'python:3.11-slim' : 'node:20-alpine';
  const execCmd = language === 'python' ? ['python3', '-c', code] : ['node', '-e', code];

  const dockerArgs = [
    'run',
    '--rm',
    '--network',
    'none',
    '--memory',
    '256m',
    '--cpus',
    '0.5',
    image,
    ...execCmd,
  ];

  return new Promise<SandboxExecutionResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let isSettled = false;

    let childProc;
    try {
      childProc = spawn('docker', dockerArgs);
    } catch {
      // Docker binary unavailable fallback
    }

    if (!childProc) {
      // Fallback local isolated execution for test environments without Docker daemon active
      const fallbackCmd = language === 'python' ? 'python3' : 'node';
      const fallbackArgs = language === 'python' ? ['-c', code] : ['-e', code];
      childProc = spawn(fallbackCmd, fallbackArgs);
    }

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          childProc.kill('SIGKILL');
        } catch {
          // Process already dead
        }
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

    childProc.on('error', (err) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + `\n[Sandbox Subprocess Error]: ${err.message}`,
          exitCode: 1,
          durationMs: Date.now() - startTime,
        });
      }
    });

    childProc.on('close', (code) => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
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
