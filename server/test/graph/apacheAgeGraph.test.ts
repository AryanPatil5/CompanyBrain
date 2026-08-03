import { addEntityNode, createRelationship, getConnectedEntities } from '../../src/services/graph/graphService.js';

export async function runApacheAgeGraphTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Apache AGE Graph Integration Test Suite');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';

  // 1. Add Graph Nodes (System, Person, SOP)
  const nodeSystem = await addEntityNode('System', { id: 'sys_postgres_primary', name: 'PostgreSQL Primary', workspace_id: workspaceId });
  const nodePerson = await addEntityNode('Person', { id: 'person_ops_admin', name: 'Ops Admin', workspace_id: workspaceId });
  const nodeSop = await addEntityNode('SOP', { id: 'sop_db_slow_query', name: 'Primary DB Slow Query Triage', workspace_id: workspaceId });

  if (!nodeSystem.id || !nodePerson.id || !nodeSop.id) {
    console.error('❌ AGE GRAPH TEST FAILED: Node creation failed!');
    return false;
  }
  console.log('✅ AGE GRAPH TEST PASSED: Created vertex label nodes (System, Person, SOP).');

  // 2. Add Directed Graph Relationships (OWNS, MODIFIES)
  const rel1 = await createRelationship('person_ops_admin', 'sys_postgres_primary', 'OWNS');
  const rel2 = await createRelationship('sop_db_slow_query', 'sys_postgres_primary', 'MODIFIES');

  if (!rel1.source_id || !rel2.source_id) {
    console.error('❌ AGE GRAPH TEST FAILED: Relationship creation failed!');
    return false;
  }
  console.log('✅ AGE GRAPH TEST PASSED: Created edge relationships (OWNS, MODIFIES).');

  // 3. Perform Multi-hop Traversal (getConnectedEntities)
  const connected = await getConnectedEntities('person_ops_admin', 2);

  if (!Array.isArray(connected)) {
    console.error('❌ AGE GRAPH TEST FAILED: getConnectedEntities returned non-array!');
    return false;
  }

  console.log(`✅ AGE GRAPH TEST PASSED: Multi-hop graph traversal returned ${connected.length} connected entity relationships.`);
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runApacheAgeGraphTest().then((success) => {
    if (!success) process.exit(1);
  });
}
