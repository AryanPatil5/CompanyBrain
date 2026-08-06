import { parseLayout, convertTabularTextToMarkdown, DocumentMetadata } from './layoutParser.js';
import { extractTextFromPdf } from './pdfExtractor.js';

export interface ParsedSection {
  heading: string;
  level: number;
  content: string;
}

export interface ParsedDocumentResult {
  rawText: string;
  sections: ParsedSection[];
  tablesCount: number;
  mimeType: string;
  metadata?: DocumentMetadata;
}

/**
 * Layout-aware document parser service.
 * Routes PDFs through real pdf-parse extractor (extractTextFromPdf) and spreadsheets through layoutParser.
 */
export async function parseDocument(
  fileBuffer: Buffer,
  mimeType: string = 'text/plain',
  fileName = 'document'
): Promise<ParsedDocumentResult> {
  let rawText = '';
  let tablesCount = 0;
  let metadata: DocumentMetadata | undefined = undefined;

  if (mimeType.includes('pdf') || fileName.endsWith('.pdf')) {
    const pdfResult = await extractTextFromPdf(fileBuffer);

    if (pdfResult.isScannedOcrRequired || pdfResult.error || !pdfResult.text) {
      // Graceful fallback for buffers declared as PDF but containing plain text
      // (e.g., corrupt files or mislabeled uploads). Real PDFs start with the
      // '%PDF-' magic header; anything else is parsed as text instead of erroring.
      // Buffers without meaningful printable text keep the OCR-required signal.
      const textContent = fileBuffer.toString('utf-8');
      const meaningfulText = textContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
      if (!fileBuffer.subarray(0, 5).toString('utf-8').startsWith('%PDF-') && meaningfulText.length > 0) {
        const { markdownText, tablesExtracted } = convertTabularTextToMarkdown(textContent);
        return {
          rawText: markdownText,
          sections: extractHeadingSections(markdownText),
          tablesCount: tablesExtracted,
          mimeType,
          metadata: {
            pageCount: 1,
            tablesExtracted,
            layoutStructure: 'structured_text',
            headersFound: 0,
            layoutType: 'text-fallback',
          },
        };
      }

      return {
        rawText: pdfResult.error || pdfResult.text || '',
        sections: [],
        tablesCount: 0,
        mimeType,
        metadata: {
          pageCount: pdfResult.pageCount || 1,
          tablesExtracted: 0,
          layoutStructure: 'scanned_ocr_required',
          headersFound: 0,
          layoutType: 'pdf-real-text',
        },
      };
    }

    rawText = pdfResult.text;
    tablesCount = 0; // Honest table count
    metadata = {
      pageCount: pdfResult.pageCount,
      tablesExtracted: 0,
      layoutStructure: 'structured_text',
      headersFound: 1,
      layoutType: 'pdf-real-text',
    };
  } else {
    const layoutResult = await parseLayout(fileBuffer, mimeType);
    rawText = layoutResult.markdownText;
    tablesCount = layoutResult.metadata.tablesExtracted;
    metadata = layoutResult.metadata;
  }

  // Segment text into structural sections based on Markdown heading levels (#, ##, ###) or fallback Overview
  const sections = extractHeadingSections(rawText);

  return {
    rawText,
    sections,
    tablesCount,
    mimeType,
    metadata,
  };
}

function extractHeadingSections(text: string): ParsedSection[] {
  const lines = text.split('\n');
  const sections: ParsedSection[] = [];

  let currentHeading = 'Overview';
  let currentLevel = 1;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          content: currentLines.join('\n').trim(),
        });
        currentLines = [];
      }
      currentLevel = headingMatch[1].length;
      currentHeading = headingMatch[2].trim();
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      content: currentLines.join('\n').trim(),
    });
  }

  return sections;
}
