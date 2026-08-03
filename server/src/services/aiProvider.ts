import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Initialize Google GenAI client if API key is provided
let aiClient: GoogleGenAI | null = null;
if (GEMINI_API_KEY) {
  try {
    aiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  } catch (err) {
    console.warn('[AIProvider Warning] Failed to initialize GoogleGenAI client:', err);
  }
}

/**
 * Generates text completion using Gemini 2.0 Flash as primary provider,
 * with graceful fallback to local Ollama (llama3.2:3b) or OpenRouter/Mock.
 */
export async function generateText(prompt: string, systemPrompt?: string): Promise<string> {
  const fullSystemPrompt = systemPrompt || 'You are an Enterprise Knowledge AI Assistant.';

  // 1. Try Google Gemini API (gemini-2.0-flash)
  if (aiClient && GEMINI_API_KEY) {
    try {
      const response = await aiClient.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: prompt,
        config: {
          systemInstruction: fullSystemPrompt,
          temperature: 0.1,
        },
      });

      if (response && response.text) {
        return response.text.trim();
      }
    } catch (err) {
      console.warn('[AIProvider Warning] Gemini API call failed, attempting fallback:', (err as Error).message);
    }
  }

  // 2. Fallback to Local Ollama API (llama3.2:3b)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

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
      if (data.response) {
        return data.response.trim();
      }
    }
  } catch (ollamaErr) {
    // Ollama local server offline or unreachable
  }

  // 3. Fallback to OpenRouter API if key available
  if (OPENROUTER_API_KEY) {
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
          temperature: 0.1,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (content) return content;
      }
    } catch (openRouterErr) {
      // OpenRouter error
    }
  }

  throw new Error('All AI providers (Gemini, Ollama, OpenRouter) are unreachable or unconfigured.');
}

/**
 * Generates vector embeddings for a string or string array using local Ollama (nomic-embed-text).
 * Returns normalized 1536-dimensional array compatible with Supabase pgvector schema.
 */
export async function generateEmbeddings(textInput: string | string[]): Promise<number[]> {
  const text = Array.isArray(textInput) ? textInput.join(' ') : textInput;
  const cleanText = text.trim();

  if (!cleanText) {
    return new Array(1536).fill(0);
  }

  // Try Local Ollama Embedding API (nomic-embed-text)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'nomic-embed-text',
        prompt: cleanText,
      }),
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json();
      const rawVector: number[] = data.embedding || data.embeddings?.[0] || [];

      if (Array.isArray(rawVector) && rawVector.length > 0) {
        // Normalize vector length to 1536 for Supabase pgvector alignment
        if (rawVector.length === 1536) return rawVector;
        if (rawVector.length < 1536) {
          return [...rawVector, ...new Array(1536 - rawVector.length).fill(0)];
        }
        return rawVector.slice(0, 1536);
      }
    }
  } catch (err) {
    // Local Ollama offline — fallback below
  }

  // Fallback: Deterministic 1536-dimensional pseudo-embedding vector for offline / test environments
  const fallbackVector = new Array(1536).fill(0);
  for (let i = 0; i < cleanText.length; i++) {
    const charCode = cleanText.charCodeAt(i);
    const index = (i * 31 + charCode) % 1536;
    fallbackVector[index] = (fallbackVector[index] + charCode / 255) / 2;
  }
  return fallbackVector;
}
