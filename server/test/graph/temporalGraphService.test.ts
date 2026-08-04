import { isEdgeTemporallyValid, calculateTemporalDecayScore, filterActiveEdges } from '../../src/services/graph/temporalGraphService.js';
import { addEntityNode, createRelationship, getConnectedEntities } from '../../src/services/graph/graphService.js';

export async function runTemporalGraphServiceTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Temporal Validity & Decay Graph Test  ');
  console.log('=================================================');

  // Test 1: Temporal validity window calculation (valid_until < referenceDate)
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const tomorrow = new Date(Date.now() + 86400000).toISOString();

    const activeEdgeValid = isEdgeTemporallyValid(yesterday, tomorrow);
    const expiredEdgeValid = isEdgeTemporallyValid(null, yesterday);

    if (!activeEdgeValid || expiredEdgeValid) {
      console.error('❌ TEMPORAL GRAPH TEST FAILED: Edge validity check error!', { activeEdgeValid, expiredEdgeValid });
      return false;
    }
    console.log('✅ TEMPORAL GRAPH TEST PASSED: Successfully evaluated edge validity windows and identified expired edges.');
  } catch (err: any) {
    console.error('❌ TEMPORAL GRAPH TEST EXCEPTION (Validity Check):', err.message);
    return false;
  }

  // Test 2: Exponential time-decay scoring
  try {
    const recentScore = calculateTemporalDecayScore(new Date(), 30);
    const oldScore = calculateTemporalDecayScore(new Date(Date.now() - 60 * 86400000), 30);

    if (recentScore < 0.95 || oldScore > 0.3) {
      console.error('❌ TEMPORAL GRAPH TEST FAILED: Exponential decay math mismatch!', { recentScore, oldScore });
      return false;
    }
    console.log(`✅ TEMPORAL GRAPH TEST PASSED: Time-decay scoring correctly prioritized recent knowledge (Recent: ${recentScore.toFixed(2)}, 60-day Old: ${oldScore.toFixed(2)}).`);
  } catch (err: any) {
    console.error('❌ TEMPORAL GRAPH TEST EXCEPTION (Decay Math):', err.message);
    return false;
  }

  // Test 3: Traversal filtering of expired edges in getConnectedEntities
  try {
    const workspaceId = '00000000-0000-0000-0000-000000000000';
    const activeNodeId = 'node_current_policy_2026';
    const expiredNodeId = 'node_archived_policy_2020';
    const entityId = 'node_security_standard';

    await addEntityNode('Entity', { id: entityId, name: 'Security Standard', workspace_id: workspaceId });
    await addEntityNode('SOP', { id: activeNodeId, name: 'Active Security Policy 2026', workspace_id: workspaceId });
    await addEntityNode('SOP', { id: expiredNodeId, name: 'Superseded Policy 2020', workspace_id: workspaceId });

    // Active relationship
    await createRelationship(entityId, activeNodeId, 'GOVERNED_BY', {
      workspace_id: workspaceId,
      valid_from: new Date().toISOString(),
      valid_until: null,
    });

    // Expired relationship (valid_until was yesterday)
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString();
    await createRelationship(entityId, expiredNodeId, 'GOVERNED_BY', {
      workspace_id: workspaceId,
      valid_from: new Date(Date.now() - 365 * 86400000).toISOString(),
      valid_until: yesterdayStr,
    });

    const connected = await getConnectedEntities(entityId, 2, { userRole: 'admin', workspaceId });
    const containsExpiredNode = connected.some((c) => c.entityId === expiredNodeId);

    if (containsExpiredNode) {
      console.error('❌ TEMPORAL GRAPH TEST FAILED: getConnectedEntities included expired policy edge!', connected);
      return false;
    }
    console.log('✅ TEMPORAL GRAPH TEST PASSED: Expired policy document edges were automatically filtered out during graph traversal.');
  } catch (err: any) {
    console.error('❌ TEMPORAL GRAPH TEST EXCEPTION (Traversal Filter):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTemporalGraphServiceTest().then((success) => {
    if (!success) process.exit(1);
  });
}
