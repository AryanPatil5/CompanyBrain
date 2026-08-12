// Phase 3: spreadsheet text extraction (.xlsx/.xls/.csv) for the chunk
// pipeline (ADR-T15 parse stage). Spreadsheets become a deterministic
// text projection: sheet name, then one line per populated row with
// `column_header: value` pairs — enough structure for the chunker to keep
// operational data grounded without pretending to be a real data warehouse.

import * as XLSX from 'xlsx';
import { logger } from '../../logger.js';

export interface ParsedSpreadsheet {
  text: string;
  rows: number;
  sheets: number;
  format: 'xlsx' | 'xls' | 'csv';
}

const MAX_ROWS_PER_SHEET = 500;
const MAX_CELLS_PER_ROW = 200;

function renderSheet(name: string, rows: unknown[][]): string {
  if (rows.length === 0) return '';
  const header = rows[0];
  const lines: string[] = [];
  for (let i = 1; i < Math.min(rows.length, MAX_ROWS_PER_SHEET + 1); i++) {
    const row = rows[i];
    const parts: string[] = [];
    for (let c = 0; c < Math.min(row.length, MAX_CELLS_PER_ROW); c++) {
      const cell = row[c];
      if (cell == null || cell === '') continue;
      const label = header[c] != null && String(header[c]).trim() !== '' ? String(header[c]).trim() : `col_${c + 1}`;
      parts.push(`${label}: ${String(cell).trim()}`);
    }
    if (parts.length > 0) {
      lines.push(`row ${i}: ${parts.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

export async function parseSpreadsheet(buffer: Buffer, mimeType: string): Promise<ParsedSpreadsheet> {
  const format: ParsedSpreadsheet['format'] = mimeType.includes('csv')
    ? 'csv'
    : mimeType.includes('vnd.ms-excel')
      ? 'xls'
      : 'xlsx';

  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetNames = workbook.SheetNames;
  if (!sheetNames || sheetNames.length === 0) {
    throw new Error('Spreadsheet contains no sheets.');
  }

  const sections: string[] = [];
  let totalRows = 0;
  for (const sheetName of sheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
    const rendered = renderSheet(sheetName, rows);
    if (rendered) {
      sections.push(`### Sheet: ${sheetName}\n${rendered}`);
      totalRows += rows.length - 1;
    }
  }

  const text = sections.join('\n\n').trim();
  if (!text) {
    const msg = 'Spreadsheet parse produced no text (empty or image-only workbook).';
    logger.warn(`[SpreadsheetParser] ${msg}`);
    throw new Error(msg);
  }

  return { text, rows: totalRows, sheets: sheetNames.length, format };
}
