// Phase 3: claim extractor (ADR-T15). Decomposes chunks into atomic,
// schema-validated operational claims with char-offset evidence and
// confidence. Malformed LLM output NEVER becomes valid claims: it follows
// the established extraction failure semantics (schema-validation error is
// thrown; the caller records it and the pipeline retries/DLQs).

import { z } from 'zod';
import { logger } from '../logger.js';
import { generateText } from '../services/aiProvider.js';
import type { TextChunk } from '../ingestion/chunker.js';

export interface ExtractedClaim {
  claim_text: string;
  claim_type: string;
  confidence: number;
  /** Character offset into the SOURCE CHUNK (not the document). */
  char_start: number;
  char_end: number;
}

export const ExtractedClaimSchema = z.object({
  claim_text: z.string().min(10, 'claim_text must be at least 10 characters').max(2000),
  claim_type: z.string().min(1).max(50).default('operational'),
  confidence: z.number().min(0).max(1),
  char_start: z.number().int().min(0),
  char_end: z.number().int().min(0),
});

const CLAIM_SCHEMA = z.object({
  claims: z.array(ExtractedClaimSchema).max(20),
});

const SYSTEM_PROMPT = `
You are an Enterprise Knowledge Engineer. Your job is to decompose a document chunk into ATOMIC, verifiable operational claims.

Rules:
1. A claim is a single factual or procedural statement that is directly supported by the chunk text.
2. Claims must be grounded: every claim's char_start/char_end must point at the exact span of the chunk content that supports it (0-based offsets into the chunk content between the markers).
3. Confidence is 0..1 and reflects how explicitly the chunk supports the claim.
4. Do not invent facts not present in the chunk.
5. If the chunk is empty or contains no operational content, return {"claims": []}.
6. Output MUST be strictly raw JSON matching the schema. Do NOT wrap in markdown code blocks.
`;

const USER_PROMPT_TEMPLATE = `
Extract atomic operational claims from the chunk below.

CHUNK CONTENT:
"""
${'${CHUNK}'}
"""

Return JSON matching this schema:
{
  "claims": [
    {
      "claim_text": "string — the atomic claim",
      "claim_type": "operational | policy | process | decision | configuration",
      "confidence": number between 0 and 1,
      "char_start": number — 0-based offset into the chunk content,
      "char_end": number — 0-based offset into the chunk content
    }
  ]
}`;

/**
 * Extracts claims from a single chunk via the LLM, schema-validated.
 * Throws (schema-validation semantics) when the LLM output is malformed —
 * never returns fabricated claims.
 */
export async function extractClaimsFromChunk(
  chunk: TextChunk,
  opts: { workspaceId?: string; source?: string }
): Promise<ExtractedClaim[]> {
  const content = chunk.content;
  const userPrompt = USER_PROMPT_TEMPLATE.replace('${CHUNK}', () => content);

  const rawText = await generateText(userPrompt, SYSTEM_PROMPT, {
    workspaceId: opts.workspaceId,
    purpose: 'claim_extraction',
  });

  if (!rawText) {
    throw new Error('Empty response from AI Provider during claim extraction.');
  }

  const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanJson);
  } catch (jsonErr) {
    throw new Error(`Invalid JSON output from LLM during claim extraction: ${(jsonErr as Error).message}`);
  }

  const validated = CLAIM_SCHEMA.parse(parsed);

  // Grounding enforcement: evidence offsets MUST lie inside the chunk and
  // be ordered. An LLM that emits out-of-range offsets produced malformed
  // output — reject it rather than persist broken evidence.
  for (const claim of validated.claims) {
    if (claim.char_start >= claim.char_end || claim.char_end > content.length) {
      throw new Error(
        `Claim extraction failed schema validation: evidence offsets out of range (${claim.char_start}..${claim.char_end} for chunk of length ${content.length}).`
      );
    }
  }

  return validated.claims;
}

/**
 * Extracts claims for every chunk of a document. A malformed response for
 * ANY chunk fails the whole extraction (established failure semantics) —
 * partial claims are never silently kept.
 */
export async function extractClaimsFromChunks(
  chunks: TextChunk[],
  opts: { workspaceId?: string; sourceDocumentId?: string; source?: string }
): Promise<ExtractedClaim[]> {
  const all: ExtractedClaim[] = [];
  for (const chunk of chunks) {
    try {
      const claims = await extractClaimsFromChunk(chunk, { workspaceId: opts.workspaceId, source: opts.source });
      all.push(...claims);
    } catch (err) {
      logger.warn(
        `[ClaimExtractor] Failed claim extraction for chunk ${chunk.chunk_index} of document ${opts.sourceDocumentId ?? 'unknown'}:`,
        err
      );
      throw err;
    }
  }
  return all;
}
