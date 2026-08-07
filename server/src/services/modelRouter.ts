import { logger } from '../logger.js';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');

let aiClient: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (err) {
    logger.warn('[ModelRouter Warning] Failed to initialize GoogleGenAI client:', err);
  }
}

export interface ModelCompletionRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelCompletionResponse {
  text: string;
  provider: 'google' | 'openrouter' | 'ollama' | string;
  model: string;
  tokensUsed: {
    input: number;
    output: number;
  };
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

/**
 * Enterprise Model Routing Service
 * Handles multi-provider load balancing, token accounting, and automatic exponential backoff on 429 Rate Limit errors.
 */
export async function routeCompletion(
  request: ModelCompletionRequest
): Promise<ModelCompletionResponse> {
  const { prompt, systemPrompt, temperature = 0.1, maxTokens } = request;
  const fullSystemPrompt = systemPrompt || 'You are an Enterprise Knowledge AI Assistant.';
  const inputTokens = estimateTokens(`${fullSystemPrompt} ${prompt}`);

  // ─── Tier 1: Google Gemini 2.0 Flash (Primary) ─────────────────────
  if (aiClient && GEMINI_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await aiClient.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: prompt,
          config: {
            systemInstruction: fullSystemPrompt,
            temperature,
            maxOutputTokens: maxTokens,
            httpOptions: { timeout: 15_000 },
          },
        });

        if (response && response.text) {
          const text = response.text.trim();
          return {
            text,
            provider: 'google',
            model: 'gemini-2.0-flash',
            tokensUsed: {
              input: inputTokens,
              output: estimateTokens(text),
            },
          };
        }
      } catch (err: any) {
        const isRateLimit =
          err.message?.includes('429') ||
          err.message?.includes('RESOURCE_EXHAUSTED') ||
          err.status === 429;

        if (isRateLimit) {
          const delayMs = 1000 * Math.pow(2, attempt);
          logger.warn(`[ModelRouter Warning] Gemini 429 Rate Limit (Attempt ${attempt + 1}). Backing off for ${delayMs}ms...`);
          await sleep(delayMs);
        } else {
          logger.warn('[ModelRouter Warning] Gemini API call failed:', err.message);
          break; // Non-429 error, failover immediately to OpenRouter
        }
      }
    }
  }

  // ─── Tier 2: OpenRouter API (Secondary Fallback) ───────────────────
  if (OPENROUTER_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
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
              { role: 'system', content: fullSystemPrompt },
              { role: 'user', content: prompt },
            ],
            temperature,
            max_tokens: maxTokens,
          }),
        });

        if (res.status === 429) {
          const delayMs = 1000 * Math.pow(2, attempt);
          logger.warn(`[ModelRouter Warning] OpenRouter 429 Rate Limit (Attempt ${attempt + 1}). Backing off for ${delayMs}ms...`);
          await sleep(delayMs);
          continue;
        }

        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content?.trim();
          if (text) {
            return {
              text,
              provider: 'openrouter',
              model: 'inclusionai/ling-3.0-flash:free',
              tokensUsed: {
                input: data.usage?.prompt_tokens || inputTokens,
                output: data.usage?.completion_tokens || estimateTokens(text),
              },
            };
          }
        }
      } catch (openRouterErr: any) {
        logger.warn('[ModelRouter Warning] OpenRouter API call failed:', openRouterErr.message);
        break;
      }
    }
  }

  // ─── Tier 3: Local Ollama llama3.2:3b (Tertiary Fallback) ─────────
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: `${fullSystemPrompt}\n\n${prompt}`,
        stream: false,
      }),
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const text = data.response?.trim();
      if (text) {
        return {
          text,
          provider: 'ollama',
          model: 'llama3.2:3b',
          tokensUsed: {
            input: data.prompt_eval_count || inputTokens,
            output: data.eval_count || estimateTokens(text),
          },
        };
      }
    }
  } catch {
    // Local Ollama offline
  }

  throw new Error('All AI Providers (Gemini, OpenRouter, Ollama) failed or are unreachable.');
}
