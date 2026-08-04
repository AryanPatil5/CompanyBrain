import { extractTextFromPdf } from '../../src/services/parsers/pdfExtractor.js';
import { parseDocument } from '../../src/services/parsers/documentParser.js';

/**
 * Creates a minimal syntactically valid PDF Buffer containing specified text.
 */
function createTestPdfBuffer(textContent: string): Buffer {
  const streamContent = `BT /F1 12 Tf 50 700 Td (${textContent.replace(/[()]/g, '')}) Tj ET`;
  const streamLength = streamContent.length;

  const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${streamContent}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000340 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
425
%%EOF`;

  return Buffer.from(pdfString, 'binary');
}

export async function runPdfExtractionTest(): Promise<boolean> {
  console.log('\n=================================================');
  console.log('  Running Real PDF Extraction Test Suite        ');
  console.log('=================================================');

  // Test 1: Real PDF text extraction
  try {
    const pdfBuffer = createTestPdfBuffer('Company Brain Enterprise Operations Q1 Revenue Overview');
    const result = await extractTextFromPdf(pdfBuffer);

    if (!result.text.includes('Company Brain Enterprise Operations') || result.pageCount !== 1) {
      console.error('❌ PDF EXTRACTION TEST FAILED: Extracted text mismatch!', result);
      return false;
    }
    console.log(`✅ PDF EXTRACTION TEST PASSED: Successfully extracted real text from PDF (${result.text.trim()}).`);
  } catch (err: any) {
    console.error('❌ PDF EXTRACTION TEST EXCEPTION (Real PDF):', err.message);
    return false;
  }

  // Test 2: Verify keywords "Q1" and "Revenue" do NOT produce fabricated figures (12.4, 8.2, 4.2)
  try {
    const pdfBuffer = createTestPdfBuffer('Q1 Revenue is growing steadily across all sectors.');
    const docResult = await parseDocument(pdfBuffer, 'application/pdf', 'report_q1.pdf');

    if (
      docResult.rawText.includes('12.4') ||
      docResult.rawText.includes('8.2') ||
      docResult.rawText.includes('4.2') ||
      docResult.tablesCount > 0
    ) {
      console.error('❌ PDF EXTRACTION TEST FAILED: Fabricated table data or figures detected in real PDF output!', docResult);
      return false;
    }
    console.log('✅ PDF EXTRACTION TEST PASSED: Verified keywords Q1/Revenue produce real text without any fabricated tables or synthetic numbers.');
  } catch (err: any) {
    console.error('❌ PDF EXTRACTION TEST EXCEPTION (No Fabrication):', err.message);
    return false;
  }

  // Test 3: Scanned PDF / Near-empty text layer handles OCR signal
  try {
    const scannedBuffer = Buffer.alloc(1000, 0x00);
    const docResult = await parseDocument(scannedBuffer, 'application/pdf', 'scanned.pdf');

    if (docResult.metadata?.layoutStructure !== 'scanned_ocr_required') {
      console.error('❌ PDF EXTRACTION TEST FAILED: Scanned image PDF did not return scanned_ocr_required signal!', docResult);
      return false;
    }
    console.log('✅ PDF EXTRACTION TEST PASSED: Scanned/image-only PDF returned explicit scanned_ocr_required signal.');
  } catch (err: any) {
    console.error('❌ PDF EXTRACTION TEST EXCEPTION (Scanned PDF):', err.message);
    return false;
  }

  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPdfExtractionTest().then((success) => {
    if (!success) process.exit(1);
  });
}
