import { extractTextFromPdf } from '../../src/services/parsers/pdfExtractor.js';
import { parseDocument } from '../../src/services/parsers/documentParser.js';

/**
 * Creates a minimal syntactically valid PDF Buffer containing specified text.
 * Xref offsets and startxref are computed from real byte positions so the
 * generated document parses deterministically.
 */
function createTestPdfBuffer(textContent: string): Buffer {
  const streamContent = `BT /F1 12 Tf 50 700 Td (${textContent.replace(/[()\\]/g, '')}) Tj ET`;

  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
    `4 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'binary'));
    body += obj;
  }

  const xrefPos = Buffer.byteLength(body, 'binary');
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return Buffer.from(body + xref, 'binary');
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
    process.exit(success ? 0 : 1);
  });
}
