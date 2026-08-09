import { installHarness } from '../harness/index.js';
import {
  findSimilarEntities,
  registerEntityVector,
} from '../../src/services/graph/vectorEntityResolver.js';
import {
  mergeGraphNodes,
  addEntityNode,
  createRelationship,
  getConnectedEntities,
} from '../../src/services/graph/graphService.js';

export async function runVectorEntityResolverTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running Vector Entity Resolution & Merge Test ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';

  // 1. Register canonical "Google LLC" node in vector resolver registry
  await registerEntityVector('node_google_canonical', 'Google LLC', 'System', workspaceId);

  // Test 1: Should identify "Google" and "Google LLC" as duplicate entities
  try {
    const matchRes = await findSimilarEntities('Google', 'System', workspaceId);
    if (!matchRes.isDuplicate || matchRes.existingNodeId !== 'node_google_canonical') {
      console.error('❌ VECTOR RESOLVER TEST FAILED: "Google" was not matched to "Google LLC"!', matchRes);
      return false;
    }
    console.log(`✅ VECTOR RESOLVER TEST PASSED: Successfully identified "Google" and "Google LLC" as duplicate entities (Similarity: ${matchRes.similarityScore?.toFixed(2)}).`);
  } catch (err: any) {
    console.error('❌ VECTOR RESOLVER TEST EXCEPTION (Duplicate Match):', err.message);
    return false;
  }

  // Test 2: Should NOT merge semantically distinct entities ("Apple Inc" vs "Apple Bank")
  try {
    await registerEntityVector('node_apple_inc', 'Apple Inc', 'Entity', workspaceId);
    const distinctRes = await findSimilarEntities('Apple Bank', 'Entity', workspaceId);

    if (distinctRes.isDuplicate && distinctRes.existingNodeId === 'node_apple_inc') {
      console.error('❌ VECTOR RESOLVER TEST FAILED: "Apple Bank" was incorrectly merged with "Apple Inc"!', distinctRes);
      return false;
    }
    console.log('✅ VECTOR RESOLVER TEST PASSED: Correctly preserved "Apple Bank" and "Apple Inc" as distinct graph entities.');
  } catch (err: any) {
    console.error('❌ VECTOR RESOLVER TEST EXCEPTION (Distinct Entities):', err.message);
    return false;
  }

  // Test 3: Should re-point incoming and outgoing edges cleanly during graph node merge
  try {
    const sourceId = 'node_source_dup';
    const targetId = 'node_target_canon';

    await addEntityNode('System', { id: sourceId, name: 'Duplicate System', workspace_id: workspaceId });
    await addEntityNode('System', { id: targetId, name: 'Canonical System', workspace_id: workspaceId });

    const neighborId = 'node_neighbor_sop';
    await addEntityNode('SOP', { id: neighborId, name: 'Backup SOP', workspace_id: workspaceId });

    // Create edge: Duplicate System -> Backup SOP
    await createRelationship(sourceId, neighborId, 'REQUIRES');

    // Execute node merge: sourceId -> targetId
    const mergeRes = await mergeGraphNodes(sourceId, targetId, workspaceId);

    if (!mergeRes.success) {
      console.error('❌ VECTOR RESOLVER TEST FAILED: mergeGraphNodes returned failure state!', mergeRes);
      return false;
    }

    // Verify neighbor SOP is now connected to targetId (Canonical System)
    const connected = await getConnectedEntities(targetId, 1, { workspaceId });
    const hasReconnectedEdge = connected.some((c) => c.entityId === neighborId && c.relationship === 'REQUIRES');

    if (!hasReconnectedEdge) {
      console.error('❌ VECTOR RESOLVER TEST FAILED: Re-pointed edges were not found on target canonical node!', connected);
      return false;
    }

    console.log(`✅ VECTOR RESOLVER TEST PASSED: Merged duplicate graph nodes and cleanly re-pointed relationship edges.`);
  } catch (err: any) {
    console.error('❌ VECTOR RESOLVER TEST EXCEPTION (Edge Re-pointing):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVectorEntityResolverTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
