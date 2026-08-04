import { openfgaClientManager } from '../../src/services/security/openfgaClient.js';
import { searchVectorContextDLAC } from '../../src/services/embeddings.js';

export async function runDlacVectorSearchTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running DLAC OpenFGA HNSW Vector Search Test ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';
  const userIdMember = 'user_restricted_member';
  const userIdAdmin = 'user_admin_01';

  // Seed ReBAC tuples for restricted member
  const accessibleDocId = 'doc_public_onboarding_guide';
  const restrictedDocId = 'doc_secret_financial_payroll';

  await openfgaClientManager.writeTuple({
    user: `user:${userIdMember}`,
    relation: 'viewer',
    object: `document:${accessibleDocId}`,
  });

  // Test 1: Fetch OpenFGA user accessible document IDs for restricted member
  try {
    const memberDocIds = await openfgaClientManager.getUserAccessibleDocumentIds(userIdMember, workspaceId, 'member');
    if (!Array.isArray(memberDocIds) || !memberDocIds.includes(accessibleDocId) || memberDocIds.includes(restrictedDocId)) {
      console.error('❌ DLAC VECTOR TEST FAILED: OpenFGA accessible document IDs mismatch!', memberDocIds);
      return false;
    }
    console.log(`✅ DLAC VECTOR TEST PASSED: Member role retrieved exact authorized document IDs (${memberDocIds.join(', ')}).`);
  } catch (err: any) {
    console.error('❌ DLAC VECTOR TEST EXCEPTION (Member Doc IDs):', err.message);
    return false;
  }

  // Test 2: Admin role returns null (unrestricted access)
  try {
    const adminDocIds = await openfgaClientManager.getUserAccessibleDocumentIds(userIdAdmin, workspaceId, 'admin');
    if (adminDocIds !== null) {
      console.error('❌ DLAC VECTOR TEST FAILED: Admin role was incorrectly restricted!', adminDocIds);
      return false;
    }
    console.log('✅ DLAC VECTOR TEST PASSED: Admin role correctly granted unrestricted access (null filter).');
  } catch (err: any) {
    console.error('❌ DLAC VECTOR TEST EXCEPTION (Admin Access):', err.message);
    return false;
  }

  // Test 3: DLAC HNSW vector search pre-filtering prevents data leaks
  try {
    const mockVector = new Array(1536).fill(0.01);
    const memberDocIds = await openfgaClientManager.getUserAccessibleDocumentIds(userIdMember, workspaceId, 'member');

    const results = await searchVectorContextDLAC({
      queryEmbedding: mockVector,
      workspaceId,
      userId: userIdMember,
      role: 'member',
      allowedDocIds: memberDocIds,
      matchCount: 10,
    });

    const containsLeakedRestrictedDoc = results.some((r) => r.id === restrictedDocId || r.source_document_id === restrictedDocId);
    if (containsLeakedRestrictedDoc) {
      console.error('❌ DLAC VECTOR TEST FAILED: Vector search returned chunks from unauthorized document!', results);
      return false;
    }

    console.log('✅ DLAC VECTOR TEST PASSED: Pre-filtered HNSW vector search returned zero chunks from unauthorized documents.');
  } catch (err: any) {
    console.error('❌ DLAC VECTOR TEST EXCEPTION (Pre-filtered Vector Search):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDlacVectorSearchTest().then((success) => {
    if (!success) process.exit(1);
  });
}
