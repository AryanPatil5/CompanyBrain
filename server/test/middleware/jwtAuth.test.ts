import { installHarness } from '../harness/index.js';
import { jwtAuth, generateTestToken } from '../../src/middleware/jwtAuth.js';
import { enforceABAC } from '../../src/middleware/abacMiddleware.js';

export async function runJwtAuthTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running JWKS JWT Authentication & ABAC Test Suite');
  console.log('=================================================');

  // Test 1: Should allow request with valid signed JWT token
  try {
    const validToken = await generateTestToken({
      user_id: 'user_valid_01',
      role: 'admin',
      clearance_level: 5,
    });

    const mockReq: any = {
      headers: { authorization: `Bearer ${validToken}` },
    };
    let nextCalled = false;

    const middleware = jwtAuth();
    await middleware(mockReq, {} as any, () => {
      nextCalled = true;
    });

    if (!nextCalled || !mockReq.user || mockReq.user.role !== 'admin') {
      console.error('❌ JWT TEST FAILED: Valid JWT token was not verified correctly!', mockReq.user);
      return false;
    }
    console.log('✅ JWT TEST PASSED: Successfully verified valid signed JWT token and attached req.user identity.');
  } catch (err: any) {
    console.error('❌ JWT TEST EXCEPTION (Valid Token):', err.message);
    return false;
  }

  // Test 2: Should reject request with expired JWT token
  try {
    const expiredToken = await generateTestToken(
      { user_id: 'user_expired_01' },
      undefined,
      '-1s' // Expired 1 second ago
    );

    const mockReq: any = {
      headers: { authorization: `Bearer ${expiredToken}` },
    };
    let statusCode = 0;
    const mockRes: any = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    };

    const middleware = jwtAuth();
    await middleware(mockReq, mockRes, () => {});

    if (statusCode !== 401) {
      console.error(`❌ JWT TEST FAILED: Expired JWT token returned status ${statusCode} instead of 401!`);
      return false;
    }
    console.log('✅ JWT TEST PASSED: Expired JWT token correctly rejected with 401 Unauthorized.');
  } catch (err: any) {
    console.error('❌ JWT TEST EXCEPTION (Expired Token):', err.message);
    return false;
  }

  // Test 3: Should reject request where role claim fails ABAC policy rule
  try {
    const memberToken = await generateTestToken({
      user_id: 'user_member_01',
      role: 'member',
      clearance_level: 1,
    });

    const mockReq: any = {
      headers: { authorization: `Bearer ${memberToken}` },
    };
    const middleware = jwtAuth();
    await middleware(mockReq, {} as any, () => {});

    // Enforce ABAC policy requiring 'admin' role for deletion
    let abacStatusCode = 0;
    const mockRes: any = {
      status: (code: number) => {
        abacStatusCode = code;
        return { json: () => {} };
      },
    };

    const abac = enforceABAC({
      action: 'DELETE_DATABASE',
      resource: 'postgres_cluster',
      requiredRole: 'admin',
    });

    abac(mockReq, mockRes, () => {});

    if (abacStatusCode !== 403) {
      console.error(`❌ JWT TEST FAILED: Member role accessing admin resource returned status ${abacStatusCode} instead of 403!`);
      return false;
    }
    console.log('✅ JWT TEST PASSED: Member role accessing admin resource correctly rejected by ABAC with 403 Forbidden.');
  } catch (err: any) {
    console.error('❌ JWT TEST EXCEPTION (ABAC Rule):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runJwtAuthTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
