import { installHarness } from '../harness/index.js';
import { discoverAndSynthesizeToolsFromSpec } from '../../src/services/skills/openApiAutoDiscoverer.js';

export async function runOpenApiAutoDiscovererTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running OpenAPI Auto-Discovery & Tool Test   ');
  console.log('=================================================');

  const sampleSwaggerSpec = {
    openapi: '3.0.0',
    info: { title: 'Internal Operations API', version: '1.0.0' },
    paths: {
      '/api/v1/refunds/process': {
        post: {
          operationId: 'process_customer_refund',
          summary: 'Processes customer refund transaction',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    user_id: { type: 'string', description: 'Target customer ID' },
                    amount: { type: 'number', description: 'Refund amount in USD' },
                  },
                  required: ['user_id', 'amount'],
                },
              },
            },
          },
        },
      },
      '/api/v1/system/status': {
        get: {
          operationId: 'get_system_health_status',
          summary: 'Fetches real-time server cluster status',
        },
      },
    },
  };

  const workspaceId = '00000000-0000-0000-0000-000000000000';

  try {
    const result = await discoverAndSynthesizeToolsFromSpec(sampleSwaggerSpec, workspaceId);

    if (result.status !== 'success' || result.toolsSynthesized !== 2 || !result.registeredToolNames.includes('process_customer_refund')) {
      console.error('❌ OPENAPI DISCOVERER TEST FAILED: Tool synthesis mismatch!', result);
      return false;
    }

    console.log(`✅ OPENAPI DISCOVERER TEST PASSED: Successfully parsed spec and synthesized ${result.toolsSynthesized} FastMCP tools (${result.registeredToolNames.join(', ')}).`);
  } catch (err: any) {
    console.error('❌ OPENAPI DISCOVERER TEST EXCEPTION:', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpenApiAutoDiscovererTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
