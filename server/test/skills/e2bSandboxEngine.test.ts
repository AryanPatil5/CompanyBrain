import { E2BSandboxEngine, IsolationSecurityError } from '../../src/services/skills/e2bSandboxEngine.js';

export async function runE2BSandboxEngineTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running E2B MicroVM Isolated Sandbox Test Suite');
  console.log('=================================================');

  const engine = new E2BSandboxEngine();

  // Test 1: Successful execution of standard JavaScript functions
  try {
    const code = 'return (function(a, b) { return a + b; })(15, 35);';
    const res = await engine.executeScript(code, {}, 5000);

    if (res.result !== 50) {
      console.error('❌ E2B SANDBOX TEST FAILED: Result mismatch!', res);
      return false;
    }
    console.log(`✅ E2B SANDBOX TEST PASSED: Executed standard JavaScript function in isolated MicroVM (${res.result}).`);
  } catch (err: any) {
    console.error('❌ E2B SANDBOX TEST EXCEPTION (Standard Execution):', err.message);
    return false;
  }

  // Test 2: Prototype pollution escape attempt fails to expose host process environment
  try {
    const escapeCode = `
      const req = this.constructor.constructor('return process')();
      return req.env.DATABASE_URL;
    `;
    await engine.executeScript(escapeCode, {}, 5000);
    console.error('❌ E2B SANDBOX TEST FAILED: Prototype pollution attempt exposed host process!');
    return false;
  } catch (err: any) {
    if (err instanceof IsolationSecurityError || err.name === 'IsolationSecurityError' || err.message?.includes('IsolationSecurityError') || err.message?.includes('forbidden')) {
      console.log(`✅ E2B SANDBOX TEST PASSED: Successfully blocked prototype pollution RCE escape attempt (${err.message}).`);
    } else {
      console.error('❌ E2B SANDBOX TEST FAILED: Unexpected error type on escape attempt:', err);
      return false;
    }
  }

  // Test 3: Infinite loops trigger timeout errors
  try {
    const loopCode = 'while (true) {}';
    await engine.executeScript(loopCode, {}, 1000);
    console.error('❌ E2B SANDBOX TEST FAILED: Infinite loop did not trigger timeout exception!');
    return false;
  } catch (err: any) {
    if (err.message?.includes('Timeout') || err.message?.includes('timed out')) {
      console.log(`✅ E2B SANDBOX TEST PASSED: Infinite loop correctly shut down runaway process cleanly (${err.message}).`);
    } else {
      console.error('❌ E2B SANDBOX TEST FAILED: Unexpected error on loop timeout:', err);
      return false;
    }
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runE2BSandboxEngineTest().then((success) => {
    if (!success) process.exit(1);
  });
}
