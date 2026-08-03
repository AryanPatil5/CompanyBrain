import { executeInSandbox } from '../../src/services/skills/sandboxEngine.js';

export async function runSandboxEngineTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Docker Sandbox Execution Engine Test   ');
  console.log('=================================================');

  // 1. Test Clean Python Calculation
  const pyCode = 'import math; print("Result:", math.factorial(5))';
  const pyRes = await executeInSandbox(pyCode, 'python', 5000);

  if (pyRes.exitCode !== 0 || !pyRes.stdout.includes('120')) {
    console.error('❌ SANDBOX TEST FAILED: Python execution failed or returned unexpected output!', pyRes);
    return false;
  }
  console.log(`✅ SANDBOX TEST PASSED: Python code executed safely (${pyRes.durationMs}ms) with stdout: "${pyRes.stdout}".`);

  // 2. Test Clean JavaScript Calculation
  const jsCode = 'console.log("JS Sum:", 10 + 20 + 30)';
  const jsRes = await executeInSandbox(jsCode, 'javascript', 5000);

  if (jsRes.exitCode !== 0 || !jsRes.stdout.includes('60')) {
    console.error('❌ SANDBOX TEST FAILED: JavaScript execution failed!', jsRes);
    return false;
  }
  console.log(`✅ SANDBOX TEST PASSED: JavaScript code executed safely (${jsRes.durationMs}ms) with stdout: "${jsRes.stdout}".`);

  // 3. Test Timeout Limit Force Termination
  const infiniteLoopCode = 'while True: pass';
  const timeoutRes = await executeInSandbox(infiniteLoopCode, 'python', 1000);

  if (timeoutRes.exitCode === 0) {
    console.error('❌ SANDBOX TEST FAILED: Infinite loop did not timeout properly!', timeoutRes);
    return false;
  }
  console.log(`✅ SANDBOX TEST PASSED: Infinite loop process force-killed after timeout threshold (${timeoutRes.durationMs}ms).`);

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSandboxEngineTest().then((success) => {
    if (!success) process.exit(1);
  });
}
