import { logger } from '../logger.js';
import dotenv from 'dotenv';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { generateText } from './aiProvider.js';
import { addEntityNode, createRelationship } from './graph/graphService.js';

dotenv.config();

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface SOPStep {
  step_number: number;
  action: string;
  target_system: string;
  parameters?: Record<string, any>;
  condition?: string;
  on_failure?: string;
}

export interface GraphEntityTriple {
  id: string;
  name: string;
  type: 'Person' | 'System' | 'SOP' | 'Rule' | 'Step' | 'Entity';
}

export interface GraphRelationshipTriple {
  source: string;
  target: string;
  relationship_type: 'OWNS' | 'REQUIRES' | 'MODIFIES' | 'DEPENDS_ON' | 'EXECUTES';
}

export interface ExtractedSOP {
  is_valid_sop: boolean;
  confidence_score: number;
  title: string;
  category: 'Engineering' | 'Support' | 'Billing' | 'Operations' | 'Security';
  trigger_condition: string;
  preconditions: string[];
  execution_steps: SOPStep[];
  entities?: GraphEntityTriple[];
  relationships?: GraphRelationshipTriple[];
  risk_level: RiskLevel;
  requires_human_gate: boolean;
}

// Zod schema validation matching TS interface precisely with transforms
const SOPStepSchema = z.object({
  step_number: z.number(),
  action: z.string(),
  target_system: z.string(),
  parameters: z.record(z.any()).nullable().optional().transform(v => v === null ? undefined : v),
  condition: z.string().nullable().optional().transform(v => v === null ? undefined : v),
  on_failure: z.string().nullable().optional().transform(v => v === null ? undefined : v),
});

const GraphEntitySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['Person', 'System', 'SOP', 'Rule', 'Step', 'Entity']),
});

const GraphRelationshipSchema = z.object({
  source: z.string(),
  target: z.string(),
  relationship_type: z.enum(['OWNS', 'REQUIRES', 'MODIFIES', 'DEPENDS_ON', 'EXECUTES']),
});

const ExtractedSOPSchema = z.object({
  is_valid_sop: z.boolean(),
  confidence_score: z.number(),
  title: z.string(),
  category: z.enum(['Engineering', 'Support', 'Billing', 'Operations', 'Security']),
  trigger_condition: z.string(),
  preconditions: z.array(z.string()),
  execution_steps: z.array(SOPStepSchema),
  entities: z.array(GraphEntitySchema).optional().default([]),
  relationships: z.array(GraphRelationshipSchema).optional().default([]),
  risk_level: z.enum(['Low', 'Medium', 'High', 'Critical']),
  requires_human_gate: z.boolean(),
});

const SYSTEM_PROMPT = `
You are an expert Enterprise Knowledge Engineer. Your job is to analyze noisy team communications or tacit knowledge dictation (from Slack, GitHub, Linear, Zendesk, Email, Database Runbooks, or Direct Teach) and determine if a concrete, repeatable Standard Operating Procedure (SOP) was established.

### Risk Level & Safety Governance Rules:
- **Low Risk**: Pure read actions, logging, internal Slack posts (e.g., query status in Postgres, post message to #general).
- **Medium Risk**: Soft operational updates, low-value retry scheduling (e.g., retry failed invoice under $1000).
- **High Risk**: Direct database mutations, contract tier overrides, revoking keys, refunds > $500, modifying production infra.
- **Critical Risk**: Secret rotation, revoking admin credentials, bulk data deletion, financial overrides > $10,000.

If risk_level is "High" or "Critical", set "requires_human_gate" to true.

### Knowledge Graph Extraction:
Extract structured entity nodes (Person, System, SOP, Rule, Step) and directed relationships (OWNS, REQUIRES, MODIFIES, DEPENDS_ON, EXECUTES) mentioned in the document.

### Instructions:
1. Ignore casual banter, greetings, chit-chat, and irrelevant side conversations.
2. Focus ONLY on actionable problem-solving patterns, step-by-step procedures, or explicit decision rules.
3. Confidence Score Governance:
   - If SOURCE_TRUST is "manual" (direct human teach dictation), set "is_valid_sop" to true and "confidence_score" to 0.95 for explicit decrees.
   - If SOURCE_TRUST is "crawled" (Slack, GitHub, Linear, Email, Zendesk, DB webhooks/crawlers), DO NOT auto-boost confidence based on decree phrasing. Score confidence strictly on genuine procedural clarity and objective content quality.
4. If no operational procedure or rule is defined, set "is_valid_sop" to false.
5. Output MUST be strictly raw JSON adhering to the required structure. Do NOT wrap in markdown code blocks like \`\`\`json.
`;

