// Hermetic end-to-end test for the Phase 3 crawler ingestion tail (B1b):
// the legacy crawlers now funnel through the SAME provider-agnostic thread
// tail as durable webhooks — source document + chunks -> claims + evidence
// -> SOP (with confidence_score) -> claim linkage -> dedupe.
//
// Drives the REAL crawlDatabaseLogs (the exact code the crawler process
// runs) against the harness in-memory Supabase + deterministic LLM router.
// The database crawler is fully self-contained (no external provider API),
// which is why it is the canonical hermetic crawler-path test.
//
// Standalone-hang gotcha (AGENTS.md): crawler modules pull documentPipeline
// (queue-adjacent), so app imports are DEFERRED until after installHarness().

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ CRAWLER-CLAIMS-E2E TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ CRAWLER-CLAIMS-E2E TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';

export async function runCrawlerClaimsE2ETests(): Promise<boolean> {
  await installHarness();
  // Clean slate: this suite's assertions assume exactly 2 docs / 2 SOPs /
  // one claims set per document.
  resetFakeSupabaseStore();
  // Deferred: see standalone-hang gotcha in AGENTS.md.
  const [{ crawlDatabaseLogs }, { supabase }] = await Promise.all([
    import('../../src/services/crawlers/database.js'),
    import('../../src/config/supabase.js'),
  ]);

  try {
    const result = await crawlDatabaseLogs('hermetic_test_db', DEV_WORKSPACE);

    // ─── Crawl result ───────────────────────────────────────────────────
    check('database crawler reports success', result.status === 'success', result);
    check('database crawler processed both routines', result.queries_crawled === 2, result);
    check('database crawler extracted two SOPs', result.sops_extracted === 2, result);

    // ─── Source document + chunks (crawler path now persists them) ──────
    const { data: docs } = await supabase.from('source_documents').select('*').eq('workspace_id', DEV_WORKSPACE);
    const dbDocs = (docs ?? []).filter((d: any) => d.source === 'database');
    check('crawler persisted a source document per routine', Array.isArray(dbDocs) && dbDocs.length === 2, docs);
    check('crawler documents carry title + transcript metadata', dbDocs.every((d: any) => String(d.title).startsWith('database:') && d.raw_metadata?.message_count === 1 && d.raw_metadata?.source_trust === 'crawled'), dbDocs);
    const { data: chunks } = await supabase.from('document_chunks').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('crawler documents chunked', Array.isArray(chunks) && chunks.length >= 2, chunks?.length);
    check('every chunk belongs to a crawler document', (chunks ?? []).every((c: any) => dbDocs.some((d: any) => d.id === c.source_document_id)), chunks);

    // ─── Claims + evidence ──────────────────────────────────────────────
    const { data: claims } = await supabase.from('knowledge_claims').select('*').eq('workspace_id', DEV_WORKSPACE);
    const dbClaims = (claims ?? []).filter((c: any) => dbDocs.some((d: any) => d.id === c.source_document_id));
    check('claims extracted for crawler documents', dbClaims.length >= 2, claims);
    check('claims grounded in chunks of crawler documents', dbClaims.every((c: any) => !!c.chunk_id && c.claim_type === 'operational' && typeof c.confidence === 'number'), dbClaims);
    const { data: evidence } = await supabase.from('claim_evidence').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('claim evidence persisted with char offsets', Array.isArray(evidence) && evidence.length >= 1 && typeof evidence[0]?.char_start === 'number' && typeof evidence[0]?.char_end === 'number', evidence);

    // ─── SOP with persisted confidence_score (B2 via crawler) ───────────
    const { data: sops } = await supabase.from('skills_sops').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('crawler created two SOPs', Array.isArray(sops) && sops.length === 2, sops);
    check('crawler SOPs carry confidence_score', (sops ?? []).every((s: any) => s.confidence_score === 0.9 && s.status === 'Draft'), sops);

    // ─── Claim linkage (B3 via crawler) ─────────────────────────────────
    const { data: citations } = await supabase.from('sop_citations').select('*');
    const sopIds = new Set((sops ?? []).map((s: any) => s.id));
    const linked = (citations ?? []).filter((c: any) => c.claim_id != null && sopIds.has(c.sop_id));
    check('crawler SOPs linked to claims via sop_citations', linked.length >= 2, citations);
    check('crawler-linked citations carry the supporting chunk_id', linked.every((c: any) => c.chunk_id != null), linked);
    const linkedSopIds = new Set(linked.map((c: any) => c.sop_id));
    check('both crawler SOPs grounded in claims', linkedSopIds.size === 2, linkedSopIds);

    // ─── Dedupe: second crawl is a no-op ────────────────────────────────
    const second = await crawlDatabaseLogs('hermetic_test_db', DEV_WORKSPACE);
    check('second crawl is deduped (0 queries, 0 SOPs)', second.queries_crawled === 0 && second.sops_extracted === 0, second);
  } catch (err: any) {
    check('crawler claims e2e flow completed without throwing', false, err?.message ?? err);
  }

  console.log(`\n[CrawlerClaimsE2E Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCrawlerClaimsE2ETests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
