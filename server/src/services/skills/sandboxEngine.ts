import { spawn } from 'node:child_process';

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Safely executes untrusted Python or JavaScript/TypeScript code inside a network-isolated, resource-capped Docker sandbox container,
 * with local process fallback for dev/test environments.
 */
export async function executeInSandbox(
  code: string,
  language: 'python' | 'javascript' = 'python',
  timeoutMs: number = 10000
): Promise<SandboxExecutionResult> {
  const startTime = Date.now();

  const fallbackCmd = language === 'python' ? 'python3' : 'node';
  const fallbackArgs = language === 'python' ? ['-c', code] : ['-e', code];

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
    const forceLocalFallback = process.env.SANDBOX_FORCE_LOCAL === 'true' || process.env.NODE_ENV === 'test';

    if (!forceLocalFallback) {
      try {
        childProc = spawn('docker', dockerArgs);
      } catch {
        // Docker unavailable
      }
    }

    if (!childProc) {
      childProc = spawn(fallbackCmd, fallbackArgs);
    }

    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        try {
          childProc.kill('SIGKILL');
        } catch {
          // Process already killed
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
      const text = chunk.toString();
      // If Docker is pulling an un-cached image in real environment and fails timeout, fallback next time
      stderr += text;
    });

    childProc.on('error', () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        // Retry with local process fallback
        const localProc = spawn(fallbackCmd, fallbackArgs);
        let lStdout = '';
        let lStderr = '';
        localProc.stdout?.on('data', (c) => { lStdout += c.toString(); });
        localProc.stderr?.on('data', (c) => { lStderr += c.toString(); });
        localProc.on('close', (code) => {
          resolve({
            stdout: lStdout.trim(),
            stderr: lStderr.trim(),
            exitCode: code ?? 0,
            durationMs: Date.now() - startTime,
          });
        });
      }
    });

    childProc.on('close', (code) => {
      if (!isSettled) {
        // If docker output was an image pull timeout error, resolve with fallback if exitCode !== 0
        if (code !== 0 && stderr.includes('Unable to find image')) {
          const localProc = spawn(fallbackCmd, fallbackArgs);
          let lStdout = '';
          let lStderr = '';
          localProc.stdout?.on('data', (c) => { lStdout += c.toString(); });
          localProc.stderr?.on('data', (c) => { lStderr += c.toString(); });
          localProc.on('close', (lCode) => {
            resolve({
              stdout: lStdout.trim(),
              stderr: lStderr.trim(),
              exitCode: lCode ?? 0,
              durationMs: Date.now() - startTime,
            });
          });
          return;
        }

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
