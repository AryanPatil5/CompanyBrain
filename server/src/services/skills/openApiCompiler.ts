export interface CompiledSkill {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | string;
  headers?: Record<string, string>;
}

/**
 * Compiles raw OpenAPI 3.0 / Swagger JSON specifications into FastMCP-compatible AI skill definitions.
 */
export function compileOpenApiSpec(specJson: any): CompiledSkill[] {
  if (!specJson || typeof specJson !== 'object' || !specJson.paths) {
    throw new Error('Invalid OpenAPI specification: Missing "paths" root object.');
  }

  const compiledSkills: CompiledSkill[] = [];
  const paths = specJson.paths;

  for (const [pathUrl, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const httpMethods = ['get', 'post', 'put', 'delete', 'patch'];

    for (const method of httpMethods) {
      const operation = (pathItem as any)[method];
      if (!operation || typeof operation !== 'object') continue;

      // Generate skill name from operationId or method + path
      let skillName = operation.operationId || `${method}_${pathUrl.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      skillName = skillName.toLowerCase().replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, '').replace(/_+/g, '_');

      const description =
        operation.summary ||
        operation.description ||
        `Executes ${method.toUpperCase()} request to ${pathUrl}`;

      const properties: Record<string, any> = {};
      const requiredParams: string[] = [];

      // 1. Process Path and Query Parameters
      if (Array.isArray(operation.parameters)) {
        for (const param of operation.parameters) {
          if (!param || !param.name) continue;

          properties[param.name] = {
            type: param.schema?.type || 'string',
            description: param.description || `Parameter ${param.name} (${param.in || 'query'})`,
          };

          if (param.required) {
            requiredParams.push(param.name);
          }
        }
      }

      // 2. Process Request Body Schemas (application/json)
      if (operation.requestBody?.content?.['application/json']?.schema) {
        const bodySchema = operation.requestBody.content['application/json'].schema;
        if (bodySchema.properties) {
          for (const [propKey, propValue] of Object.entries<any>(bodySchema.properties)) {
            properties[propKey] = {
              type: propValue?.type || 'string',
              description: propValue?.description || `Body property ${propKey}`,
            };
          }
          if (Array.isArray(bodySchema.required)) {
            for (const reqKey of bodySchema.required) {
              if (!requiredParams.includes(reqKey)) requiredParams.push(reqKey);
            }
          }
        } else {
          properties['body'] = {
            type: 'object',
            description: 'JSON request payload',
          };
        }
      }

      compiledSkills.push({
        name: skillName,
        description,
        parameters: {
          type: 'object',
          properties,
          required: requiredParams.length > 0 ? requiredParams : undefined,
        },
        endpoint: pathUrl,
        method: method.toUpperCase(),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });
    }
  }

  return compiledSkills;
}
