// Hermetic route tests for GET /api/sops/:id/claims (Phase 3, ADR-T15).
// Mounts the real sops router with the harness in-memory Supabase and the
// established mock-token auth (Bearer mock-admin-token = admin, DEV_WORKSPACE).

import { installHarness } from '../harness/index.js';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { supabase } from '../../src/config/supabase.js';
import sopsRouter from '../../src/routes/sops.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ SOP-CLAIMS ROUTE TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ SOP-CLAIMS ROUTE TEST FAILED: ${name}`, extra ?? '');
  }
}

const DEV_WORKSPACE = '00000000-0000-0000-0000-000000000000';
const OTHER_WORKSPACE = '11111111-1111-1111-1111-111111111111';

async function seedRouteData(): Promise<void> {
  // SOPs across two workspaces
  await supabase.from('skills_sops').insert([
    { id: 'sop-claims-1', workspace_id: DEV_WORKSPACE, title: 'Deploy Runbook', status: 'Draft' },
    { id: 'sop-claims-other', workspace_id: OTHER_WORKSPACE, title: 'Foreign SOP', status: 'Draft' },
  ]);

  // Citations: sop-claims-1 linked to two claims (one with evidence), plus a
  // legacy NULL-claim citation that must be ignored.
  await supabase.from('sop_citations').insert([
    { sop_id: 'sop-claims-1', raw_thread_id: 'thread-legacy' },
    { sop_id: 'sop-claims-1', claim_id: 'claim-hi' },
    { sop_id: 'sop-claims-1', claim_id: 'claim-lo' },
  ]);

  await supabase.from('knowledge_claims').insert([
    { id: 'claim-hi', workspace_id: DEV_WORKSPACE, source_document_id: 'doc-1', chunk_id: 'chunk-1', claim_text: 'The deploy gate requires two approvals before merge.', claim_text_hash: 'h-hi', claim_type: 'process', confidence: 0.95, status: 'draft', ai_generated: true },
    { id: 'claim-lo', workspace_id: DEV_WORKSPACE, source_document_id: 'doc-1', chunk_id: 'chunk-2', claim_text: 'Rollbacks should be tested on staging first.', claim_text_hash: 'h-lo', claim_type: 'policy', confidence: 0.6, status: 'draft', ai_generated: true },
    { id: 'claim-foreign', workspace_id: OTHER_WORKSPACE, source_document_id: 'doc-x', chunk_id: 'chunk-x', claim_text: 'Foreign workspace claim must never leak.', claim_text_hash: 'h-x', claim_type: 'operational', confidence: 0.99, status: 'draft', ai_generated: true },
  ]);

  await supabase.from('claim_evidence').insert([
    { id: 'ev-1', workspace_id: DEV_WORKSPACE, claim_id: 'claim-hi', chunk_id: 'chunk-1', char_start: 0, char_end: 55, source_document_id: 'doc-1', provenance_json: {} },
    { id: 'ev-foreign', workspace_id: OTHER_WORKSPACE, claim_id: 'claim-foreign', chunk_id: 'chunk-x', char_start: 0, char_end: 10, source_document_id: 'doc-x', provenance_json: {} },
  ]);
}

export async function runSopClaimsRouteTests(): Promise<boolean> {
  await installHarness();
  await seedRouteData();

  const app = express();
  app.use(express.json());
  app.use('/api/sops', sopsRouter);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ─── 1. Own-workspace SOP: claims + evidence grouped ───────────────
    const own = await fetch(`${base}/api/sops/sop-claims-1/claims`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    const ownBody: any = await own.json();
    check('own-workspace SOP returns 200', own.status === 200, own.status);
    check('claims grouped with evidence', ownBody.count === 2 && ownBody.claims.length === 2, ownBody);
    const hi = ownBody.claims.find((c: any) => c.id === 'claim-hi');
    const lo = ownBody.claims.find((c: any) => c.id === 'claim-lo');
    check('claim fields serialized', hi?.claim_text === 'The deploy gate requires two approvals before merge.' && hi?.claim_type === 'process' && hi?.confidence === 0.95, hi);
    check('claim-hi has its evidence row', Array.isArray(hi?.evidence) && hi.evidence.length === 1 && hi.evidence[0].char_start === 0 && hi.evidence[0].char_end === 55, hi?.evidence);
    check('claim-lo has empty evidence list', Array.isArray(lo?.evidence) && lo.evidence.length === 0, lo?.evidence);
    check('claims confidence-ordered (hi first)', ownBody.claims[0].id === 'claim-hi');
    check('foreign claim never leaked', !ownBody.claims.some((c: any) => c.id === 'claim-foreign'));
    check('legacy NULL-claim citation ignored', !ownBody.claims.some((c: any) => c.id == null));

    // ─── 2. Cross-workspace SOP → 403 ───────────────────────────────────
    const cross = await fetch(`${base}/api/sops/sop-claims-other/claims`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    check('foreign-workspace SOP returns 403', cross.status === 403, cross.status);

    // ─── 3. Unknown SOP → 404 ───────────────────────────────────────────
    const missing = await fetch(`${base}/api/sops/sop-does-not-exist/claims`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    check('unknown SOP returns 404', missing.status === 404, missing.status);

    // ─── 4. Unauthenticated → 401 ───────────────────────────────────────
    const unauth = await fetch(`${base}/api/sops/sop-claims-1/claims`);
    check('unauthenticated request returns 401', unauth.status === 401, unauth.status);

    // ─── 5. SOP without claim links → empty list ────────────────────────
    await supabase.from('skills_sops').insert([
      { id: 'sop-unlinked', workspace_id: DEV_WORKSPACE, title: 'Unlinked', status: 'Draft' },
    ]);
    const empty = await fetch(`${base}/api/sops/sop-unlinked/claims`, {
      headers: { authorization: 'Bearer mock-admin-token' },
    });
    const emptyBody: any = await empty.json();
    check('unlinked SOP returns 200 with empty claims', empty.status === 200 && Array.isArray(emptyBody.claims) && emptyBody.claims.length === 0, emptyBody);
  } finally {
    server.close();
  }

  console.log(`\n[SopClaims Route Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSopClaimsRouteTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
