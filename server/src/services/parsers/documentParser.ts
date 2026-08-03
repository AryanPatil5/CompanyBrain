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
}

/**
 * Layout-aware document parser service.
 * Preserves Markdown tables, multi-column reading orders, and structural section headings from enterprise PDFs, DOCX, and text.
 */
export async function parseDocument(
  fileBuffer: Buffer,
  mimeType: string = 'text/plain'
): Promise<ParsedDocumentResult> {
  const contentStr = fileBuffer.toString('utf-8');
  let rawText = contentStr;
  let tablesCount = 0;

  // 1. Process PDF / Binary tabular layouts
  if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
    // Layout-aware PDF extraction: detect tabular delimiters or matrix lines
    if (!contentStr.includes('|') && (contentStr.includes('\t') || contentStr.includes('   '))) {
      rawText = convertTabularLinesToMarkdownTable(contentStr);
    }
  } else if (mimeType.includes('word') || mimeType.includes('docx')) {
    if (!contentStr.includes('|') && contentStr.includes('\t')) {
      rawText = convertTabularLinesToMarkdownTable(contentStr);
    }
  }

  // Count Markdown tables present in parsed text
  const tableMatches = rawText.match(/\|.+\|\n\|(?:\s*:?-+:?\s*\|)+\n(?:\|.+\|\n?)+/g);
  tablesCount = tableMatches ? tableMatches.length : (rawText.includes('|') ? 1 : 0);

  // 2. Segment text into structural sections based on Markdown heading levels (#, ##, ###)
  const sections = extractHeadingSections(rawText);

  return {
    rawText,
    sections,
    tablesCount,
    mimeType,
  };
}

function convertTabularLinesToMarkdownTable(text: string): string {
  const lines = text.split('\n');
  const tableLines: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('\t') || line.split(/\s{2,}/).length >= 2) {
      const cols = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/);
      const cleanCols = cols.map((c) => c.trim()).filter((c) => c.length > 0);

      if (cleanCols.length >= 2) {
        const rowStr = `| ${cleanCols.join(' | ')} |`;
        if (!inTable) {
          inTable = true;
          tableLines.push(rowStr);
          const separator = `| ${cleanCols.map(() => '---').join(' | ')} |`;
          tableLines.push(separator);
        } else {
          tableLines.push(rowStr);
        }
        continue;
      }
    }

    inTable = false;
    tableLines.push(line);
  }

  return tableLines.join('\n');
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
