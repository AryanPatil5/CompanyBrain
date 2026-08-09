import { installHarness } from '../harness/index.js';
import { validateTriple, compileAndValidateTriples, type GraphTriple } from '../../src/services/graph/ontologyCompiler.js';

export async function runOntologyCompilerTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Ontology Compiler Test Suite          ');
  console.log('=================================================');

  const validTriple: GraphTriple = {
    subject: 'sop_slow_query',
    subjectType: 'SOP',
    predicate: 'TARGETS_SYSTEM',
    object: 'sys_postgres_primary',
    objectType: 'System',
  };

  const invalidTypeTriple: GraphTriple = {
    subject: 'item_123',
    subjectType: 'UnknownType' as any,
    predicate: 'DEPENDS_ON',
    object: 'sys_stripe',
    objectType: 'System',
  };

  const invalidPredicateTriple: GraphTriple = {
    subject: 'sop_refund',
    subjectType: 'SOP',
    predicate: 'INVALID_EDGE',
    object: 'role_admin',
    objectType: 'Role',
  };

  // 1. Validate Valid Triple
  const vRes = validateTriple(validTriple);
  if (!vRes.valid) {
    console.error('❌ ONTOLOGY TEST FAILED: Valid triple failed validation!', vRes.reason);
    return false;
  }
  console.log('✅ ONTOLOGY TEST PASSED: Compliant GraphTriple validated successfully.');

  // 2. Validate Invalid Types & Relationships
  const invRes1 = validateTriple(invalidTypeTriple);
  const invRes2 = validateTriple(invalidPredicateTriple);

  if (invRes1.valid || invRes2.valid) {
    console.error('❌ ONTOLOGY TEST FAILED: Invalid triples passed validation!');
    return false;
  }
  console.log('✅ ONTOLOGY TEST PASSED: Non-compliant node types & predicates correctly rejected.');

  // 3. Batch Compilation Test
  const batch = compileAndValidateTriples([validTriple, invalidTypeTriple, invalidPredicateTriple]);
  if (batch.validTriples.length !== 1 || batch.rejectedTriples.length !== 2) {
    console.error('❌ ONTOLOGY TEST FAILED: Batch triple compilation count mismatch!', batch);
    return false;
  }

  console.log('✅ ONTOLOGY TEST PASSED: Batch triple compiler successfully separated 1 valid and 2 rejected triples.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOntologyCompilerTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
