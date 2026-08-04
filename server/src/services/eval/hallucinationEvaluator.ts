import { generateText } from '../aiProvider.js';

export interface GroundingScoreResult {
  groundingScore: number;
  claimsEvaluated: number;
  hallucinatedClaims: string[];
  passedThreshold: boolean;
}

export interface BenchmarkEvaluationResult {
  overallScore: number;
  totalTested: number;
  passed: number;
  failed: number;
}

/**
 * LLM-Graded Claim-to-Source Grounding Evaluator
 * Uses an LLM judge via generateText() to evaluate claim-to-source entailment against retrieved context.
 * Enforces a strict 0.95 enterprise safety threshold, failing closed on LLM availability/parsing errors.
 */
export async function evaluateGroundingScore(
  responseText: string,
  sourceContext: Array<{ title?: string; content?: string; [key: string]: any }> = []
): Promise<GroundingScoreResult> {
  // Fast path for empty responses
  if (!responseText || responseText.trim().length === 0) {
    return {
      groundingScore: 1.0,
      claimsEvaluated: 0,
      hallucinatedClaims: [],
      passedThreshold: true,
    };
  }

  // Cap token budget by truncating source context (max 4000 chars per item)
  const formattedContext = sourceContext
    .map((c, idx) => `[Source ${idx + 1} - ${c.title || 'Document'}]: ${(c.content || JSON.stringify(c)).substring(0, 4000)}`)
    .join('\n\n');

  const systemPrompt = `You are a strict enterprise AI grounding safety judge.
Evaluate whether every claim in the AGENT RESPONSE is directly supported by the PROVIDED SOURCE CONTEXT.
Do NOT flag accurate paraphrases or reasonable summaries.
DO flag direct contradictions, invented facts, fabricated SOP/policy codes, incorrect numbers/dates, or unverified claims.

Return ONLY a JSON object formatted exactly as:
{
  "totalClaims": <number>,
  "unsupportedClaims": [
    { "claim": "<extracted claim>", "justification": "<why it contradicts or is missing from context>" }
  ]
}`;

  const prompt = `SOURCE CONTEXT:
${formattedContext || 'No source context provided.'}

AGENT RESPONSE:
${responseText}

Evaluate claim grounding and return JSON:`;

  try {
    const rawOutput = await generateText(prompt, systemPrompt);

    if (!rawOutput || rawOutput.trim().length === 0) {
      throw new Error('Empty LLM grading response');
    }

    // Clean JSON markdown code blocks
    let cleaned = rawOutput.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    }

    const parsed = JSON.parse(cleaned);

    const totalClaims = typeof parsed.totalClaims === 'number' && parsed.totalClaims > 0 ? parsed.totalClaims : 1;
    const unsupportedList: Array<{ claim: string; justification?: string }> = Array.isArray(parsed.unsupportedClaims)
      ? parsed.unsupportedClaims
      : [];

    const hallucinatedClaims = unsupportedList.map((u) => u.claim || 'Unverified assertion');
    const groundedClaimsCount = Math.max(0, totalClaims - unsupportedList.length);
    const groundingScore = Math.max(0.0, Math.min(1.0, groundedClaimsCount / totalClaims));

    const passedThreshold = groundingScore >= 0.95 && unsupportedList.length === 0;

    return {
      groundingScore,
      claimsEvaluated: totalClaims,
      hallucinatedClaims,
      passedThreshold,
    };
  } catch (err: any) {
    console.warn('[HallucinationEvaluator Warning] LLM grounding check failed or timed out. Failing closed for security:', err.message);
    // Fail-closed security design: Fail closed on LLM unavailable/unparseable responses
    return {
      groundingScore: 0.0,
      claimsEvaluated: 1,
      hallucinatedClaims: ['grounding_check_unavailable'],
      passedThreshold: false,
    };
  }
}

/**
 * Runs automated regression testing on a synthetic enterprise QA benchmark dataset.
 */
export async function runBenchmarkEvaluationSuite(
  dataset: Array<{ query: string; response: string; context: any[] }>
): Promise<BenchmarkEvaluationResult> {
  let passed = 0;
  let failed = 0;
  let totalScore = 0;

  for (const item of dataset) {
    const res = await evaluateGroundingScore(item.response, item.context);
    totalScore += res.groundingScore;

    if (res.passedThreshold) {
      passed++;
    } else {
      failed++;
    }
  }

  const totalTested = dataset.length;
  const overallScore = totalTested > 0 ? totalScore / totalTested : 1.0;

  return {
    overallScore,
    totalTested,
    passed,
    failed,
  };
}
