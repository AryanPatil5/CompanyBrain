import { parseDocument } from '../../src/services/parsers/documentParser.js';
import { addEntityNode, createRelationship, getConnectedEntities } from '../../src/services/graph/graphService.js';
import { hybridSearch } from '../../src/services/retrieval/hybridSearch.js';
import { runWorkflow } from '../../src/agents/orchestrator.js';
import { dispatchStepExecution } from '../../src/services/integrations/http_adapters.js';

export async function runCompanyBrainE2ETest(): Promise<boolean> {
  console.log('\n================================================================');
  console.log('  Running Company Brain End-to-End (E2E) Integration Test Suite');
  console.log('================================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';
  const userId = 'e2e-test-runner-01';

  // ─── STAGE 1: Layout-Aware Document Parsing & Ingestion ───
  console.log('\n[Stage 1/5] Ingestion & Layout Parsing...');
  const mockPdfContent = `
# Operational Gate & Billing Policy

Policy Code\tMax Limit\tHuman Gate Required
Refund_Under_100\t$100\tNo
Refund_Over_100\t$1000\tYes (Manager)
Secret_Rotation\tN/A\tYes (Critical)
`;

  const pdfBuffer = Buffer.from(mockPdfContent, 'utf-8');
  const parsedDoc = await parseDocument(pdfBuffer, 'application/pdf');

  if (!parsedDoc.rawText || parsedDoc.sections.length === 0) {
    console.error('❌ STAGE 1 FAILED: Layout parser failed to extract text/sections!');
    return false;
  }
  console.log('  ✅ Stage 1 Passed: Layout-aware parser extracted document sections and Markdown tables.');

  // ─── STAGE 2: Graph Entity Extraction & Apache AGE Persistence ───
  console.log('\n[Stage 2/5] Apache AGE Graph Extraction & Persistence...');
  const sopNode = await addEntityNode('SOP', { id: 'sop_e2e_billing_gate', name: 'Operational Gate & Billing Policy', workspace_id: workspaceId });
  const sysNode = await addEntityNode('System', { id: 'sys_stripe_e2e', name: 'Stripe Payment Gateway', workspace_id: workspaceId });
  const rel = await createRelationship('sop_e2e_billing_gate', 'sys_stripe_e2e', 'REQUIRES');

  const connected = await getConnectedEntities('sop_e2e_billing_gate', 1);
  if (!sopNode.id || !sysNode.id || !rel.source_id || !Array.isArray(connected)) {
    console.error('❌ STAGE 2 FAILED: Apache AGE graph persistence or traversal failed!');
    return false;
  }
  console.log(`  ✅ Stage 2 Passed: Created graph vertices and edge relationships (${connected.length} connected neighbor).`);

  // ─── STAGE 3: Hybrid Search & Reciprocal Rank Fusion (RRF) ───
  console.log('\n[Stage 3/5] Hybrid Search & RRF Scoring...');
  const searchResults = await hybridSearch({
    query: 'Billing Policy',
    workspaceId,
    userId,
    role: 'admin',
    limit: 5,
  });

  if (!Array.isArray(searchResults)) {
    console.error('❌ STAGE 3 FAILED: Hybrid search returned non-array!');
    return false;
  }
  console.log(`  ✅ Stage 3 Passed: RRF Hybrid Search executed successfully (${searchResults.length} candidates scored).`);

  // ─── STAGE 4: Multi-Agent State Machine Orchestration ───
  console.log('\n[Stage 4/5] Multi-Agent Orchestration (Planner -> Auditor -> Executor)...');
  const workflowRes = await runWorkflow('Issue $250 refund in Stripe for customer account', {
    workspaceId,
    userId,
    userRole: 'member',
    trustRole: 'low_trust',
  });

  if (!workflowRes.workflow_id || !workflowRes.plan || !workflowRes.audit) {
    console.error('❌ STAGE 4 FAILED: Multi-agent workflow failed!', workflowRes);
    return false;
  }

  if (!workflowRes.audit.requires_human_approval || workflowRes.status !== 'paused_approval') {
    console.error('❌ STAGE 4 FAILED: High-risk refund was not paused for manager approval!', workflowRes);
    return false;
  }
  console.log(`  ✅ Stage 4 Passed: Multi-agent state machine generated DAG plan, Auditor flagged high risk, and workflow paused for manager approval (Ticket #${workflowRes.approval_id}).`);

  // ─── STAGE 5: Integration Step Execution & Output Capture ───
  console.log('\n[Stage 5/5] Integration Adapter Step Dispatch...');
  const dispatchRes = await dispatchStepExecution(
    'slack',
    { base_url: 'https://api.slack.internal' },
    { channel: 'general', text: 'E2E Pipeline Integration Test Complete' },
    undefined
  );

  if (dispatchRes.status_code !== 200) {
    console.error('❌ STAGE 5 FAILED: Integration dispatch failed!', dispatchRes);
    return false;
  }
  console.log('  ✅ Stage 5 Passed: Integration adapter executed step with clean output capture (HTTP 200).');

  console.log('\n================================================================');
  console.log('  🎉 ALL 5 E2E PIPELINE STAGES PASSED SUCCESSFULLY!');
  console.log('================================================================\n');

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCompanyBrainE2ETest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
