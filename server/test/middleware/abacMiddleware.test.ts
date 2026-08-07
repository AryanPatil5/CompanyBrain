import { enforceABAC, ABACPolicy } from '../../src/middleware/abacMiddleware.js';

function makeRes() {
  const res: any = {
    statusCode: 0,
    status: (code: number) => {
      res.statusCode = code;
      return res;
    },
    json: (payload: any) => {
      res.body = payload;
      return res;
    },
  };
  return res;
}

export async function runAbacMiddlewareTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running ABAC Access Control Middleware Test   ');
  console.log('=================================================');

  let passed = 0;
  let failed = 0;

  function check(name: string, ok: boolean, detail?: string): void {
    if (ok) {
      passed++;
      console.log(`✅ ABAC TEST PASSED: ${name}`);
    } else {
      failed++;
      console.error(`❌ ABAC TEST FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
    }
  }

  function runMiddleware(
    req: any,
    policy: ABACPolicy
  ): { statusCode: number; nextCalled: boolean } {
    const res = makeRes();
    let nextCalled = false;
    enforceABAC(policy)(req, res, () => {
      nextCalled = true;
    });
    return { statusCode: res.statusCode, nextCalled };
  }

  // 1. Authorized Admin Request (role + sensitivity)
  const adminRes = makeRes();
  let adminNextCalled = false;
  enforceABAC({
    action: 'delete_sop',
    resource: 'skills_sops',
    requiredRole: 'admin',
    maxSensitivityLevel: 3,
  })(
    {
      user: { user_id: 'usr_admin', workspace_id: 'ws_1', role: 'admin', clearance_level: 3 },
      headers: {},
    } as any,
    adminRes,
    () => {
      adminNextCalled = true;
    }
  );
  check('Authorized admin request passes role + sensitivity policy', adminNextCalled && adminRes.statusCode === 0);

  // 2. Unauthorized Member Request (role violation)
  const memberResult = runMiddleware(
    { user: { user_id: 'usr_member', workspace_id: 'ws_1', role: 'member' }, headers: {} },
    { action: 'delete_sop', resource: 'skills_sops', requiredRole: 'admin' }
  );
  check('Member role violation blocked with 403', memberResult.statusCode === 403 && !memberResult.nextCalled);

  // 3. IPv4 allow via middleware
  const v4Allow = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '192.168.1.100' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['192.168.1.0/24'] }
  );
  check('IPv4 in-range client passes middleware', v4Allow.nextCalled && v4Allow.statusCode === 0);

  // 4. IPv4 deny via middleware
  const v4Deny = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '10.0.0.5' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['192.168.1.0/24'] }
  );
  check('IPv4 out-of-range client blocked with 403', v4Deny.statusCode === 403 && !v4Deny.nextCalled);

  // 5. IPv6 allow via middleware
  const v6Allow = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '2001:db8::1' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['2001:db8::/32'] }
  );
  check('IPv6 in-range client passes middleware', v6Allow.nextCalled && v6Allow.statusCode === 0);

  // 6. IPv6 deny via middleware
  const v6Deny = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '2001:db9::1' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['2001:db8::/32'] }
  );
  check('IPv6 out-of-range client blocked with 403', v6Deny.statusCode === 403 && !v6Deny.nextCalled);

  // 7. Malformed CIDR in policy → fail closed (403)
  const badCidr = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '192.168.1.100' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['192.168.1.0/999'] }
  );
  check('Malformed CIDR in policy fails closed with 403', badCidr.statusCode === 403 && !badCidr.nextCalled);

  // 8. Malformed client IP → fail closed (403)
  const badIp = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': 'not-an-ip' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['0.0.0.0/0'] }
  );
  check('Malformed client IP fails closed with 403', badIp.statusCode === 403 && !badIp.nextCalled);

  // 9. X-Forwarded-For list uses leftmost client entry
  const forwardedList = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '192.168.1.100, 10.0.0.1' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['192.168.1.0/24'] }
  );
  check('X-Forwarded-For list evaluated from leftmost client', forwardedList.nextCalled && forwardedList.statusCode === 0);

  // 10. Substring-bypass regression via middleware
  const bypass = runMiddleware(
    { user: { role: 'admin' }, headers: { 'x-forwarded-for': '1.192.168.1.100' } },
    { action: 'read', resource: 'doc', allowedIpRanges: ['192.168.1.100'] }
  );
  check('Substring-bypass attempt blocked with 403', bypass.statusCode === 403 && !bypass.nextCalled);

  console.log(`\nABAC middleware: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAbacMiddlewareTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
