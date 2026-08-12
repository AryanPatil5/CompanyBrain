// Hermetic unit tests for the Phase 3 claim extractor (ADR-T15).
// Deterministic LLM via the harness fetch router's judgeClaims branch —
// schema-validated atomic claims grounded in the real chunk content.

process.env.AI_PROVIDER_PRIORITY = 'ollama';
process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
process.env.GEMINI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.AI_PROVIDER_MAX_RETRIES = '2';
process.env.AI_PROVIDER_RETRY_BASE_MS = '1';
process.env.AI_PROVIDER_STAGGER_MS = '1';
process.env.AI_TIMEOUT_MS = '2000';

import { installHarness } from '../harness/index.js';
import {
  extractClaimsFromChunk,
  extractClaimsFromChunks,
  ExtractedClaimSchema,
} from '../../src/knowledge/claimExtractor.js';
import { hashContent, TextChunk } from '../../src/ingestion/chunker.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ CLAIM-EXTRACTOR TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ CLAIM-EXTRACTOR TEST FAILED: ${name}`, extra ?? '');
  }
}

const makeChunk = (content: string, index = 0): TextChunk => ({
  chunk_index: index,
  content,
  content_hash: hashContent(content),
  token_count_estimate: Math.max(1, Math.ceil(content.length / 4)),
  metadata: {},
});

/** Overrides fetch for a single test; ALWAYS restores before returning. */
async function withFetch(
  handler: (input: unknown, init?: unknown) => Promise<Response>,
  fn: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => handler(input, init)) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const ollamaGenerate = (responseText: string): Response =>
  jsonResponse({
    model: 'llama3.2:3b',
    response: responseText,
    done: true,
    prompt_eval_count: 10,
    eval_count: 20,
  });

/** Routes /api/generate through the canned handler, everything else errors. */
const fetchWithGenerate = (generate: (prompt: string) => Response) => {
  return async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/generate')) {
      let prompt = '';
      try {
        const body = (init as RequestInit)?.body ? JSON.parse(String((init as RequestInit).body)) : {};
        prompt = String(body.prompt ?? '');
      } catch {
        // fall through to canned response below
      }
      return generate(prompt);
    }
    return jsonResponse({ error: 'unexpected url' }, 404);
  };
};

const CHUNK_SENTENCE =
  'All production deployments require a two-person approval before the change is merged into the main branch.';

async function testHappyPathGroundedClaims(): Promise<boolean> {
  const chunk = makeChunk(`\n\n${CHUNK_SENTENCE}\nAdditional operational detail for the evidence span test.\n`);
  const claims = await extractClaimsFromChunk(chunk, { workspaceId: 'ws-claim-1', source: 'unit-test' });
  check('extracts exactly one claim', claims.length === 1);
  const claim = claims[0];
  check('claim schema validates', ExtractedClaimSchema.safeParse(claim).success);
  check('claim text length >= 10', claim.claim_text.length >= 10);
  check('claim type defaults to operational', claim.claim_type === 'operational');
  check('confidence in range', claim.confidence >= 0 && claim.confidence <= 1);
  check('char_start >= 0', claim.char_start >= 0);
  check('char_end <= chunk length', claim.char_end <= chunk.content.length);
  check('offsets ordered', claim.char_start < claim.char_end);
  check(
    'evidence span equals claim text (grounded in chunk content)',
    chunk.content.slice(claim.char_start, claim.char_end) === claim.claim_text,
    { start: claim.char_start, end: claim.char_end, text: claim.claim_text }
  );
  return success;
}

async function testEmptyChunkYieldsNoClaims(): Promise<boolean> {
  const claims = await extractClaimsFromChunk(makeChunk('   \n  \t '), {});
  check('empty chunk -> no claims', claims.length === 0);
  return success;
}

async function testShortChunkYieldsNoClaims(): Promise<boolean> {
  const claims = await extractClaimsFromChunk(makeChunk('Hi.'), {});
  check('too-short chunk -> no claims', claims.length === 0);
  return success;
}

async function testMarkdownFencedJsonIsAccepted(): Promise<boolean> {
  const fencedChunk = 'The deploy gate requires two approvals before merge.';
  const good = JSON.stringify({
    claims: [
      {
        claim_text: 'The deploy gate requires two approvals before merge.',
        claim_type: 'process',
        confidence: 0.85,
        char_start: 0,
        char_end: fencedChunk.length,
      },
    ],
  });
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate(`\`\`\`json\n${good}\n\`\`\``)),
    async () => {
      const claims = await extractClaimsFromChunk(makeChunk(fencedChunk), {});
      check('fenced JSON parsed', claims.length === 1 && claims[0].claim_text.includes('deploy gate'));
    }
  );
  return success;
}

