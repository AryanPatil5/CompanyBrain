import { installHarness } from '../harness/index.js';
import { compileOpenApiSpec } from '../../src/services/skills/openApiCompiler.js';

export async function runOpenApiCompilerTest(): Promise<boolean> {
  await installHarness();
  console.log('\n=================================================');
  console.log('  Running OpenAPI / Swagger Skill Compiler Test  ');
  console.log('=================================================');

  const mockOpenApiSpec = {
    openapi: '3.0.0',
    info: { title: 'Mock Enterprise API', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        get: {
          operationId: 'getUserById',
          summary: 'Retrieve user account profile',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'User ID' },
          ],
        },
      },
      '/orders': {
        post: {
          operationId: 'createOrder',
          summary: 'Submit new purchase order',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['item_id', 'quantity'],
                  properties: {
                    item_id: { type: 'string', description: 'Product ID' },
                    quantity: { type: 'integer', description: 'Order quantity' },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // 1. Compile Spec
  const compiledSkills = compileOpenApiSpec(mockOpenApiSpec);

  if (!Array.isArray(compiledSkills) || compiledSkills.length !== 2) {
    console.error('❌ OPENAPI COMPILER TEST FAILED: Expected 2 compiled skills, got:', compiledSkills);
    return false;
  }

  // 2. Validate GET Skill
  const getSkill = compiledSkills.find((s) => s.name === 'getuserbyid');
  if (!getSkill || getSkill.method !== 'GET' || getSkill.endpoint !== '/users/{id}' || !getSkill.parameters.properties.id) {
    console.error('❌ OPENAPI COMPILER TEST FAILED: GET skill parsing mismatch!', getSkill);
    return false;
  }
  console.log('✅ OPENAPI COMPILER TEST PASSED: GET endpoint compiled to type-safe skill definition.');

  // 3. Validate POST Skill
  const postSkill = compiledSkills.find((s) => s.name === 'createorder');
  if (!postSkill || postSkill.method !== 'POST' || postSkill.parameters.properties.item_id === undefined) {
    console.error('❌ OPENAPI COMPILER TEST FAILED: POST request body schema parsing mismatch!', postSkill);
    return false;
  }
  console.log('✅ OPENAPI COMPILER TEST PASSED: POST requestBody compiled to type-safe JSON schema parameters.');

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOpenApiCompilerTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
