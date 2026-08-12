// Hermetic unit tests for the Phase 3 spreadsheet parser (ADR-T15 parse
// stage): deterministic text projection of .xlsx/.csv, row/sheet/format
// signals, header-less column fallbacks, and the explicit empty-workbook
// failure.

import { installHarness } from '../harness/index.js';
import * as XLSX from 'xlsx';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ SPREADSHEET PARSER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ SPREADSHEET PARSER TEST FAILED: ${name}`, extra ?? '');
  }
}

function buildXlsx(rows: unknown[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ops');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function runSpreadsheetParserTests(): Promise<boolean> {
  await installHarness();
  const { parseSpreadsheet } = await import('../../src/services/parsers/spreadsheetParser.js');

  try {
    // ─── 1. xlsx happy path: header:value projection ──────────────────────
    const xlsx = buildXlsx([
      ['service', 'region', 'owner'],
      ['payments', 'us-east-1', 'alice'],
      ['billing', 'eu-west-1', 'bob'],
    ]);
    const parsed = await parseSpreadsheet(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    check('xlsx: text carries sheet heading', parsed.text.includes('### Sheet: Ops'), parsed.text.slice(0, 200));
    check('xlsx: text carries column:value projection', parsed.text.includes('service: payments') && parsed.text.includes('owner: alice'), parsed.text.slice(0, 300));
    check('xlsx: header row is not emitted as data', !parsed.text.includes('service: service') && !parsed.text.includes('row 0'), parsed.text.slice(0, 300));
    check('xlsx: reports data rows (excludes header)', parsed.rows === 2, parsed.rows);
    check('xlsx: reports sheet count', parsed.sheets === 1);
    check('xlsx: reports xlsx format', parsed.format === 'xlsx');

    // ─── 2. First row is treated as the header and used as labels ─────────
    const noHeader = buildXlsx([
      ['value'],
      ['critical'],
      ['ok'],
    ]);
    const noHeaderParsed = await parseSpreadsheet(noHeader, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    check('header row: used as column labels', noHeaderParsed.text.includes('value: critical') && noHeaderParsed.text.includes('value: ok'), noHeaderParsed.text);
    check('header row: excluded from emitted rows', !noHeaderParsed.text.includes('row 0'), noHeaderParsed.text);
    check('header row: data rows counted correctly', noHeaderParsed.rows === 2, noHeaderParsed.rows);

    // ─── 3. csv format detection + parsing ────────────────────────────────
    const csv = Buffer.from('severity,count\nhigh,3\nlow,7', 'utf-8');
    const csvParsed = await parseSpreadsheet(csv, 'text/csv');
    check('csv: format detected as csv', csvParsed.format === 'csv');
    check('csv: projection applied', csvParsed.text.includes('severity: high') && csvParsed.text.includes('count: 7'), csvParsed.text);
    check('csv: rows counted correctly', csvParsed.rows === 2, csvParsed.rows);

    // ─── 4. Empty workbook -> explicit failure (no fake text) ─────────────
    let emptyErr: unknown = null;
    try {
      const ws = XLSX.utils.aoa_to_sheet([]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Empty');
      await parseSpreadsheet(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (err) {
      emptyErr = err;
    }
    check('empty workbook throws (never yields empty text)', emptyErr instanceof Error && /no text/.test((emptyErr as Error).message), emptyErr);

    // ─── 5. Garbage buffer -> throws ──────────────────────────────────────
    let garbageErr: unknown = null;
    try {
      await parseSpreadsheet(Buffer.from('not a spreadsheet'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (err) {
      garbageErr = err;
    }
    check('garbage buffer throws', garbageErr instanceof Error, garbageErr);
  } catch (err: any) {
    check('Spreadsheet parser suite ran', false, err.message);
  }

  console.log(`\n[Spreadsheet Parser Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSpreadsheetParserTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
