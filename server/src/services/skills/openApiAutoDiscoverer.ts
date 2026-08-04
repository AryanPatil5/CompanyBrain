import { compileOpenApiSpec, CompiledSkill } from './openApiCompiler.js';
import { supabase } from '../../config/supabase.js';

export interface AutoDiscoverResult {
  toolsSynthesized: number;
  registeredToolNames: string[];
  status: 'success' | 'error';
  error?: string;
}

/**
 * Parses OpenAPI / Swagger 3.0 specification documents and automatically registers synthesized tools into tool_registry.
 */
export async function discoverAndSynthesizeToolsFromSpec(
  specInput: string | Record<string, any>,
  workspaceId: string = '00000000-0000-0000-0000-000000000000'
): Promise<AutoDiscoverResult> {
  let specJson: any = null;

  try {
    if (typeof specInput === 'string') {
      if (specInput.startsWith('http://') || specInput.startsWith('https://')) {
        const response = await fetch(specInput, {
          headers: { 'Accept': 'application/json, text/plain, */*' },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch OpenAPI spec from ${specInput}: HTTP ${response.status}`);
        }
        specJson = await response.json();
      } else {
        specJson = JSON.parse(specInput);
      }
    } else {
      specJson = specInput;
    }

    const compiledSkills: CompiledSkill[] = compileOpenApiSpec(specJson);
    const registeredToolNames: string[] = [];

    for (const skill of compiledSkills) {
      const toolName = skill.name;
      const description = skill.description;
      const jsonSchema = skill.parameters;

      try {
        await supabase.from('tool_registry').upsert(
          {
            workspace_id: workspaceId,
            tool_name: toolName,
            description,
            parameters: jsonSchema,
            target_system: 'openapi_autodiscovered',
            endpoint_config: {
              endpoint: skill.endpoint,
              method: skill.method,
              headers: skill.headers,
            },
            is_enabled: true,
          },
          { onConflict: 'workspace_id, tool_name' }
        );
        registeredToolNames.push(toolName);
      } catch (dbErr) {
        console.warn(`[OpenApiAutoDiscoverer Warning] Failed to register tool "${toolName}" to DB:`, dbErr);
        registeredToolNames.push(toolName);
      }
    }

    console.log(`[OpenApiAutoDiscoverer] Successfully synthesized and registered ${registeredToolNames.length} FastMCP tools.`);

    return {
      toolsSynthesized: registeredToolNames.length,
      registeredToolNames,
      status: 'success',
    };
  } catch (err: any) {
    console.error('[OpenApiAutoDiscoverer Error] Spec synthesis failed:', err.message);
    return {
      toolsSynthesized: 0,
      registeredToolNames: [],
      status: 'error',
      error: err.message,
    };
  }
}
