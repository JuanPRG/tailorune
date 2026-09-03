// print-geometry.test.mjs — the printed PDF must be the same document as the DOCX.
//
// v4 shipped PDFs, and its PDFs were Chromium's print-to-PDF: `page.pdf()` is
// CDP Page.printToPDF is the browser's own print dialog, all the same Skia
// backend (57/57 of v4's output, per docs/SPIKE_FINDINGS.md). So Tailorune
// reaches v4's PDF quality through the print dialog rather than a third
// renderer -- and notably NOT through jsPDF, which the same spike found
// silently letter-spaces accented names on extraction and turns "Łukasz" into
// "Aukasz". On a resume the candidate's own name is the one string that must
// survive.
//
// What that leaves is a geometry problem, and it was real. The preview's
// .sheet pads 0.4in to look like paper on screen, while @page sets the print
// margin. With no print override BOTH applied:
//
//   printed PDF   1.00in sides, text top 0.95in
//   DOCX template 0.60in sides, 0.30in top
//
// A 0.40in narrower text block: different line breaks, and a one-page word
// budget (510, measured against the DOCX) that no longer described the PDF.
// Two files claiming to be the same resume, quietly disagreeing.
//
// Measured here rather than asserted from the CSS, because reading CSS is
// what let it ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { renderResumeHtml, withAutoPrint } from '../../extension/engine/renderHtml.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt');

// renderDocx.js: MARGIN_TOP 432 twips, MARGIN_SIDE 864, MARGIN_BOTTOM 720.
const DOCX_SIDE_IN = 864 / 1440;

/** Print the HTML through the same Skia path v4 used, and measure the text. */
async function measure(html) {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(html);
    const bytes = await page.pdf({ printBackground: true });

    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
    const first = await doc.getPage(1);
    const viewport = first.getViewport({ scale: 1 });

    let minX = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const item of (await first.getTextContent()).items) {
      if (!item.str.trim()) continue;
      minX = Math.min(minX, item.transform[4]);
      maxX = Math.max(maxX, item.transform[4] + (item.width || 0));
      maxY = Math.max(maxY, item.transform[5]);
    }
    const inch = (v) => v / 72;
    return {
      pages: doc.numPages,
      widthIn: inch(viewport.width),
      heightIn: inch(viewport.height),
      leftIn: inch(minX),
      rightIn: inch(viewport.width - maxX),
      // NOTE: a text baseline, not the top of the glyph -- an 18pt name sits
      // roughly 0.25in below the block top. Useful for comparing two renders,
      // useless as an absolute margin. Measuring cap-height would need font
      // metrics, and the side margins already pin the geometry exactly.
      topBaselineIn: inch(viewport.height - maxY),
    };
  } finally {
    await browser.close();
  }
}

test('the printed resume matches the DOCX text block', async () => {
  const model = parseTxt(readFileSync(FIXTURE, 'utf8'));
  const m = await measure(renderResumeHtml(model));

  assert.equal(m.pages, 1, 'the resume template is a one-page document');
  assert.ok(Math.abs(m.widthIn - 8.5) < 0.02 && Math.abs(m.heightIn - 11) < 0.02, 'US Letter');

  // The side margins are exact: transform[4] is the left edge of a text run,
  // with no baseline offset to muddy it.
  assert.ok(
    Math.abs(m.leftIn - DOCX_SIDE_IN) <= 0.03,
    `left margin ${m.leftIn.toFixed(2)}in should match the DOCX's ${DOCX_SIDE_IN.toFixed(2)}in`,
  );
  assert.ok(
    Math.abs(m.rightIn - DOCX_SIDE_IN) <= 0.03,
    `right margin ${m.rightIn.toFixed(2)}in should match the DOCX's ${DOCX_SIDE_IN.toFixed(2)}in`,
  );
});

test('the on-screen paper padding does not leak into print', async () => {
  // The regression, stated as the thing that actually went wrong: .sheet's
  // screen padding stacking on top of the @page margin. Asserted as a DELTA
  // against a deliberately broken build, so it cannot pass just because some
  // other number happens to look plausible.
  const model = parseTxt(readFileSync(FIXTURE, 'utf8'));
  const fixed = await measure(renderResumeHtml(model));

  const broken = renderResumeHtml(model)
    .replace('.sheet { max-width: none; margin: 0; padding: 0; }', '/* override removed */');
  const withPadding = await measure(broken);

  assert.ok(
    withPadding.leftIn - fixed.leftIn > 0.3,
    'the broken build should show the padding; if it does not, this test is no longer testing anything',
  );
  assert.ok(
    fixed.leftIn < withPadding.leftIn,
    'the print override must remove the screen padding',
  );
});

test('withAutoPrint opens the dialog, and only once', async () => {
  const model = parseTxt(readFileSync(FIXTURE, 'utf8'));
  const html = renderResumeHtml(model);
  const once = withAutoPrint(html);
  assert.match(once, /<body onload="window\.print\(\)">/);
  // Applied twice -- a restored run reopened, say -- must not stack handlers.
  assert.equal(withAutoPrint(once), once);
  // And it must not mangle anything when there is nothing to do.
  assert.equal(withAutoPrint(''), '');
  assert.equal(withAutoPrint(null), null);
});
