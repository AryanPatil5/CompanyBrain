import * as XLSX from 'xlsx';
import { parsePdfWithLayout, parseSpreadsheet } from '../../src/services/parsers/layoutParser.js';

export async function runLayoutParserTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Layout-Aware Document & Table Parser Test');
  console.log('=================================================');

  // Test 1: Extract 5-column financial table from PDF content into valid Markdown table syntax
  try {
    const pdfContent = `
# Financial Report 2026
Q1 Revenue\tQ2 Revenue\tQ3 Revenue\tQ4 Revenue\tTotal Net
$150,000\t$180,000\t$210,000\t$250,000\t$790,000
    `;
    const pdfBuf = Buffer.from(pdfContent, 'utf-8');
    const pdfRes = await parsePdfWithLayout(pdfBuf);

    if (!pdfRes.markdownText.includes('| Q1 Revenue | Q2 Revenue | Q3 Revenue | Q4 Revenue | Total Net |')) {
      console.error('❌ LAYOUT PARSER TEST FAILED: 5-column table was not converted into Markdown syntax!', pdfRes.markdownText);
      return false;
    }
    if (pdfRes.metadata.tablesExtracted !== 1) {
      console.error('❌ LAYOUT PARSER TEST FAILED: Table count mismatch!', pdfRes.metadata);
      return false;
    }
    console.log('✅ LAYOUT PARSER TEST PASSED: Successfully extracted 5-column financial table into clean Markdown syntax.');
  } catch (err: any) {
    console.error('❌ LAYOUT PARSER TEST EXCEPTION (PDF Table):', err.message);
    return false;
  }

  // Test 2: Parse multi-column PDF document without merging adjacent column text
  try {
    const multiColPdf = `
Section A Header               Section B Header
Primary column description text here.   Secondary column notes and information here.
    `;
    const buf = Buffer.from(multiColPdf, 'utf-8');
    const res = await parsePdfWithLayout(buf);

    if (!res.markdownText.includes('| Section A Header | Section B Header |')) {
      console.error('❌ LAYOUT PARSER TEST FAILED: Multi-column headers merged incorrectly!', res.markdownText);
      return false;
    }
    console.log('✅ LAYOUT PARSER TEST PASSED: Preserved multi-column layout boundaries without line merging.');
  } catch (err: any) {
    console.error('❌ LAYOUT PARSER TEST EXCEPTION (Multi-column PDF):', err.message);
    return false;
  }

  // Test 3: Extract all worksheets from XLSX file into labelled Markdown sections
  try {
    const wb = XLSX.utils.book_new();
    const ws1Data = [
      ['Metric', 'Value'],
      ['MRR', '$50,000'],
      ['ARR', '$600,000'],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(ws1Data);
    XLSX.utils.book_append_sheet(wb, ws1, 'Financials');

    const ws2Data = [
      ['Employee', 'Role'],
      ['Alice', 'Engineering Manager'],
      ['Bob', 'Staff Architect'],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(ws2Data);
    XLSX.utils.book_append_sheet(wb, ws2, 'Headcount');

    const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const xlsxRes = await parseSpreadsheet(xlsxBuffer);

    if (
      !xlsxRes.markdownText.includes('## Table from Section: [Financials]') ||
      !xlsxRes.markdownText.includes('## Table from Section: [Headcount]') ||
      !xlsxRes.markdownText.includes('| MRR | $50,000 |')
    ) {
      console.error('❌ LAYOUT PARSER TEST FAILED: Multi-sheet XLSX parsing mismatch!', xlsxRes.markdownText);
      return false;
    }

    if (xlsxRes.metadata.tablesExtracted !== 2) {
      console.error('❌ LAYOUT PARSER TEST FAILED: Sheet tables count mismatch!', xlsxRes.metadata);
      return false;
    }

    console.log('✅ LAYOUT PARSER TEST PASSED: Successfully parsed multi-sheet XLSX into labelled Markdown sections with tab titles.');
  } catch (err: any) {
    console.error('❌ LAYOUT PARSER TEST EXCEPTION (XLSX Parsing):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLayoutParserTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
