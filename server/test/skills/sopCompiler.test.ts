import { compileSopToAst, validateSopAst } from '../../src/services/skills/sopCompiler.js';

export async function runSopCompilerTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Automated SOP AST Compiler Test Suite ');
  console.log('=================================================');

  const sampleMarkdown = `
# Customer Refund Emergency Protocol
Trigger: Customer requests refund exceeding standard tier limit.

Inputs:
- refundAmount: number (Amount to refund in USD)
- userEmail: string (Customer account email)

Steps:
1. Verify customer account status in Postgres database.
2. If refundAmount > 500, requires manager approval before processing.
3. Issue refund through Stripe billing integration.
4. Notify customer and post log to Slack channel.
  `;

  // Test 1: Should compile markdown SOP into valid executable SopAST
  try {
    const ast = await compileSopToAst(sampleMarkdown);

    if (!ast || !ast.title || !Array.isArray(ast.steps) || ast.steps.length === 0) {
      console.error('❌ SOP COMPILER TEST FAILED: AST structure is invalid!', ast);
      return false;
    }
    console.log(`✅ SOP COMPILER TEST PASSED: Successfully compiled markdown SOP into SopAST (${ast.title}).`);
  } catch (err: any) {
    console.error('❌ SOP COMPILER TEST EXCEPTION (AST Compile):', err.message);
    return false;
  }

  // Test 2: Should extract decision branches and human approval gates correctly
  try {
    const ast = await compileSopToAst(sampleMarkdown);

    const hasApprovalGate = ast.steps.some((s) => s.requiresHumanApproval);
    const hasStripeTarget = ast.steps.some((s) => s.targetSystem === 'Stripe');

    if (!hasApprovalGate) {
      console.error('❌ SOP COMPILER TEST FAILED: High refund step was not flagged for human approval!', ast.steps);
      return false;
    }
    console.log('✅ SOP COMPILER TEST PASSED: Successfully extracted decision branches and human approval gates.');
  } catch (err: any) {
    console.error('❌ SOP COMPILER TEST EXCEPTION (Gate Detection):', err.message);
    return false;
  }

  // Test 3: Should validate SopAST structure against required inputs and steps
  try {
    const ast = await compileSopToAst(sampleMarkdown);
    const validation = validateSopAst(ast);

    if (!validation.valid) {
      console.error('❌ SOP COMPILER TEST FAILED: AST validation returned invalid errors!', validation);
      return false;
    }
    console.log('✅ SOP COMPILER TEST PASSED: Validated compiled SopAST structure against schema requirements.');
  } catch (err: any) {
    console.error('❌ SOP COMPILER TEST EXCEPTION (Validation):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSopCompilerTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