export async function extractSOPFromThread(
  rawMessages: Array<{ user: string; text: string; timestamp?: string }>,
  workspaceId?: string,
  source?: string,
  sourceTrust: 'manual' | 'crawled' = 'crawled'
): Promise<ExtractedSOP | null> {
  const formattedTranscript = rawMessages
    .map((msg) => `[${msg.user || 'Unknown'}]: ${msg.text || ''}`)
    .join('\n');

  try {
    const userPrompt = `Analyze this transcript/dictation (SOURCE_TRUST: "${sourceTrust}", SOURCE: "${source || 'unknown'}") and extract an SOP object if a clear procedure exists:

${formattedTranscript}

Return JSON output matching this schema:
{
  "is_valid_sop": boolean,
  "confidence_score": number between 0 and 1,
  "title": string,
  "category": "Engineering" | "Support" | "Billing" | "Operations" | "Security",
  "trigger_condition": string describing when this SOP activates,
  "preconditions": string[] of requirements before execution,
  "execution_steps": [
    {
      "step_number": number,
      "action": string describing what to do,
      "target_system": string (e.g. "Stripe", "Slack", "Postgres", "Admin CLI", "Vault", "Zendesk"),
      "parameters": object with specific values/thresholds extracted from the conversation,
      "condition": string or null — when this specific step applies,
      "on_failure": string or null — fallback action if this step fails
    }
  ],
  "entities": [
    { "id": "sys_stripe", "name": "Stripe", "type": "System" }
  ],
  "relationships": [
    { "source": "sys_stripe", "target": "sop_billing", "relationship_type": "REQUIRES" }
  ],
  "risk_level": "Low" | "Medium" | "High" | "Critical",
  "requires_human_gate": boolean
}`;

    const rawText = await generateText(userPrompt, SYSTEM_PROMPT, { workspaceId, purpose: 'sop_extraction' });

    if (!rawText) {
      throw new Error('Empty response from AI Provider.');
    }

    const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    let parsedData: any;
    try {
      parsedData = JSON.parse(cleanJson);
    } catch (jsonErr) {
      throw new Error(`Invalid JSON output from LLM: ${(jsonErr as Error).message}`);
    }

    // Fallback defaults for safety fields if model omitted them
    if (!parsedData.risk_level) parsedData.risk_level = 'Low';
    if (parsedData.requires_human_gate === undefined) {
      parsedData.requires_human_gate = parsedData.risk_level === 'High' || parsedData.risk_level === 'Critical';
    }

    // Validate using Zod schema
    const validated = ExtractedSOPSchema.parse(parsedData) as ExtractedSOP;

    if (!validated.is_valid_sop || validated.confidence_score < 0.4) {
      return null;
    }

    // Persist extracted graph entities and relationships into relational graph tables
    try {
      if (Array.isArray(validated.entities)) {
        for (const ent of validated.entities) {
          await addEntityNode(ent.type, {
            id: ent.id,
            name: ent.name,
            workspace_id: workspaceId,
          });
        }
      }

      if (Array.isArray(validated.relationships)) {
        for (const rel of validated.relationships) {
          await createRelationship(rel.source, rel.target, rel.relationship_type);
        }
      }
    } catch (graphErr) {
      logger.warn('[Extractor Warning] Graph persistence failed:', graphErr);
    }

    return validated;
  } catch (error) {
    const errorMsg = (error as Error).message || 'SOP extraction failed schema validation';
    logger.error('[Extractor Error]: Failed to extract SOP from thread:', errorMsg);

    // Audit log failure to ingestion_failures table
    try {
      await supabase.from('ingestion_failures').insert({
        workspace_id: workspaceId || null,
        source: source || 'unknown',
        raw_content: formattedTranscript,
        error_message: errorMsg,
      });
    } catch (dbErr) {
      logger.error('[Extractor Error]: Failed to write ingestion_failure log:', dbErr);
    }

    // Throw error so processThread can return HTTP 422 Unprocessable Entity
    throw new Error('SOP extraction failed schema validation');
  }
}