async function testMalformedJsonThrows(): Promise<boolean> {
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate('this is not json at all')),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        threw = String((err as Error).message).includes('Invalid JSON output');
      }
    }
  );
  check('malformed LLM JSON throws schema-validation error', threw);
  return success;
}

async function testNonJsonDefaultResponseThrows(): Promise<boolean> {
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate('Deterministic test response.')),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        threw = String((err as Error).message).includes('Invalid JSON output');
      }
    }
  );
  check('canned non-JSON response throws', threw);
  return success;
}

async function testEmptyResponseThrows(): Promise<boolean> {
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate('')),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        // The provider layer surfaces its own empty-response error before the
        // extractor's guard; either message means malformed output is rejected.
        threw = String((err as Error).message).toLowerCase().includes('empty response');
      }
    }
  );
  check('empty LLM response throws', threw);
  return success;
}

async function testOutOfRangeOffsetsThrow(): Promise<boolean> {
  const outOfRange = JSON.stringify({
    claims: [
      {
        claim_text: 'A claim whose evidence points outside the chunk entirely.',
        claim_type: 'operational',
        confidence: 0.9,
        char_start: 0,
        char_end: 99999,
      },
    ],
  });
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate(outOfRange)),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        threw = String((err as Error).message).includes('offsets out of range');
      }
    }
  );
  check('out-of-range evidence offsets rejected', threw);
  return success;
}

async function testInvalidConfidenceThrows(): Promise<boolean> {
  const badConfidence = JSON.stringify({
    claims: [
      {
        claim_text: 'A claim with impossible confidence above one point zero.',
        claim_type: 'operational',
        confidence: 1.5,
        char_start: 0,
        char_end: 60,
      },
    ],
  });
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate(badConfidence)),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        const msg = String((err as Error).message);
        threw = msg.includes('too_big') && msg.includes('confidence');
      }
    }
  );
  check('out-of-range confidence rejected', threw);
  return success;
}

async function testTooManyClaimsThrows(): Promise<boolean> {
  const claims = Array.from({ length: 21 }, (_, i) => ({
    claim_text: `Operational claim number ${i} with enough textual length to pass validation.`,
    claim_type: 'operational',
    confidence: 0.5,
    char_start: 0,
    char_end: 30,
  }));
  let threw = false;
  await withFetch(
    fetchWithGenerate(() => ollamaGenerate(JSON.stringify({ claims }))),
    async () => {
      try {
        await extractClaimsFromChunk(makeChunk(CHUNK_SENTENCE), {});
      } catch (err) {
        threw = String((err as Error).message).includes('too_big') && String((err as Error).message).includes('at most 20');
      }
    }
  );
  check('>20 claims rejected by schema', threw);
  return success;
}

async function testBatchFailsWholeOnMalformedChunk(): Promise<boolean> {
  const firstChunkContent = 'First chunk of the document with a valid claim.';
  const good = JSON.stringify({
    claims: [
      {
        claim_text: 'First chunk of the document with a valid claim.',
        claim_type: 'process',
        confidence: 0.85,
        char_start: 0,
        char_end: firstChunkContent.length,
      },
    ],
  });
  let sawGoodChunk = false;
  let threw = false;
  await withFetch(
    fetchWithGenerate((prompt) => {
      if (prompt.includes('First chunk of the document')) {
        sawGoodChunk = true;
        return ollamaGenerate(good);
      }
      return ollamaGenerate('not valid json');
    }),
    async () => {
      try {
        await extractClaimsFromChunks(
          [makeChunk(firstChunkContent, 0), makeChunk('Second chunk.', 1)],
          { workspaceId: 'ws-batch-1', sourceDocumentId: 'doc-batch-1' }
        );
      } catch (err) {
        threw = String((err as Error).message).includes('Invalid JSON output');
      }
    }
  );
  check('good chunk was extracted', sawGoodChunk);
  check('malformed chunk fails the whole batch', threw);
  return success;
}

export async function runClaimExtractorTests(): Promise<boolean> {
  await installHarness();
  const suites: Array<() => Promise<boolean>> = [
    testHappyPathGroundedClaims,
    testEmptyChunkYieldsNoClaims,
    testShortChunkYieldsNoClaims,
    testMarkdownFencedJsonIsAccepted,
    testMalformedJsonThrows,
    testNonJsonDefaultResponseThrows,
    testEmptyResponseThrows,
    testOutOfRangeOffsetsThrow,
    testInvalidConfidenceThrows,
    testTooManyClaimsThrows,
    testBatchFailsWholeOnMalformedChunk,
  ];
  for (const suite of suites) {
    await suite();
  }
  console.log(`\n[ClaimExtractor Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runClaimExtractorTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
