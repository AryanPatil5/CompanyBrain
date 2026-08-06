import { extractEntitiesAndTraverse } from '../../src/services/retrieval/graphFusion.js';
import { addEntityNode, createRelationship } from '../../src/services/graph/graphService.js';

export async function runDlacGraphFusionTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running DLAC Graph Fusion Access Control Test  ');
  console.log('=================================================');

  const workspaceId = '00000000-0000-0000-0000-000000000000';

  // Seed restricted HR Node (allowed_roles: ['admin']) and Public SOP Node (allowed_roles: ['admin', 'member'])
  const restrictedNodeId = 'node_hr_salary_doc';
  const publicNodeId = 'node_public_onboarding_doc';
  const entityId = 'node_hr_department';

  await addEntityNode('Entity', {
    id: entityId,
    name: 'HR Department',
    workspace_id: workspaceId,
    allowed_roles: ['admin', 'member'],
  });

  await addEntityNode('Policy', {
    id: restrictedNodeId,
    name: 'Executive Compensation & Salary Grid',
    workspace_id: workspaceId,
    allowed_roles: ['admin'], // Restricted to admin only
  });

  await addEntityNode('SOP', {
    id: publicNodeId,
    name: 'Standard Employee Onboarding Guide',
    workspace_id: workspaceId,
    allowed_roles: ['admin', 'member'],
  });

  await createRelationship(entityId, restrictedNodeId, 'GOVERNED_BY', {
    workspace_id: workspaceId,
    allowed_roles: ['admin'],
  });

  await createRelationship(entityId, publicNodeId, 'GOVERNED_BY', {
    workspace_id: workspaceId,
    allowed_roles: ['admin', 'member'],
  });

  // Test 1: User A (Role: 'member') cannot retrieve entity relationships extracted from restricted HR documents
  try {
    const memberRes = await extractEntitiesAndTraverse('HR Department policies', {
      workspaceId,
      userRole: 'member',
    });

    if (memberRes.graphContextText.includes('Executive Compensation & Salary Grid')) {
      console.error('❌ DLAC GRAPH TEST FAILED: Member role retrieved restricted HR Salary Grid node!', memberRes);
      return false;
    }
    console.log('✅ DLAC GRAPH TEST PASSED: Member role correctly denied access to restricted HR document graph nodes.');
  } catch (err: any) {
    console.error('❌ DLAC GRAPH TEST EXCEPTION (Member Access):', err.message);
    return false;
  }

  // Test 2: User B (Role: 'admin') retrieves the full context graph including restricted nodes
  try {
    const adminRes = await extractEntitiesAndTraverse('HR Department policies', {
      workspaceId,
      userRole: 'admin',
    });

    if (!adminRes.graphContextText.includes('Executive Compensation & Salary Grid')) {
      console.error('❌ DLAC GRAPH TEST FAILED: Admin role was denied access to restricted HR document graph nodes!', adminRes);
      return false;
    }
    console.log('✅ DLAC GRAPH TEST PASSED: Admin role successfully retrieved full context graph including restricted nodes.');
  } catch (err: any) {
    console.error('❌ DLAC GRAPH TEST EXCEPTION (Admin Access):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDlacGraphFusionTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
