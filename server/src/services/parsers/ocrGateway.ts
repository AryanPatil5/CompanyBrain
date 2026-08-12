// Phase 3: OCR gateway — an explicit seam for scanned-image documents.
//
// Per the Phase 3 architecture decision, real OCR (tesseract/cloud vision)
// is OUT of scope. The gateway must therefore:
//   - detect OCR-required documents (scanned PDFs) — delegated to the
//     existing pdfExtractor.isScannedOcrRequired signal
//   - REFUSE to pretend success: performOcr() always returns null and logs;
//     the worker marks such documents extraction_stage='ocr_required'
//     (an explicit terminal state, never a fake extraction)
// A future Phase can swap in a real OCR backend behind this same interface
// without touching the pipeline.

import { logger } from '../../logger.js';

export interface OcrOutcome {
  text: string;
  engine: string;
}

/** Returns true when the document can only be understood via OCR. */
export function requiresOcr(mimeType: string, pdfMeta?: { isScanned?: boolean }): boolean {
  if (mimeType.includes('pdf')) {
    return pdfMeta?.isScanned === true;
  }
  return false;
}

/**
 * OCR is not implemented in Phase 3: ALWAYS returns null (never fabricates
 * extracted text). Callers must treat null as "OCR required/unsupported" and
 * move the document to the ocr_required stage.
 */
export async function performOcr(_buffer: Buffer, _mimeType: string): Promise<OcrOutcome | null> {
  logger.warn('[OcrGateway] OCR is not implemented in Phase 3 (ADR decision); returning null.');
  return null;
}
