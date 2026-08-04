import pdfParse from 'pdf-parse';

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  isScannedOcrRequired: boolean;
  error?: string;
}

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit

/**
 * Real PDF text extractor using pdf-parse.
 * Extracts actual text and page count from PDF binary buffer.
 * Detects scanned image-only PDFs and password-protected files.
 */
export async function extractTextFromPdf(fileBuffer: Buffer): Promise<PdfExtractionResult> {
  if (!fileBuffer || fileBuffer.length === 0) {
    return { text: '', pageCount: 0, isScannedOcrRequired: false, error: 'Empty PDF buffer provided' };
  }

  if (fileBuffer.length > MAX_PDF_SIZE_BYTES) {
    return {
      text: '',
      pageCount: 0,
      isScannedOcrRequired: false,
      error: `PDF file size exceeds maximum allowed limit of ${MAX_PDF_SIZE_BYTES / (1024 * 1024)}MB`,
    };
  }

  try {
    const data = await pdfParse(fileBuffer);
    const extractedText = (data.text || '').trim();
    const pageCount = data.numpages || 1;

    // Detect scanned image-only PDF with missing text layer
    const cleanTextLength = extractedText.replace(/[\s\x00-\x1F]/g, '').length;
    if (fileBuffer.length > 500 && cleanTextLength < 20) {
      return {
        text: '',
        pageCount,
        isScannedOcrRequired: true,
        error: '[OCR Pipeline Required]: Scanned image PDF detected with missing text layer.',
      };
    }

    return {
      text: extractedText,
      pageCount,
      isScannedOcrRequired: false,
    };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);

    // Password-protected PDF detection
    if (errorMsg.includes('Password') || errorMsg.includes('encrypted') || errorMsg.includes('password')) {
      return {
        text: '',
        pageCount: 0,
        isScannedOcrRequired: false,
        error: 'Password-protected PDF document; cannot extract text without credentials.',
      };
    }

    // General parsing failure
    return {
      text: '',
      pageCount: 0,
      isScannedOcrRequired: fileBuffer.length > 500,
      error: `PDF extraction error: ${errorMsg}`,
    };
  }
}
