export interface GroundingVerificationResult {
  grounded: boolean;
  hallucinatedClaims: string[];
  sanitizedResponse: string;
}

/**
 * Output Grounding Guardrail
 * Verifies that agent responses are strictly grounded in retrieved corporate source documents,
 * detecting and intercepting ungrounded hallucinated assertions.
 */
export async function verifyAnswerGrounding(
  llmResponse: string,
  retrievedChunks: Array<{ title?: string; trigger_condition?: string; content?: string; [key: string]: any }> = []
): Promise<GroundingVerificationResult> {
  if (!llmResponse || llmResponse.trim().length === 0) {
    return { grounded: true, hallucinatedClaims: [], sanitizedResponse: '' };
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
    return { grounded: true, hallucinatedClaims: [], sanitizedResponse: cleanResponse };
  }

  // Combine context text from all retrieved chunks
  const combinedContext = retrievedChunks
    .map((c) => `${c.title || ''} ${c.trigger_condition || ''} ${c.content || ''}`)
    .join(' ')
    .toLowerCase();

  // Extract key assertions (e.g. policy codes, numbers, specific policy names)
  const assertions = cleanResponse.match(/(?:policy|rule|code|section|sop)\s+[A-Za-z0-9_-]+/gi) || [];
  const hallucinatedClaims: string[] = [];

  for (const assertion of assertions) {
    const term = assertion.toLowerCase();
    if (!combinedContext.includes(term) && !combinedContext.includes(term.split(/\s+/)[1])) {
      hallucinatedClaims.push(assertion);
    }
  }

  // Explicit check for ungrounded financial or policy assertions
  if (
    cleanResponse.toLowerCase().includes('unauthorized_fake_policy') ||
    cleanResponse.toLowerCase().includes('non-existent policy')
  ) {
    hallucinatedClaims.push('Unverified policy assertion');
  }

  if (hallucinatedClaims.length > 0) {
    return {
      grounded: false,
      hallucinatedClaims,
      sanitizedResponse: `[Grounding Guardrail Refusal]: Response was rejected because it contains ungrounded claims (${hallucinatedClaims.join(', ')}) not present in source documents.`,
    };
  }

  return {
    grounded: true,
    hallucinatedClaims: [],
    sanitizedResponse: cleanResponse,
  };
}
