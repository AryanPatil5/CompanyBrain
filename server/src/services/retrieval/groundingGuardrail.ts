import { evaluateGroundingScore } from '../eval/hallucinationEvaluator.js';

export interface GroundingVerificationResult {
  grounded: boolean;
  hallucinatedClaims: string[];
  sanitizedResponse: string;
  groundingScore?: number;
}

/**
 * Output Grounding Guardrail
 * Verifies that agent responses are strictly grounded in retrieved corporate source documents,
 * enforcing a 0.95 grounding score threshold and intercepting ungrounded claims.
 */
export async function verifyAnswerGrounding(
  llmResponse: string,
  retrievedChunks: Array<{ title?: string; trigger_condition?: string; content?: string; [key: string]: any }> = []
): Promise<GroundingVerificationResult> {
  if (!llmResponse || llmResponse.trim().length === 0) {
    return { grounded: true, hallucinatedClaims: [], sanitizedResponse: '', groundingScore: 1.0 };
  }

  const cleanResponse = llmResponse.trim();

  // Edge case: Filler conversational phrases bypass claim extraction
  const fillerPhrases = [
    'sure, i can help',
    'here is the information',
    'ok',
    'understood',
    'processing your request',
  ];
  if (fillerPhrases.some((f) => cleanResponse.toLowerCase().startsWith(f)) && cleanResponse.length < 60) {
    return { grounded: true, hallucinatedClaims: [], sanitizedResponse: cleanResponse, groundingScore: 1.0 };
  }

  const evalResult = await evaluateGroundingScore(cleanResponse, retrievedChunks);

  if (!evalResult.passedThreshold || evalResult.hallucinatedClaims.length > 0) {
    return {
      grounded: false,
      hallucinatedClaims: evalResult.hallucinatedClaims,
      groundingScore: evalResult.groundingScore,
      sanitizedResponse: `[Grounding Guardrail Refusal]: Response rejected due to low grounding score (${(evalResult.groundingScore * 100).toFixed(1)}% < 95.0% threshold). Ungrounded claims: ${evalResult.hallucinatedClaims.join(', ') || 'Unverified assertions'}.`,
    };
  }

  return {
    grounded: true,
    hallucinatedClaims: [],
    groundingScore: evalResult.groundingScore,
    sanitizedResponse: cleanResponse,
  };
}
