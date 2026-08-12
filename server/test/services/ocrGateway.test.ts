// Hermetic unit tests for the Phase 3 OCR gateway (ADR decision: real OCR is
// out of scope). The gateway must DETECT OCR-required documents and REFUSE
// to fabricate extraction: performOcr() always returns null — never fake
// text — so the worker routes documents to the explicit ocr_required stage.

import { installHarness } from '../harness/index.js';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ OCR GATEWAY TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ OCR GATEWAY TEST FAILED: ${name}`, extra ?? '');
  }
}

export async function runOcrGatewayTests(): Promise<boolean> {
  await installHarness();
  const { requiresOcr, performOcr } = await import('../../src/services/parsers/ocrGateway.js');

  try {
    // ─── 1. Detection: scanned PDF requires OCR ───────────────────────────
    check('scanned pdf requires OCR', requiresOcr('application/pdf', { isScanned: true }) === true);

    // ─── 2. Detection: text-layer PDF does NOT require OCR ────────────────
    check('text-layer pdf does not require OCR', requiresOcr('application/pdf', { isScanned: false }) === false);
    check('pdf without scan metadata does not require OCR', requiresOcr('application/pdf', undefined) === false);

    // ─── 3. Detection: non-PDF types never require OCR via this gate ──────
    check('docx never flagged OCR-required', requiresOcr('application/vnd.openxmlformats-officedocument.wordprocessingml.document', { isScanned: true }) === false);
    check('markdown never flagged OCR-required', requiresOcr('text/markdown', { isScanned: true }) === false);

    // ─── 4. performOcr refuses to fabricate text ──────────────────────────
    const outcome = await performOcr(Buffer.from('some image bytes'), 'application/pdf');
    check('performOcr returns null (never fake extraction)', outcome === null);

    // ─── 5. Empty input handled without throwing ──────────────────────────
    const emptyOutcome = await performOcr(Buffer.alloc(0), 'image/png');
    check('performOcr handles empty buffer without throwing', emptyOutcome === null);
  } catch (err: any) {
    check('OCR gateway suite ran', false, err.message);
  }

  console.log(`\n[Ocr Gateway Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runOcrGatewayTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
