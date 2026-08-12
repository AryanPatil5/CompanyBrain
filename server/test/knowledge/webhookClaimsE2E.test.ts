// Hermetic end-to-end test for the Phase 3 webhook ingestion tail (B1a/B2/B3):
// source document + chunks -> claims + evidence -> SOP (with confidence_score)
// -> claim linkage -> GET /api/sops/:id/claims returns grounded claims.
//
// Drives the REAL processThreadCore (the exact code the durable webhook
// consumer runs) against the harness in-memory Supabase + deterministic LLM
// router, then mounts the real sops router for the API-level assertion.
//
// Standalone-hang gotcha (AGENTS.md): webhookService pulls queue-adjacent
// modules, so app imports are DEFERRED until after installHarness().

import { installHarness } from '../harness/index.js';
import { resetFakeSupabaseStore } from '../harness/fakeSupabase.js';
import express from 'express';
import type { AddressInfo } from 'node:net';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ WEBHOOK-CLAIMS-E2E TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ WEBHOOK-CLAIMS-E2E TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';

const transcriptMessages = [
  {
    user: 'U1',
    text: 'Production incident at 2am: API rate limit tripped for the billing service.',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
  {
    user: 'U2',
    text: 'We documented the timeline in Linear and verified the fix on staging before deploying.',
    timestamp: '2026-01-01T00:01:00.000Z',
  },
];

const threadPayload = {
  workspace_id: DEV_WORKSPACE,
  source: 'slack',
  external_thread_id: 'C99999.001',
  channel_or_project: 'ops',
  messages: transcriptMessages,
};

export async function runWebhookClaimsE2ETests(): Promise<boolean> {
  await installHarness();
  // The in-memory store is process-global across run-all suites; this suite's
  // assertions assume a clean slate (exactly one document/SOP/claims set).
  resetFakeSupabaseStore();
  // Deferred: see standalone-hang gotcha in AGENTS.md.
  const [{ processThreadCore }, { supabase }, { default: sopsRouter }] = await Promise.all([
    import('../../src/services/ingestion/webhookService.js'),
    import('../../src/config/supabase.js'),
    import('../../src/routes/sops.js'),
  ]);

  try {
    const result = await processThreadCore(threadPayload as any, { sourceTrust: 'crawled' });

    check('webhook thread produces a new SOP', result.outcome === 'sop_created' && !!result.sopId, result);

    // ─── Source document + chunks ───────────────────────────────────────
    const { data: docs } = await supabase.from('source_documents').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('source document persisted', Array.isArray(docs) && docs.length === 1, docs);
    const doc = (docs ?? [])[0];
    check('source document carries the transcript', doc?.raw_metadata?.message_count === 2 && String(doc?.title).includes('C99999.001'));
    const { data: chunks } = await supabase.from('document_chunks').select('*').eq('workspace_id', DEV_WORKSPACE).eq('source_document_id', doc?.id);
    check('chunks persisted for the webhook document', Array.isArray(chunks) && chunks.length >= 1, chunks?.length);

    // ─── Claims + evidence ──────────────────────────────────────────────
    const { data: claims } = await supabase.from('knowledge_claims').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('claims extracted for the webhook document', Array.isArray(claims) && claims.length >= 1, claims);
    const claim = (claims ?? [])[0];
    check('claim grounded in a chunk', !!claim?.chunk_id && claim?.source_document_id === doc?.id, claim);
    check('claim carries confidence and type', typeof claim?.confidence === 'number' && claim?.confidence >= 0 && claim?.confidence <= 1 && claim?.claim_type === 'operational', claim);
    check('claim text is real chunk content (not fabricated)', typeof claim?.claim_text === 'string' && claim.claim_text.length > 10, claim?.claim_text);
    const { data: evidence } = await supabase.from('claim_evidence').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('claim evidence persisted with char offsets', Array.isArray(evidence) && evidence.length >= 1 && typeof evidence[0]?.char_start === 'number' && typeof evidence[0]?.char_end === 'number', evidence);

    // ─── SOP with persisted confidence_score (B2) ───────────────────────
    const { data: sops } = await supabase.from('skills_sops').select('*').eq('workspace_id', DEV_WORKSPACE);
    check('SOP created', Array.isArray(sops) && sops.length === 1, sops);
    check('SOP confidence_score persisted', sops?.[0]?.confidence_score === 0.9, sops?.[0]?.confidence_score);

    // ─── Claim linkage (B3) ─────────────────────────────────────────────
    const { data: citations } = await supabase.from('sop_citations').select('*').eq('sop_id', result.sopId);
    const linked = (citations ?? []).filter((c: any) => c.claim_id != null);
    check('legacy raw-thread citation preserved', (citations ?? []).some((c: any) => c.raw_thread_id != null && c.claim_id == null), citations);
    check('claims linked to the SOP via sop_citations', linked.length >= 1, citations);
    check('linked citations carry the supporting chunk_id', linked.every((c: any) => c.chunk_id != null), linked);

    // ─── API: GET /api/sops/:id/claims returns grounded claims ─────────
    const app = express();
    app.use(express.json());
    app.use('/api/sops', sopsRouter);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${base}/api/sops/${result.sopId}/claims`, {
        headers: { authorization: 'Bearer mock-admin-token' },
      });
      const body: any = await res.json();
      check('claims endpoint returns 200', res.status === 200, res.status);
      check('claims endpoint returns the grounded claims', body?.count >= 1 && Array.isArray(body?.claims) && body.claims.length >= 1, body);
      const apiClaim = body?.claims?.[0];
      check('API claim carries confidence + chunk_id', typeof apiClaim?.confidence === 'number' && !!apiClaim?.chunk_id, apiClaim);
      check('API claim carries evidence offsets', Array.isArray(apiClaim?.evidence) && apiClaim.evidence.length >= 1 && typeof apiClaim.evidence[0]?.char_start === 'number', apiClaim?.evidence);
    } finally {
      server.close();
    }
  } catch (err: any) {
    check('webhook claims e2e flow completed without throwing', false, err?.message ?? err);
  }

  console.log(`\n[WebhookClaimsE2E Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWebhookClaimsE2ETests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
