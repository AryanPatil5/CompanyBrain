import dotenv from 'dotenv';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Critical';

export interface SOPStep {
  step_number: number;
  action: string;
  target_system: string;
  parameters?: Record<string, any>;
  condition?: string;
  on_failure?: string;
}

export interface ExtractedSOP {
  is_valid_sop: boolean;
  confidence_score: number;
  title: string;
  category: 'Engineering' | 'Support' | 'Billing' | 'Operations' | 'Security';
  trigger_condition: string;
  preconditions: string[];
  execution_steps: SOPStep[];
  risk_level: RiskLevel;
  requires_human_gate: boolean;
}

const SYSTEM_PROMPT = `
You are an expert Enterprise Knowledge Engineer. Your job is to analyze noisy team communications or tacit knowledge dictation (from Slack, GitHub, Linear, Zendesk, Email, Database Runbooks, or Direct Teach) and determine if a concrete, repeatable Standard Operating Procedure (SOP) was established.

### Risk Level & Safety Governance Rules:
- **Low Risk**: Pure read actions, logging, internal Slack posts (e.g., query status in Postgres, post message to #general).
- **Medium Risk**: Soft operational updates, low-value retry scheduling (e.g., retry failed invoice under $1000).
- **High Risk**: Direct database mutations, contract tier overrides, revoking keys, refunds > $500, modifying production infra.
- **Critical Risk**: Secret rotation, revoking admin credentials, bulk data deletion, financial overrides > $10,000.

If risk_level is "High" or "Critical", set "requires_human_gate" to true.

### Instructions:
1. Ignore casual banter, greetings, chit-chat, and irrelevant side conversations.
2. Focus ONLY on actionable problem-solving patterns, step-by-step procedures, or explicit decision rules.
3. If the input is an explicit tacit knowledge dictation or decree (e.g. "EXPLICIT OPERATIONAL SOP DECREE" or explicit step dictation), set "is_valid_sop" to true and "confidence_score" to 0.95.
4. If no operational procedure or rule is defined, set "is_valid_sop" to false.
5. Output MUST be strictly raw JSON adhering to the required structure. Do NOT wrap in markdown code blocks like \`\`\`json.
`;

export async function extractSOPFromThread(
  rawMessages: Array<{ user: string; text: string; timestamp?: string }>
): Promise<ExtractedSOP | null> {
  try {
    const formattedTranscript = rawMessages
      .map((msg) => `[${msg.user}]: ${msg.text}`)
      .join('\n');

    const userPrompt = `Analyze this transcript/dictation and extract an SOP object if a clear procedure exists:\n\n${formattedTranscript}\n\nReturn JSON output matching this schema:
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
  "risk_level": "Low" | "Medium" | "High" | "Critical",
  "requires_human_gate": boolean
}`;

    const response = await fetch(OPENROUTER_BASE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:5001',
        'X-Title': 'Company Brain',
      },
      body: JSON.stringify({
        model: 'inclusionai/ling-3.0-flash:free',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errBody}`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content?.trim();

    if (!rawText) {
      throw new Error('Empty response from OpenRouter.');
    }

    const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    console.log('[Extractor] Raw LLM output:', cleanJson.substring(0, 500));
    const parsedData: ExtractedSOP = JSON.parse(cleanJson);

    // Fallback defaults for safety fields if model omitted them
    if (!parsedData.risk_level) parsedData.risk_level = 'Low';
    if (parsedData.requires_human_gate === undefined) {
      parsedData.requires_human_gate = parsedData.risk_level === 'High' || parsedData.risk_level === 'Critical';
    }

    console.log('[Extractor] OpenRouter response:', JSON.stringify(parsedData, null, 2));

    if (!parsedData.is_valid_sop || parsedData.confidence_score < 0.4) {
      console.log(`[Extractor] Thread did not yield a high-confidence SOP (Confidence: ${parsedData.confidence_score})`);
      return null;
    }

    return parsedData;
  } catch (error) {
    console.error('[Extractor Error]: Failed to extract SOP from thread:', error);
    return null;
  }
}