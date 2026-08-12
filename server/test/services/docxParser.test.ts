// Hermetic unit tests for the Phase 3 .docx parser (ADR-T15 parse stage):
// real mammoth extraction from a minimal in-memory .docx, layout signals,
// and the explicit empty-extraction failure (image-only/empty documents must
// fail loudly, never yield an ungrounded empty chunk).

import { installHarness } from '../harness/index.js';
import JSZip from 'jszip';

let success = true;
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`✅ DOCX PARSER TEST PASSED: ${name}`);
  } else {
    failed += 1;
    success = false;
    console.error(`❌ DOCX PARSER TEST FAILED: ${name}`, extra ?? '');
  }
}

/** Minimal valid .docx (one paragraph) built with jszip — no filesystem. */
async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphs
    .map(
      (p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`
    )
    .join('')}
  </w:body>
</w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function runDocxParserTests(): Promise<boolean> {
  await installHarness();
  const { parseDocx } = await import('../../src/services/parsers/docxParser.js');

  try {
    // ─── 1. Happy path: text + paragraph signal ───────────────────────────
    const docx = await buildDocx(['Deploy requires two-person approval.', 'Rollbacks are rehearsed quarterly.']);
    const parsed = await parseDocx(docx);
    check('extracts concatenated paragraph text', parsed.text.includes('two-person approval') && parsed.text.includes('rehearsed quarterly'), parsed);
    check('reports docx format', parsed.format === 'docx');
    check('reports paragraph count (blank-line separated)', typeof parsed.paragraphs === 'number' && parsed.paragraphs >= 1, parsed.paragraphs);

    // ─── 2. XML-escaping: special characters survive round-trip ──────────
    const specials = await buildDocx(['A&B <strict> > pass-through']);
    const specialParsed = await parseDocx(specials);
    check('xml entities are decoded back to original text', specialParsed.text.includes('A&B <strict> > pass-through'), specialParsed.text);

    // ─── 3. Empty extraction -> typed failure (no empty chunk) ───────────
    let emptyErr: unknown = null;
    try {
      // Valid docx zip with an EMPTY body: mammoth yields no text.
      const zip = new JSZip();
      zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
      zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`);
      await parseDocx(await zip.generateAsync({ type: 'nodebuffer' }));
    } catch (err) {
      emptyErr = err;
    }
    check('empty document throws (explicit failure)', emptyErr instanceof Error && /no text/.test((emptyErr as Error).message), emptyErr);

    // ─── 4. Garbage buffer -> throws (never silently returns "") ─────────
    let garbageErr: unknown = null;
    try {
      await parseDocx(Buffer.from('this is not a docx file at all'));
    } catch (err) {
      garbageErr = err;
    }
    check('non-docx buffer throws', garbageErr instanceof Error, garbageErr);
  } catch (err: any) {
    check('DOCX parser suite ran', false, err.message);
  }

  console.log(`\n[Docx Parser Tests] ${passed} passed, ${failed} failed`);
  return success;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDocxParserTests().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
