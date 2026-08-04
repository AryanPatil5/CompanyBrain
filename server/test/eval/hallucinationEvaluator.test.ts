import { evaluateGroundingScore, runBenchmarkEvaluationSuite } from '../../src/services/eval/hallucinationEvaluator.js';

export async function runHallucinationEvaluatorTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running LLM-Graded Hallucination Eval Test   ');
  console.log('=================================================');

  const sourceContext = [
    {
      title: 'SOP-2026-Refunds',
      content: 'Customer refunds for transactions under $500 require Manager Approval via SOP-2026-Refunds.',
    },
  ];

  // Test 1: Accurate Paraphrase Case (Should pass 0.95 threshold)
  try {
    const accurateParaphrase = 'Pursuant to company procedure, any refund under $500 must receive explicit approval from a manager.';
    const res = await evaluateGroundingScore(accurateParaphrase, sourceContext);

    if (!res.passedThreshold || res.groundingScore < 0.95) {
      console.error('❌ LLM HALLUCINATION EVAL TEST FAILED: Accurate paraphrase was falsely flagged as ungrounded!', res);
      return false;
    }
    console.log(`✅ LLM HALLUCINATION EVAL TEST PASSED: Accurate paraphrase correctly verified (${(res.groundingScore * 100).toFixed(1)}% grounding score).`);
  } catch (err: any) {
    console.error('❌ LLM HALLUCINATION EVAL TEST EXCEPTION (Paraphrase):', err.message);
    return false;
  }

  // Test 2: Direct Contradiction Case (Must be flagged as hallucinated / ungrounded)
  try {
    const contradictoryResponse = 'Refunds under $500 are automatically approved and dispatched without requiring any manager review.';
    const res = await evaluateGroundingScore(contradictoryResponse, sourceContext);

    if (res.passedThreshold || res.groundingScore >= 0.95 || res.hallucinatedClaims.length === 0) {
      console.error('❌ LLM HALLUCINATION EVAL TEST FAILED: Direct contradiction was NOT flagged as hallucinated!', res);
      return false;
    }
    console.log(`✅ LLM HALLUCINATION EVAL TEST PASSED: Direct contradiction correctly intercepted (${res.hallucinatedClaims.join(', ')}).`);
  } catch (err: any) {
    console.error('❌ LLM HALLUCINATION EVAL TEST EXCEPTION (Contradiction):', err.message);
    return false;
  }

  // Test 3: Fast-Path Empty Input Case (Should return grounded immediately without LLM error)
  try {
    const res = await evaluateGroundingScore('', sourceContext);
    if (!res.passedThreshold || res.claimsEvaluated !== 0) {
      console.error('❌ LLM HALLUCINATION EVAL TEST FAILED: Fast-path empty response failed!', res);
      return false;
    }
    console.log('✅ LLM HALLUCINATION EVAL TEST PASSED: Fast-path for empty response returned instantly.');
  } catch (err: any) {
    console.error('❌ LLM HALLUCINATION EVAL TEST EXCEPTION (Fast Path):', err.message);
    return false;
  }

  // Test 4: Benchmark Dataset Suite Execution
  try {
    const benchmarkDataset = [
      {
        query: 'What is the refund process?',
        response: 'Refunds under $500 require manager approval.',
        context: sourceContext,
      },
      {
        query: 'Can refunds be processed automatically?',
        response: 'All refunds are auto-approved without approval.',
        context: sourceContext,
      },
    ];

    const benchRes = await runBenchmarkEvaluationSuite(benchmarkDataset);
    if (benchRes.totalTested !== 2 || benchRes.passed !== 1 || benchRes.failed !== 1) {
      console.error('❌ LLM HALLUCINATION EVAL TEST FAILED: Benchmark suite execution mismatch!', benchRes);
      return false;
    }
    console.log(`✅ LLM HALLUCINATION EVAL TEST PASSED: Benchmark evaluation suite executed (${benchRes.passed}/${benchRes.totalTested} passed).`);
  } catch (err: any) {
    console.error('❌ LLM HALLUCINATION EVAL TEST EXCEPTION (Benchmark):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHallucinationEvaluatorTest().then((success) => {
    if (!success) process.exit(1);
  });
}
