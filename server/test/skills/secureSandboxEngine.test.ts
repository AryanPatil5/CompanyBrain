import { executeSecurely, IsolationSecurityError } from '../../src/services/skills/secureSandboxEngine.js';

export async function runSecureSandboxEngineTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Hardened Isolate Secure Sandbox Test   ');
  console.log('=================================================');

  // Test 1: Math Computations
  try {
    const mathRes = await executeSecurely('return 10 * 20 + 50', {}, 2000);
    if (mathRes.result !== 250) {
      console.error('❌ SECURE SANDBOX TEST FAILED: Math result mismatch!', mathRes);
      return false;
    }
    console.log(`✅ SECURE SANDBOX TEST PASSED: Executed mathematical computation safely (${mathRes.result}).`);
  } catch (err: any) {
    console.error('❌ SECURE SANDBOX TEST EXCEPTION (Math):', err.message);
    return false;
  }

  // Test 2: Block Prototype Pollution Escape Attempt (this.constructor.constructor)
  try {
    const escapeCode = `
      const req = this.constructor.constructor('return process')();
      return req.env;
    `;
    await executeSecurely(escapeCode, {}, 2000);
    console.error('❌ SECURE SANDBOX TEST FAILED: Prototype constructor pollution escape attempt was NOT blocked!');
    return false;
  } catch (err: any) {
    if (err instanceof IsolationSecurityError || err.name === 'IsolationSecurityError' || err.message?.includes('IsolationSecurityError') || err.message?.includes('forbidden')) {
      console.log(`✅ SECURE SANDBOX TEST PASSED: Successfully blocked prototype pollution RCE escape attempt (${err.message}).`);
    } else {
      console.error('❌ SECURE SANDBOX TEST FAILED: Unexpected error type on escape attempt:', err);
      return false;
    }
  }

  // Test 3: CPU Timeout Exception on Infinite Loops
  try {
    const loopCode = 'while (true) {}';
    await executeSecurely(loopCode, {}, 500);
    console.error('❌ SECURE SANDBOX TEST FAILED: Infinite loop did not trigger timeout exception!');
    return false;
  } catch (err: any) {
    if (err.message?.includes('Timeout') || err.message?.includes('timed out')) {
      console.log(`✅ SECURE SANDBOX TEST PASSED: Infinite loop correctly aborted on CPU timeout limit (${err.message}).`);
    } else {
      console.error('❌ SECURE SANDBOX TEST FAILED: Unexpected error on loop timeout:', err);
      return false;
    }
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSecureSandboxEngineTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
