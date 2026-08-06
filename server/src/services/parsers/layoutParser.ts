import { extractTextFromPdf } from './pdfExtractor.js';

export interface DocumentMetadata {
  pageCount: number;
  tablesExtracted: number;
  sheetNames?: string[];
  layoutStructure: 'multi_column_pdf' | 'spreadsheet' | 'scanned_ocr_required' | 'structured_text';
  headersFound?: number;
  layoutType?: string;
}

export interface LayoutParseResult {
  markdownText: string;
  metadata: DocumentMetadata;
}

/**
 * Converts tab-separated / multi-space aligned rows into Markdown table syntax.
 * Shared by the PDF layout path and the plain-text fallback so table
 * formatting is consistent across both.
 */
export function convertTabularTextToMarkdown(contentStr: string): { markdownText: string; tablesExtracted: number } {
  const lines = contentStr.split('\n');
  const markdownLines: string[] = [];
  let tablesExtracted = 0;
  let inTable = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Multi-column or tabular detection (tab-separated or multi-space aligned)
    const isTabular = line.includes('\t') || line.split(/\s{2,}/).length >= 2;

    if (isTabular) {
      const cols = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/);
      const cleanCols = cols.map((c) => c.trim()).filter((c) => c.length > 0);

      if (cleanCols.length >= 2) {
        const rowStr = `| ${cleanCols.join(' | ')} |`;
        if (!inTable) {
          inTable = true;
          tablesExtracted++;
          markdownLines.push(rowStr);
          markdownLines.push(`| ${cleanCols.map(() => '---').join(' | ')} |`);
        } else {
          markdownLines.push(rowStr);
        }
        continue;
      }
    }

    inTable = false;
    markdownLines.push(line);
  }

  return {
    markdownText: markdownLines.join('\n').trim(),
    tablesExtracted,
  };
}

/**
 * Parses PDF documents preserving text layout boundaries and table detection using real PDF extraction.
 */
export async function parsePdfWithLayout(fileBuffer: Buffer): Promise<LayoutParseResult> {
  const pdfResult = await extractTextFromPdf(fileBuffer);

  if (pdfResult.isScannedOcrRequired || pdfResult.error || !pdfResult.text) {
    // Graceful fallback for buffers declared as PDF but containing plain text
    // (e.g., corrupt files or mislabeled uploads). Real PDFs start with the
    // '%PDF-' magic header; anything else is parsed as text instead of erroring.
    const textContent = fileBuffer.toString('utf-8');
    const meaningfulText = textContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
    if (!fileBuffer.subarray(0, 5).toString('utf-8').startsWith('%PDF-') && meaningfulText.length > 0) {
      const { markdownText, tablesExtracted } = convertTabularTextToMarkdown(textContent);
      return {
        markdownText,
        metadata: {
          pageCount: 1,
          tablesExtracted,
          layoutStructure: 'structured_text',
        },
      };
    }

    throw new Error(pdfResult.error || '[OCR Pipeline Required]: Scanned image PDF detected with missing text layer.');
  }

  const { markdownText, tablesExtracted } = convertTabularTextToMarkdown(pdfResult.text);

  return {
    markdownText,
    metadata: {
      pageCount: pdfResult.pageCount || 1,
      tablesExtracted,
      layoutStructure: 'multi_column_pdf',
    },
  };
}

/**
 * Parses Spreadsheet files (.xlsx, .xls, .csv) into structured Markdown tables with worksheet headings.
 */
export async function parseSpreadsheet(fileBuffer: Buffer): Promise<LayoutParseResult> {
  const pkgName = 'xlsx';
  const XLSXModule: any = await import(/* template */ pkgName);
  const XLSX = XLSXModule.default || XLSXModule;

  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetNames = workbook.SheetNames || [];
  const markdownSections: string[] = [];
  let tablesExtracted = 0;

  for (const sheetName of sheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rows: string[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    if (!rows || rows.length === 0) continue;

    tablesExtracted++;
    markdownSections.push(`## Table from Section: [${sheetName}]`);

    // Clean null/undefined cells
    const cleanRows = rows
      .filter((row) => Array.isArray(row) && row.length > 0)
      .map((row) => row.map((cell) => (cell !== undefined && cell !== null ? String(cell).trim() : '')));

    if (cleanRows.length === 0) continue;

    // Header row
    const headerRow = cleanRows[0];
    markdownSections.push(`| ${headerRow.join(' | ')} |`);
    markdownSections.push(`| ${headerRow.map(() => '---').join(' | ')} |`);

    // Data rows with header repetition for row windowing if large
    for (let r = 1; r < cleanRows.length; r++) {
      const dataRow = cleanRows[r];
      // Pad empty cells to align with header columns
      while (dataRow.length < headerRow.length) {
        dataRow.push('');
      }
      markdownSections.push(`| ${dataRow.slice(0, headerRow.length).join(' | ')} |`);
    }

    markdownSections.push('\n');
  }

  return {
    markdownText: markdownSections.join('\n').trim(),
    metadata: {
      pageCount: sheetNames.length,
      tablesExtracted,
      sheetNames,
      layoutStructure: 'spreadsheet',
    },
  };
}

/**
 * Primary layout-aware document parser router.
 */
export async function parseLayout(fileBuffer: Buffer, mimeType: string): Promise<LayoutParseResult> {
  const lowerMime = mimeType.toLowerCase();

  if (
    lowerMime.includes('spreadsheet') ||
    lowerMime.includes('excel') ||
    lowerMime.includes('xlsx') ||
    lowerMime.includes('csv')
  ) {
    return parseSpreadsheet(fileBuffer);
  }

  if (lowerMime.includes('pdf')) {
    return parsePdfWithLayout(fileBuffer);
  }

  // Text / Structured Markdown fallback
  const contentStr = fileBuffer.toString('utf-8');
  return {
    markdownText: contentStr,
    metadata: {
      pageCount: 1,
      tablesExtracted: contentStr.includes('|') ? 1 : 0,
      layoutStructure: 'structured_text',
    },
  };
}
