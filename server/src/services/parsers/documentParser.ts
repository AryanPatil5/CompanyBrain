import { parseLayout, DocumentMetadata } from './layoutParser.js';

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
 * Routes PDFs, XLSX spreadsheets, and CSV documents through layoutParser preserving structural tables and section headers.
 */
export async function parseDocument(
  fileBuffer: Buffer,
  mimeType: string = 'text/plain'
): Promise<ParsedDocumentResult> {
  const layoutResult = await parseLayout(fileBuffer, mimeType);
  const rawText = layoutResult.markdownText;

  // Segment text into structural sections based on Markdown heading levels (#, ##, ###)
  const sections = extractHeadingSections(rawText);

  return {
    rawText,
    sections,
    tablesCount: layoutResult.metadata.tablesExtracted,
    mimeType,
    metadata: layoutResult.metadata,
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
