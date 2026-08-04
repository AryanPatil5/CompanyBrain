import crypto from 'node:crypto';

export interface TextChunk {
  chunk_index: number;
  content: string;
  content_hash: string;
  token_count_estimate: number;
  metadata: Record<string, any>;
}

export interface ChunkTextOptions {
  maxChars?: number;
  overlapChars?: number;
  metadata?: Record<string, any>;
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function chunkText(text: string, options: ChunkTextOptions = {}): TextChunk[] {
  const cleanText = text.trim();
  if (!cleanText) return [];

  const maxChars = Math.max(500, options.maxChars || 3000);
  const overlapChars = Math.max(0, Math.min(options.overlapChars || 250, Math.floor(maxChars / 3)));
  const chunks: TextChunk[] = [];

  let cursor = 0;
  while (cursor < cleanText.length) {
    const hardEnd = Math.min(cursor + maxChars, cleanText.length);
    let end = hardEnd;

    if (hardEnd < cleanText.length) {
      const paragraphBreak = cleanText.lastIndexOf('\n\n', hardEnd);
      const sentenceBreak = cleanText.lastIndexOf('. ', hardEnd);
      const softBreak = Math.max(paragraphBreak, sentenceBreak);
      if (softBreak > cursor + Math.floor(maxChars * 0.5)) {
        end = softBreak + (softBreak === sentenceBreak ? 1 : 0);
      }
    }

    const content = cleanText.slice(cursor, end).trim();
    if (content) {
      chunks.push({
        chunk_index: chunks.length,
        content,
        content_hash: hashContent(content),
        token_count_estimate: estimateTokens(content),
        metadata: {
          ...(options.metadata || {}),
          char_start: cursor,
          char_end: end,
        },
      });
    }

    if (end >= cleanText.length) break;
    cursor = Math.max(end - overlapChars, cursor + 1);
  }

  return chunks;
}

