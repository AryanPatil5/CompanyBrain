import { installHarness } from '../harness/index.js';
import { rerankResults } from '../../src/services/retrieval/reranker.js';
import { verifyAnswerGrounding } from '../../src/services/retrieval/groundingGuardrail.js';

export async function runGroundingGuardrailTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Cross-Encoder Reranker & Grounding Test');
  console.log('=================================================');

  // Test 1: Should successfully re-score and re-order 20 candidate chunks
  try {
    const candidateChunks = Array.from({ length: 20 }, (_, i) => ({
      id: `doc_${i}`,
      title: i === 15 ? 'PostgreSQL Database Primary Backup SOP' : `Generic Operational Doc ${i}`,
      trigger_condition: i === 15 ? 'PostgreSQL DB Primary failure recovery' : `General info ${i}`,
      category: 'Database',
    }));

    const reranked = await rerankResults('PostgreSQL Database Primary Backup', candidateChunks, 5);

    if (reranked.length !== 5 || reranked[0].id !== 'doc_15') {
      console.error('❌ GROUNDING TEST FAILED: Reranker did not promote doc_15 to top rank!', reranked);
      return false;
    }
    console.log(`✅ GROUNDING TEST PASSED: Cross-encoder reranker successfully re-scored 20 candidates and promoted exact relevance match to top 1.`);
  } catch (err: any) {
    console.error('❌ GROUNDING TEST EXCEPTION (Reranker):', err.message);
    return false;
  }

  // Test 2: Should pass grounding check when response statements match context chunks
  try {
    const validResponse = 'Sure, I can help with that. Please refer to Policy SOP-102 for refund limits.';
    const retrievedChunks = [
      { title: 'Refund Guidelines', trigger_condition: 'Customer refund request', content: 'Policy SOP-102 governs refund limits.' },
    ];

    const groundingRes = await verifyAnswerGrounding(validResponse, retrievedChunks);

    if (!groundingRes.grounded) {
      console.error('❌ GROUNDING TEST FAILED: Valid grounded response was incorrectly rejected!', groundingRes);
      return false;
    }
    console.log('✅ GROUNDING TEST PASSED: Valid response statements verified cleanly against source chunks.');
  } catch (err: any) {
    console.error('❌ GROUNDING TEST EXCEPTION (Valid Grounding):', err.message);
    return false;
  }

  // Test 3: Should reject response when agent invents non-existent policy detail
  try {
    const ungroundedResponse = 'Please execute Unauthorized_Fake_Policy for instant approval.';
    const retrievedChunks = [
      { title: 'Standard SOP', trigger_condition: 'Normal ops', content: 'Follow standard ops.' },
    ];

    const groundingRes = await verifyAnswerGrounding(ungroundedResponse, retrievedChunks);

    if (groundingRes.grounded || groundingRes.hallucinatedClaims.length === 0) {
      console.error('❌ GROUNDING TEST FAILED: Ungrounded hallucinated policy assertion was NOT intercepted!', groundingRes);
      return false;
    }
    console.log(`✅ GROUNDING TEST PASSED: Hallucination guardrail successfully intercepted ungrounded policy claim (${groundingRes.hallucinatedClaims.join(', ')}).`);
  } catch (err: any) {
    console.error('❌ GROUNDING TEST EXCEPTION (Ungrounded Assertions):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGroundingGuardrailTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
