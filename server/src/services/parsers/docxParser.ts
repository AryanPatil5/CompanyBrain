// Phase 3: .docx text extraction via mammoth (ADR-T15 parse stage).
// Returns the document's text plus a page/paragraph-oriented layout signal
// for the chunker. Throws typed errors on unreadable input; the worker maps
// them to extraction_stage='failed'.

import mammoth from 'mammoth';
import { logger } from '../../logger.js';

export interface ParsedDocumentText {
  text: string;
  paragraphs: number;
  /** Raw ext — always derived from the validated MIME, never from filenames. */
  format: 'docx';
}

export async function parseDocx(buffer: Buffer): Promise<ParsedDocumentText> {
  const result = await mammoth.extractRawText({ buffer });
  const text = (result?.value ?? '').trim();
  if (!text) {
    // Empty extraction is an explicit failure — an empty "document" cannot
    // be chunked or grounded. (Scanned/image-only .docx hits this path.)
    const msg = 'DOCX parse produced no text (possibly image-only or empty document).';
    logger.warn(`[DocxParser] ${msg}`);
    throw new Error(msg);
  }
  return {
    text,
    paragraphs: text.split(/\n{2,}/).length,
    format: 'docx',
  };
}
