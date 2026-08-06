import { parseDocument } from '../../src/services/parsers/documentParser.ts';

export async function runDocumentParserTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Layout-Aware Document Parser Test Suite');
  console.log('=================================================');

  // 1. Mock Multi-Column Tabular Document Buffer
  const tabularRawContent = `
# Enterprise Tier Pricing & Approval Matrix

Tier Name\tMin ARR\tMax Discount\tRequired Gate
Starter\t$0\t5%\tAutomated
Growth\t$10000\t15%\tTeam Lead
Enterprise\t$50000\t30%\tDirector Approval
`;

  const pdfBuffer = Buffer.from(tabularRawContent, 'utf-8');

  // 2. Process Document via parseDocument
  const parsed = await parseDocument(pdfBuffer, 'application/pdf');

  if (!parsed.rawText || !Array.isArray(parsed.sections)) {
    console.error('❌ DOCUMENT PARSER TEST FAILED: Output missing rawText or sections!');
    return false;
  }

  // 3. Assert Markdown Table Syntax (|) Preservation
  const hasMarkdownTable = parsed.rawText.includes('| Enterprise | $50000 | 30% | Director Approval |') || parsed.rawText.includes('| Tier Name | Min ARR | Max Discount | Required Gate |');

  if (!hasMarkdownTable) {
    console.error('❌ DOCUMENT PARSER TEST FAILED: Markdown table syntax (|) was not preserved!', parsed.rawText);
    return false;
  }

  console.log('✅ DOCUMENT PARSER TEST PASSED: Layout-aware parser successfully converted multi-column matrix into clean Markdown tables.');
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDocumentParserTest().then((success) => {
    process.exit(success ? 0 : 1);
  });
}
