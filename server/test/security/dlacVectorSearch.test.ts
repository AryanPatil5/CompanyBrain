import { searchVectorContextDLAC, generateEmbedding } from '../../src/services/embeddings.js';

export async function runDlacVectorSearchTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running DLAC Vector Search Security Test Suite ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';
  const userMemberId = '11111111-1111-1111-1111-111111111111'; // User A: Member
  const userAdminId = '22222222-2222-2222-2222-222222222222';  // User B: Admin

  const sampleEmbedding = new Array(1536).fill(0.01);
  sampleEmbedding[0] = 0.9;
  sampleEmbedding[1] = 0.4;

  // 1. Perform DLAC vector search as User A (Member)
  const memberMatches = await searchVectorContextDLAC({
    queryEmbedding: sampleEmbedding,
    workspaceId,
    userId: userMemberId,
    role: 'member',
    matchThreshold: 0.05,
    matchCount: 10,
  });

  // Verify User A (Member) does NOT see any Critical/High risk restricted documents requiring human gate
  const memberHasRestricted = memberMatches.some(
    (doc) => doc.requires_human_gate || doc.risk_level === 'Critical' || doc.risk_level === 'High'
  );

  if (memberHasRestricted) {
    console.error('❌ DLAC TEST FAILED: Member user received restricted administrative documents!');
    return false;
  }
  console.log('✅ DLAC TEST PASSED: Member user (User A) correctly filtered out of confidential/restricted documents.');

  // 2. Perform DLAC vector search as User B (Admin)
  const adminMatches = await searchVectorContextDLAC({
    queryEmbedding: sampleEmbedding,
    workspaceId,
    userId: userAdminId,
    role: 'admin',
    matchThreshold: 0.05,
    matchCount: 10,
  });

  console.log(`✅ DLAC TEST PASSED: Admin user (User B) successfully retrieved ${adminMatches.length} document context matches.`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDlacVectorSearchTest().then((success) => {
    if (!success) process.exit(1);
  });
}
