import { writeTuple, checkRelationship, OpenFGATuple } from '../../src/middleware/openfgaMiddleware.js';

export async function runOpenFGATest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running OpenFGA ReBAC Authorization Engine Test');
  console.log('=================================================');

  // 1. Write relation tuple
  const tuple: OpenFGATuple = {
    user: 'user:member_01',
    relation: 'editor',
    object: 'document:sop_financial',
  };
  writeTuple(tuple);

  // 2. Check direct relation match
  const resEditor = await checkRelationship(tuple);
  if (!resEditor.allowed) {
    console.error('❌ OPENFGA TEST FAILED: Direct editor relation check failed!', resEditor);
    return false;
  }

  // 3. Check inherited viewer relation match (Editor inherits Viewer permission)
  const resViewer = await checkRelationship({
    user: 'user:member_01',
    relation: 'viewer',
    object: 'document:sop_financial',
  });
  if (!resViewer.allowed) {
    console.error('❌ OPENFGA TEST FAILED: Inherited viewer relation check failed!', resViewer);
    return false;
  }

  // 4. Check unauthorized access rejection
  const resUnauthorized = await checkRelationship({
    user: 'user:stranger_99',
    relation: 'editor',
    object: 'document:sop_financial',
  });
  if (resUnauthorized.allowed) {
    console.error('❌ OPENFGA TEST FAILED: Stranger was incorrectly allowed access!', resUnauthorized);
    return false;
  }

  console.log('✅ OPENFGA TEST PASSED: Successfully verified OpenFGA tuple checks, ReBAC relation inheritance, and access enforcement.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpenFGATest().then((success) => {
    if (!success) process.exit(1);
  });
}
