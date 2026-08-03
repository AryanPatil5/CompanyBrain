import { enforceABAC, ABACPolicy } from '../../src/middleware/abacMiddleware.js';
import { AuthenticatedRequest } from '../../src/middleware/auth.js';

export async function runAbacMiddlewareTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running ABAC Access Control Middleware Test   ');
  console.log('=================================================');

  const policy: ABACPolicy = {
    action: 'delete_sop',
    resource: 'skills_sops',
    requiredRole: 'admin',
    maxSensitivityLevel: 3,
  };

  const abacMiddleware = enforceABAC(policy);

  // 1. Test Authorized Admin Request
  let adminNextCalled = false;
  const adminReq: any = {
    user: { user_id: 'usr_admin', workspace_id: 'ws_1', role: 'admin' },
    headers: { 'x-sensitivity-level': '2' },
  };
  const adminRes: any = {
    status: () => adminRes,
    json: () => adminRes,
  };

  abacMiddleware(adminReq, adminRes, () => {
    adminNextCalled = true;
  });

  if (!adminNextCalled) {
    console.error('❌ ABAC TEST FAILED: Authorized admin request was rejected!');
    return false;
  }
  console.log('✅ ABAC TEST PASSED: Authorized Admin request passed ABAC policy check.');

  // 2. Test Unauthorized Member Request (Role violation)
  let memberBlocked = false;
  const memberReq: any = {
    user: { user_id: 'usr_member', workspace_id: 'ws_1', role: 'member' },
    headers: {},
  };
  const memberRes: any = {
    status: (code: number) => {
      if (code === 403) memberBlocked = true;
      return memberRes;
    },
    json: (payload: any) => memberRes,
  };

  abacMiddleware(memberReq, memberRes, () => {});

  if (!memberBlocked) {
    console.error('❌ ABAC TEST FAILED: Unauthorized member request was not blocked with 403 Forbidden!');
    return false;
  }
  console.log('✅ ABAC TEST PASSED: Member role violation correctly blocked with HTTP 403 Forbidden.');

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAbacMiddlewareTest().then((success) => {
    if (!success) process.exit(1);
  });
}
