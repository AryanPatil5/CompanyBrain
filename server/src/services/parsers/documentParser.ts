import { parseLayout, DocumentMetadata } from './layoutParser.js';
import { parsePdfWithVlmLayout } from './vlmLayoutParser.js';

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
 * Routes PDFs through VLM Layout Parser (vlmLayoutParser) for multi-column & structural table conversion,
 * and spreadsheets through layoutParser.
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
    const vlmResult = await parsePdfWithVlmLayout(fileBuffer, fileName);
    rawText = vlmResult.markdownText;
    tablesCount = vlmResult.tablesExtracted;
    metadata = {
      pageCount: 1,
      tablesExtracted: vlmResult.tablesExtracted,
      layoutStructure: vlmResult.columnsDetected > 1 ? 'multi_column_pdf' : 'structured_text',
      headersFound: vlmResult.columnsDetected,
      layoutType: vlmResult.columnsDetected > 1 ? 'pdf-vlm-multi-column' : 'pdf-vlm-single',
    };
  } else {
    const layoutResult = await parseLayout(fileBuffer, mimeType);
    rawText = layoutResult.markdownText;
    tablesCount = layoutResult.metadata.tablesExtracted;
    metadata = layoutResult.metadata;
  }

  // Segment text into structural sections based on Markdown heading levels (#, ##, ###)
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
