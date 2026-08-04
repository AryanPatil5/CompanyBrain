import { parsePdfWithVlmLayout, convertTableToMarkdown } from '../../src/services/parsers/vlmLayoutParser.js';
import { parseDocument } from '../../src/services/parsers/documentParser.js';

export async function runVlmLayoutParserTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running VLM Layout PDF Parser Test Suite       ');
  console.log('=================================================');

  // Test 1: Table-to-Markdown matrix conversion
  try {
    const markdownTable = convertTableToMarkdown(
      ['Asset', 'Value ($K)', 'Status'],
      [
        ['Server Cluster A', '450', 'Active'],
        ['Database Primary', '1200', 'Active'],
      ]
    );

    if (!markdownTable.includes('| Asset | Value ($K) | Status |') || !markdownTable.includes('| Server Cluster A | 450 | Active |')) {
      console.error('❌ VLM PARSER TEST FAILED: Markdown table matrix conversion mismatch!', markdownTable);
      return false;
    }
    console.log('✅ VLM PARSER TEST PASSED: Successfully converted visual table matrix into clean Markdown table format.');
  } catch (err: any) {
    console.error('❌ VLM PARSER TEST EXCEPTION (Table Matrix):', err.message);
    return false;
  }

  // Test 2: 2-Column PDF Layout & Financial Table Extraction
  try {
    const pdfBuffer = Buffer.from('Financial Summary Report Q1 Revenue 12.4 Expenses 8.2 Column A Column B Sidebar');
    const vlmResult = await parsePdfWithVlmLayout(pdfBuffer, 'financial_report_2026.pdf');

    if (vlmResult.tablesExtracted === 0 || vlmResult.columnsDetected !== 2 || !vlmResult.markdownText.includes('| Q1 2026 | 12.4 |')) {
      console.error('❌ VLM PARSER TEST FAILED: Multi-column or table extraction failed!', vlmResult);
      return false;
    }
    console.log('✅ VLM PARSER TEST PASSED: Successfully parsed 2-column layout and extracted financial summary table without cell corruption.');
  } catch (err: any) {
    console.error('❌ VLM PARSER TEST EXCEPTION (Multi-column PDF):', err.message);
    return false;
  }

  // Test 3: DocumentParser integration routing for PDF files
  try {
    const pdfBuffer = Buffer.from('Quarterly Financial Summary Q1 2026 Revenue');
    const docResult = await parseDocument(pdfBuffer, 'application/pdf', 'q1_report.pdf');

    if (docResult.tablesCount === 0 || docResult.sections.length === 0) {
      console.error('❌ VLM PARSER TEST FAILED: DocumentParser failed to route PDF via VLM layout engine!', docResult);
      return false;
    }
    console.log(`✅ VLM PARSER TEST PASSED: DocumentParser successfully routed PDF buffer and produced ${docResult.sections.length} structural sections.`);
  } catch (err: any) {
    console.error('❌ VLM PARSER TEST EXCEPTION (DocumentParser Routing):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVlmLayoutParserTest().then((success) => {
    if (!success) process.exit(1);
  });
}
