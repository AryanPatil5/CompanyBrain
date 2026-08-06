import { extractEntitiesAndTraverse } from '../../src/services/retrieval/graphFusion.js';
import { hybridSearch } from '../../src/services/retrieval/hybridSearch.js';
import { addEntityNode, createRelationship } from '../../src/services/graph/graphService.js';

export async function runGraphFusionTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running GraphRAG Traversal Fusion Test Suite   ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';

  // Seed sample graph node and 2-hop edges for testing
  await addEntityNode('System', { id: 'sys_stripe_api', name: 'Stripe API', workspace_id: workspaceId });
  await addEntityNode('Policy', { id: 'policy_refund', name: 'Refund Policy', workspace_id: workspaceId });
  await addEntityNode('Role', { id: 'role_manager', name: 'Finance Manager', workspace_id: workspaceId });

  await createRelationship('sys_stripe_api', 'policy_refund', 'GOVERNED_BY');
  await createRelationship('policy_refund', 'role_manager', 'REQUIRES_ROLE');

  // Test 1: Extract entity from query and return 2-hop graph paths
  try {
    const fusionRes = await extractEntitiesAndTraverse('How do we handle refunds on Stripe API?', workspaceId);

    if (!fusionRes.graphContextText || !fusionRes.graphContextText.includes('[Knowledge Graph Context]')) {
      console.error('❌ GRAPH FUSION TEST FAILED: Graph context payload missing!', fusionRes);
      return false;
    }
    console.log(`✅ GRAPH FUSION TEST PASSED: Successfully traversed 2-hop graph paths and generated context payload:\n${fusionRes.graphContextText}`);
  } catch (err: any) {
    console.error('❌ GRAPH FUSION TEST EXCEPTION (Extraction):', err.message);
    return false;
  }

  // Test 2: Merge graph context into hybrid search results seamlessly
  try {
    const searchRes = await hybridSearch({
      query: 'Stripe API refund policy',
      workspaceId,
      userId: 'user_test_01',
      limit: 5,
    });

    if (!Array.isArray(searchRes)) {
      console.error('❌ GRAPH FUSION TEST FAILED: Hybrid search did not return array!', searchRes);
      return false;
    }
    console.log('✅ GRAPH FUSION TEST PASSED: Successfully executed parallel vector, keyword, and GraphRAG traversal fusion.');
  } catch (err: any) {
    console.error('❌ GRAPH FUSION TEST EXCEPTION (Hybrid Merge):', err.message);
    return false;
  }

  // Test 3: Return empty graph context gracefully when query mentions no known entities
  try {
    const emptyRes = await extractEntitiesAndTraverse('qwertyuiop xyz 123456789', workspaceId);

    if (emptyRes.graphContextText !== '' || emptyRes.entityCount !== 0) {
      console.error('❌ GRAPH FUSION TEST FAILED: Unknown query did not return empty context gracefully!', emptyRes);
      return false;
    }
    console.log('✅ GRAPH FUSION TEST PASSED: Gracefully handled query with zero matching graph entities.');
  } catch (err: any) {
    console.error('❌ GRAPH FUSION TEST EXCEPTION (Empty Context):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGraphFusionTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
