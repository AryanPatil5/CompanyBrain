import dotenv from 'dotenv';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Generates vector embeddings (1536 float values) for a text string
 * using OpenAI or OpenRouter embeddings endpoints.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const cleanText = text.trim();
  if (!cleanText) return null;

  // Try OpenAI API directly if key available
  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: cleanText,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data.data?.[0]?.embedding;
        if (Array.isArray(embedding)) return embedding;
      }
    } catch (err) {
      console.warn('[Embeddings] OpenAI API call failed:', err);
    }
  }

  // Try OpenRouter API endpoint
  if (OPENROUTER_API_KEY) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:5001',
          'X-Title': 'Company Brain',
        },
        body: JSON.stringify({
          model: 'openai/text-embedding-3-small',
          input: cleanText,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const embedding = data.data?.[0]?.embedding;
        if (Array.isArray(embedding)) return embedding;
      }
    } catch (err) {
      console.warn('[Embeddings] OpenRouter API call failed:', err);
    }
  }

  console.warn('[Embeddings] Failed to generate embedding vector; key missing or API unreachable.');
  return null;
}
