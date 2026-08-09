import { installHarness } from '../harness/index.js';
import { enforceOpenFGA, openfgaClientManager } from '../../src/middleware/openfgaMiddleware.js';

export async function runOpenFGAEngineTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running OpenFGA ReBAC PDP Middleware Test Suite');
  console.log('=================================================');

  // Test 1: Access denial for unauthorized resource actions (403 Forbidden)
  try {
    const mockReq: any = {
      user: { user_id: 'user_member_99', role: 'member', workspace_id: 'ws_01' },
      params: { id: 'sop_financial_secret' },
    };

    let statusCode = 0;
    const mockRes: any = {
      status: (code: number) => {
        statusCode = code;
        return { json: () => {} };
      },
    };

    const middleware = enforceOpenFGA('owner', 'document');
    await middleware(mockReq, mockRes, () => {});

    if (statusCode !== 403) {
      console.error(`❌ OPENFGA TEST FAILED: Unauthorized tuple check returned status ${statusCode} instead of 403!`);
      return false;
    }
    console.log('✅ OPENFGA TEST PASSED: Unauthorized request without tuple grant correctly denied with 403 Forbidden.');
  } catch (err: any) {
    console.error('❌ OPENFGA TEST EXCEPTION (Access Denial):', err.message);
    return false;
  }

  // Test 2: System fail-closed behavior when OpenFGA service connection drops (500 Authorization Engine Unavailable)
  try {
    openfgaClientManager.setSimulateFailure(true);

    const mockReq: any = {
      user: { user_id: 'user_admin_01', role: 'admin', workspace_id: 'ws_01' },
      params: { id: 'document:sop_01' },
    };

    let statusCode = 0;
    let responseBody: any = null;
    const mockRes: any = {
      status: (code: number) => {
        statusCode = code;
        return {
          json: (body: any) => {
            responseBody = body;
          },
        };
      },
    };

    const middleware = enforceOpenFGA('viewer', 'document');
    await middleware(mockReq, mockRes, () => {});

    openfgaClientManager.setSimulateFailure(false);

    if (statusCode !== 500 || !responseBody?.error?.includes('500 Authorization Engine Unavailable')) {
      console.error(`❌ OPENFGA TEST FAILED: Service failure did not fail-closed with 500!`, statusCode, responseBody);
      return false;
    }
    console.log('✅ OPENFGA TEST PASSED: System failed closed with 500 Authorization Engine Unavailable when service dropped.');
  } catch (err: any) {
    openfgaClientManager.setSimulateFailure(false);
    console.error('❌ OPENFGA TEST EXCEPTION (Fail-Closed):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpenFGAEngineTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
