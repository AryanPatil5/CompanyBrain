import dotenv from 'dotenv';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
}

const SYSTEM_PROMPT = `
You are an expert Enterprise Knowledge Engineer. Your job is to analyze noisy team communication transcripts (from Slack, Linear, or GitHub) and determine if a concrete, repeatable Standard Operating Procedure (SOP) or Operational Decision Rule was established.

### Instructions:
1. Ignore casual banter, greetings, chit-chat, and irrelevant side conversations.
2. Focus ONLY on actionable problem-solving patterns, step-by-step procedures, or explicit decision rules confirmed by a senior team member.
3. If no operational procedure or rule is clearly defined in the transcript, set "is_valid_sop" to false.
4. For each execution step, extract the conditional logic (when this step applies) and failure handling (what to do if this step fails).
5. Extract specific parameters, thresholds, and configuration values mentioned in the conversation.
6. Output MUST be strictly raw JSON adhering to the required structure. Do NOT wrap in markdown code blocks like \`\`\`json.
`;

export async function extractSOPFromThread(
  rawMessages: Array<{ user: string; text: string; timestamp?: string }>
): Promise<ExtractedSOP | null> {
  try {
    const formattedTranscript = rawMessages
      .map((msg) => `[${msg.user}]: ${msg.text}`)
      .join('\n');

    const userPrompt = `Analyze this thread transcript and extract an SOP object if a clear procedure exists:\n\n${formattedTranscript}\n\nReturn JSON output matching this schema:
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
      "target_system": string (e.g. "Stripe", "Slack", "Postgres", "Admin CLI"),
      "parameters": object with specific values/thresholds extracted from the conversation,
      "condition": string or null — when this specific step applies (e.g. "if ARR > 25k"),
      "on_failure": string or null — fallback action if this step fails
    }
  ]
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

    // Strip markdown code fences if the model wraps the response
    const cleanJson = rawText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    console.log('[Extractor] Raw LLM output:', cleanJson.substring(0, 500));
    const parsedData: ExtractedSOP = JSON.parse(cleanJson);

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