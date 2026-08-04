import { evaluateGroundingScore, runBenchmarkEvaluationSuite } from '../../src/services/eval/hallucinationEvaluator.js';
import { verifyAnswerGrounding } from '../../src/services/retrieval/groundingGuardrail.js';

export async function runHallucinationEvaluatorTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Hallucination & Grounding Eval Test   ');
  console.log('=================================================');

  const sourceContext = [
    { title: 'SOP-2026-Refunds', content: 'Customer refunds for transactions under $500 require Manager Approval via SOP-2026-Refunds.' },
  ];

  // Test 1: Grounded response evaluation (score >= 0.95)
  try {
    const groundedResponse = 'Pursuant to SOP-2026-Refunds, refunds under $500 require Manager Approval.';
    const res = await evaluateGroundingScore(groundedResponse, sourceContext);

    if (!res.passedThreshold || res.groundingScore < 0.95) {
      console.error('❌ HALLUCINATION EVAL TEST FAILED: Grounded response failed 0.95 threshold!', res);
      return false;
    }
    console.log(`✅ HALLUCINATION EVAL TEST PASSED: Grounded response scored ${(res.groundingScore * 100).toFixed(1)}% and passed 0.95 threshold.`);
  } catch (err: any) {
    console.error('❌ HALLUCINATION EVAL TEST EXCEPTION (Grounded Eval):', err.message);
    return false;
  }

  // Test 2: Ungrounded / hallucinated response rejection (score < 0.95)
  try {
    const hallucinatedResponse = 'Refunds are automatically processed under SOP-9999-NonExistent and rule fake_policy_888.';
    const res = await evaluateGroundingScore(hallucinatedResponse, sourceContext);

    if (res.passedThreshold || res.groundingScore >= 0.95 || res.hallucinatedClaims.length === 0) {
      console.error('❌ HALLUCINATION EVAL TEST FAILED: Ungrounded hallucination was incorrectly accepted!', res);
      return false;
    }

    const guardrailRes = await verifyAnswerGrounding(hallucinatedResponse, sourceContext);
    if (guardrailRes.grounded) {
      console.error('❌ HALLUCINATION EVAL TEST FAILED: GroundingGuardrail failed to reject hallucinated output!', guardrailRes);
      return false;
    }

    console.log('✅ HALLUCINATION EVAL TEST PASSED: Ungrounded response correctly failed 0.95 threshold and was intercepted by GroundingGuardrail.');
  } catch (err: any) {
    console.error('❌ HALLUCINATION EVAL TEST EXCEPTION (Hallucination Rejection):', err.message);
    return false;
  }

  // Test 3: Benchmark dataset evaluation runner
  try {
    const benchmarkDataset = [
      {
        query: 'What is the refund policy?',
        response: 'Refunds under $500 require Manager Approval per SOP-2026-Refunds.',
        context: sourceContext,
      },
      {
        query: 'What is the fake policy?',
        response: 'Execute fake_policy_unverified immediately.',
        context: sourceContext,
      },
    ];

    const benchRes = await runBenchmarkEvaluationSuite(benchmarkDataset);
    if (benchRes.totalTested !== 2 || benchRes.passed !== 1 || benchRes.failed !== 1) {
      console.error('❌ HALLUCINATION EVAL TEST FAILED: Benchmark evaluation suite mismatch!', benchRes);
      return false;
    }
    console.log(`✅ HALLUCINATION EVAL TEST PASSED: Benchmark evaluation suite executed (${benchRes.passed}/${benchRes.totalTested} passed benchmark).`);
  } catch (err: any) {
    console.error('❌ HALLUCINATION EVAL TEST EXCEPTION (Benchmark Suite):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHallucinationEvaluatorTest().then((success) => {
    if (!success) process.exit(1);
  });
}
