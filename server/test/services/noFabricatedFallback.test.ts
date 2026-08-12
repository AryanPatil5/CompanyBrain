// Hermetic tests for the Phase 3 "no fabricated fallback" rule in retrieval:
//
//   - skills_sops results from the sparse keyword leg (hybridSearch) and from
//     the in-memory fallback (searchVectorContextDLAC -> skills_sops) carry
//     similarity: null — NEVER a fabricated numeric score pretending to be
//     semantic similarity.
//   - REAL vector results (document_chunks cosine search) still carry real,
//     computed similarity values.
//   - RRF fusion keeps working with null similarity (ranking uses ranks).

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import { supabase } from '../../src/config/supabase.js';
import {
  searchVectorContextDLAC,
  generateEmbedding,
} from '../../src/services/embeddings.js';
import { hybridSearch } from '../../src/services/retrieval/hybridSearch.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ NO-FABRICATED-FALLBACK TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ NO-FABRICATED-FALLBACK TEST FAILED: ${name}`, extra ?? '');
  }
}

const WS = '00000000-0000-0000-0000-000000000000';
const EMBEDDING_DIM = 1536;
const QUERY_VECTOR = new Array<number>(EMBEDDING_DIM).fill(0.01);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function seedSop(id: string, title: string, trigger: string): Promise<void> {
  const { error } = await supabase.from('skills_sops').insert({
    id,
    workspace_id: WS,
    title,
    trigger_condition: trigger,
    category: 'Operations',
    risk_level: 'Low',
    requires_human_gate: false,
  });
  if (error) throw new Error(`seedSop failed: ${error.message}`);
}

async function seedChunk(id: string, content: string, embedding: number[]): Promise<void> {
  const { error } = await supabase.from('document_chunks').insert({
    id,
    workspace_id: WS,
    source_document_id: `doc-${id}`,
    content,
    metadata: { title: `Chunk ${id}` },
    embedding,
    allowed_roles: ['admin', 'member'],
  });
  if (error) throw new Error(`seedChunk failed: ${error.message}`);
}

