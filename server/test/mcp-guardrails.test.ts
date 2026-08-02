import { authenticateMcpToken } from '../src/services/mcp.js';
import { dispatchStepExecution } from '../src/services/integrations/http_adapters.js';
import { supabase } from '../src/config/supabase.js';

async function runMcpGuardrailsTestSuite() {
  console.log("================================================");
  console.log("  Running MCP Guardrails & Security Test Suite  ");
  console.log("================================================");

  let passed = 0;
  let failed = 0;

  // ─── Test 1: Unauthenticated FastMCP Token Rejection ───
  try {
    const unauthSession = await authenticateMcpToken('invalid-fake-token-999');
    if (!unauthSession.authenticated && unauthSession.trustRole === 'low_trust') {
      console.log("✅ TEST 1 PASSED: Unauthenticated FastMCP token rejected.");
      passed++;
    } else {
      console.error("❌ TEST 1 FAILED: Unauthenticated token allowed!");
      failed++;
    }
  } catch (err) {
    console.error("❌ TEST 1 EXCEPTION:", err);
    failed++;
  }

  // ─── Test 2: Valid Session Token Role Derivation ───
  try {
    const adminSession = await authenticateMcpToken('mcp-admin-key-99');
    const lowTrustSession = await authenticateMcpToken('mcp-lowtrust-key-01');

    if (adminSession.authenticated && adminSession.trustRole === 'admin' && lowTrustSession.trustRole === 'low_trust') {
      console.log("✅ TEST 2 PASSED: Server session role derivation bound correctly to token.");
      passed++;
    } else {
      console.error("❌ TEST 2 FAILED: Role derivation mismatch.");
      failed++;
    }
  } catch (err) {
    console.error("❌ TEST 2 EXCEPTION:", err);
    failed++;
  }

  // ─── Test 3: Production Credential Gating & Adapters ───
  try {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const prodRes = await dispatchStepExecution('slack', {}, { text: 'prod test' }, 'vault:non_existent_token');
    process.env.NODE_ENV = origEnv;

    if (!prodRes.success && prodRes.error === 'Credential not configured') {
      console.log("✅ TEST 3 PASSED: Missing credentials in production fail closed with 'Credential not configured'.");
      passed++;
    } else {
      console.error("❌ TEST 3 FAILED: Production credential fallback error:", prodRes);
      failed++;
    }
  } catch (err) {
    console.error("❌ TEST 3 EXCEPTION:", err);
    failed++;
  }

  // ─── Test 4: Postgres Strict Template Allow-List Rejection ───
  try {
    const forbiddenSqlRes = await dispatchStepExecution('postgres', {}, { template_key: 'DROP_ALL_TABLES' });
    if (!forbiddenSqlRes.success && forbiddenSqlRes.error?.includes('not in strict Postgres template allow-list')) {
      console.log("✅ TEST 4 PASSED: Postgres adapter rejected arbitrary SQL query outside template allow-list.");
      passed++;
    } else {
      console.error("❌ TEST 4 FAILED: Arbitrary SQL query allowed!", forbiddenSqlRes);
      failed++;
    }
  } catch (err) {
    console.error("❌ TEST 4 EXCEPTION:", err);
    failed++;
  }

  // ─── Test 5: Un-adapted System Safe Rejection ───
  try {
    const unadaptedRes = await dispatchStepExecution('vault', {}, {});
    if (!unadaptedRes.success && unadaptedRes.error?.includes('No adapter configured for target_system')) {
      console.log("✅ TEST 5 PASSED: Un-adapted target system 'vault' safely rejected.");
      passed++;
    } else {
      console.error("❌ TEST 5 FAILED: Un-adapted target system allowed!", unadaptedRes);
      failed++;
    }
  } catch (err) {
    console.error("❌ TEST 5 EXCEPTION:", err);
    failed++;
  }

  console.log("------------------------------------------------");
  console.log(`Test Suite Summary: ${passed} Passed, ${failed} Failed.`);
  console.log("================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runMcpGuardrailsTestSuite();
