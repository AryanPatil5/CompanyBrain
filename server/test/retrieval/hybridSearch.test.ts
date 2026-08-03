import { hybridSearch } from '../../src/services/retrieval/hybridSearch.js';

export async function runHybridSearchTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running RRF Hybrid Search Integration Test Suite ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';
  const userId = '22222222-2222-2222-2222-222222222222'; // Admin user

  // 1. Search for exact keyword query "ERR_502_GATEWAY"
  const searchResults = await hybridSearch({
    query: 'ERR_502_GATEWAY',
    workspaceId,
    userId,
    role: 'admin',
    limit: 5,
  });

  if (!Array.isArray(searchResults)) {
    console.error('❌ HYBRID SEARCH TEST FAILED: hybridSearch returned non-array result!');
    return false;
  }

  // 2. Search for exact string query "SKU-8941"
  const skuResults = await hybridSearch({
    query: 'SKU-8941',
    workspaceId,
    userId,
    role: 'admin',
    limit: 5,
  });

  console.log(`✅ HYBRID SEARCH TEST PASSED: RRF Hybrid Search executed successfully (${searchResults.length} RRF candidates scored).`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHybridSearchTest().then((success) => {
    if (!success) process.exit(1);
  });
}