export async function runNoFabricatedFallbackTests(): Promise<boolean> {
  await installHarness();
  // Isolation: prior suites seed document_chunks with real embeddings, which
  // would leak into the dense leg and pollute the sparse-only assertions.
  resetFakeSupabaseStore();

  try {
    // ─── 1. hybridSearch sparse-only results: similarity stays null ────────
    try {
      await seedSop('sop-incident-1', 'Incident Response Runbook', 'on-call incident is declared');
      await seedSop('sop-deploy-1', 'Deployment Approval SOP', 'production deploy requires approval');

      // Admin -> allowedDocIds null -> sparse leg permits all matches; dense
      // leg finds no chunks and its skills_sops fallback ALSO returns null
      // similarity. Whatever the leg mix, no score may be fabricated.
      const results = await hybridSearch({
        query: 'incident approval deploy',
        workspaceId: WS,
        userId: 'user-00000000-0000-0000-0000-000000000000',
        role: 'admin',
        limit: 10,
      });
      check('sparse: results returned', Array.isArray(results) && results.length >= 1, results.length);
      check(
        'sparse: every skills_sops result carries similarity null (never fabricated)',
        results.every((r) => r.similarity === null),
        results.map((r) => ({ id: r.id, similarity: r.similarity }))
      );
      check('sparse: RRF score still computed for ranking', results.every((r) => r.rrfScore > 0), results.map((r) => r.rrfScore));
    } catch (err: any) {
      check('Test 1 (hybridSearch sparse)', false, err.message);
    }

    // ─── 2. skills_sops in-memory fallback (dense-leg fallback): null ─────
    try {
      await seedSop('sop-billing-1', 'Billing Escalation SOP', 'customer disputes an invoice');
      const results = await searchVectorContextDLAC({
        queryEmbedding: QUERY_VECTOR,
        workspaceId: WS,
        userId: 'user-00000000-0000-0000-0000-000000000000',
        role: 'admin',
        allowedDocIds: null,
        matchThreshold: 0.05,
        matchCount: 10,
      });
      check('fallback: skills_sops fallback returned rows', Array.isArray(results) && results.length >= 1, results.length);
      check(
        'fallback: every skills_sops fallback row has similarity null',
        results.every((r) => r.similarity === null),
        results.map((r) => ({ id: r.id, similarity: r.similarity }))
      );
    } catch (err: any) {
      check('Test 2 (skills_sops fallback)', false, err.message);
    }

    // ─── 3. REAL vector path keeps REAL computed similarity ───────────────
    try {
      const identical = new Array<number>(EMBEDDING_DIM).fill(0.01);
      // 3/4 of the dimensions agree, 1/4 disagree -> cosine 0.5 (above the
      // 0.05 match threshold, unlike a fully orthogonal vector).
      const halfMatch = new Array<number>(EMBEDDING_DIM).fill(0.01);
      for (let i = 0; i < EMBEDDING_DIM; i += 4) halfMatch[i] = -0.01;
      await seedChunk('chunk-ident', 'identical vector chunk', identical);
      await seedChunk('chunk-half', 'half-match vector chunk', halfMatch);

      const results = await searchVectorContextDLAC({
        queryEmbedding: QUERY_VECTOR,
        workspaceId: WS,
        userId: 'user-00000000-0000-0000-0000-000000000000',
        role: 'admin',
        allowedDocIds: null,
        matchThreshold: 0.05,
        matchCount: 10,
      });
      const byId = new Map(results.map((r) => [r.id, r.similarity]));
      check('real: identical embedding yields computed cosine ~1.0', byId.has('chunk-ident') && Math.abs((byId.get('chunk-ident') as number) - 1.0) < 1e-9, byId.get('chunk-ident'));
      check(
        'real: half-match embedding yields its real cosine',
        byId.has('chunk-half') && Math.abs((byId.get('chunk-half') as number) - cosine(QUERY_VECTOR, halfMatch)) < 1e-9,
        { actual: byId.get('chunk-half'), expected: cosine(QUERY_VECTOR, halfMatch) }
      );
      check(
        'real: dense results are ordered by real similarity',
        byId.has('chunk-ident') && byId.has('chunk-half') && (byId.get('chunk-ident') as number) >= (byId.get('chunk-half') as number),
        [...byId.entries()]
      );
    } catch (err: any) {
      check('Test 3 (real vector similarity)', false, err.message);
    }

    // ─── 4. Mixed hybrid: chunk gets REAL similarity, sop stays null ──────
    try {
      await seedSop('sop-mixed-1', 'Mixed Mode SOP', 'mixed retrieval mode');
      const chunkVec = new Array<number>(EMBEDDING_DIM).fill(0.01);
      await seedChunk('chunk-mixed', 'mixed retrieval chunk', chunkVec);

      const results = await hybridSearch({
        query: 'mixed retrieval',
        workspaceId: WS,
        userId: 'user-00000000-0000-0000-0000-000000000000',
        role: 'admin',
        limit: 10,
      });
      const chunkRes = results.find((r) => r.id === 'chunk-mixed');
      const sopRes = results.find((r) => r.id === 'sop-mixed-1');
      check('mixed: chunk present with real similarity', !!chunkRes && typeof chunkRes.similarity === 'number' && chunkRes.similarity > 0.9, chunkRes);
      check('mixed: sop present with similarity null', !!sopRes && sopRes.similarity === null, sopRes);
    } catch (err: any) {
      check('Test 4 (mixed hybrid)', false, err.message);
    }

    // ─── 5. Type contract: generateEmbedding still yields real vectors ────
    try {
      const vec = await generateEmbedding('whatever');
      check('embedding generation unaffected', Array.isArray(vec) && vec.length === EMBEDDING_DIM, vec?.length);
    } catch (err: any) {
      check('Test 5 (embedding contract)', false, err.message);
    }
  } catch (err: any) {
    check('No-fabricated-fallback suite ran', false, err.message);
  }

  console.log(`\n[No Fabricated Fallback Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runNoFabricatedFallbackTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
