import { selfHealAndRetryCode, repairExecutableCode } from '../../src/services/skills/toolSelfHealer.js';

export async function runToolSelfHealerTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Tool Self-Healer Sandbox Retry Test ');
  console.log('=================================================');

  // Test 1: Code Syntax & Typo Repair Heuristics
  try {
    const brokenCode = "retur { status: 'ok', }";
    const repaired = repairExecutableCode(brokenCode, 'Unexpected token');

    if (!repaired.includes('return') || repaired.includes('retur')) {
      console.error('❌ SELF-HEALER TEST FAILED: Typo repair failed to fix retur statement!', repaired);
      return false;
    }
    console.log('✅ SELF-HEALER TEST PASSED: Successfully repaired JS statement typo (retur -> return).');
  } catch (err: any) {
    console.error('❌ SELF-HEALER TEST EXCEPTION (Code Repair):', err.message);
    return false;
  }

  // Test 2: Successful self-correction inside Sandbox Sandbox
  try {
    const typoScript = "retur 'Execution Success via Self-Healer';";
    const healRes = await selfHealAndRetryCode(typoScript, {}, 3);

    if (!healRes.success || healRes.output !== 'Execution Success via Self-Healer') {
      console.error('❌ SELF-HEALER TEST FAILED: Sandbox execution self-correction failed!', healRes);
      return false;
    }
    console.log(`✅ SELF-HEALER TEST PASSED: Successfully self-corrected and executed code in sandbox (Used ${healRes.attemptsUsed} attempts).`);
  } catch (err: any) {
    console.error('❌ SELF-HEALER TEST EXCEPTION (Sandbox Self-Heal):', err.message);
    return false;
  }

  // Test 3: Halts execution and escalates after 3 unsuccessful recovery attempts
  try {
    const irrecoverableCode = "throw new Error('Fatal unrecoverable API crash');";
    const failRes = await selfHealAndRetryCode(irrecoverableCode, {}, 3);

    if (failRes.success || failRes.attemptsUsed !== 3 || !failRes.error?.includes('exhausted')) {
      console.error('❌ SELF-HEALER TEST FAILED: Did not halt and escalate after 3 attempts!', failRes);
      return false;
    }
    console.log('✅ SELF-HEALER TEST PASSED: Correctly halted and escalated after 3 unsuccessful recovery attempts.');
  } catch (err: any) {
    console.error('❌ SELF-HEALER TEST EXCEPTION (Escalation):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runToolSelfHealerTest().then((success) => {
    if (!success) process.exit(1);
  });
}
