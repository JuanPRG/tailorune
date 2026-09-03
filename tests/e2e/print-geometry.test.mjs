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

/**
 * Print the HTML through the same Skia path v4 used, and measure the text.
 *
 * `pdfOpts.margin` stands in for Chrome's print-dialog Margins control. That
 * control is the whole reason this file has two cases: it OVERRIDES the CSS
 * @page margin, and a user who once picked "None" keeps it silently forever.
 */
async function measure(html, pdfOpts = {}) {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(html);
    const bytes = await page.pdf({ printBackground: true, ...pdfOpts });

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

test('the margins hold whatever the print dialog is set to', async () => {
  // THE CASE THAT WAS MISSED, and it shipped a broken PDF.
  //
  // The first fix put the margins in @page and removed the screen padding.
  // Every measurement here passed, because page.pdf() has no dialog to
  // disagree with it. On a real machine with the dialog's Margins set to
  // "None" -- a sticky preference nobody remembers choosing -- @page was
  // discarded and the resume printed edge to edge: section rules running off
  // both sides, words clipped mid-line.
  //
  // The margin now lives in the CONTENT, which no dialog setting can remove.
  // Both cases below must land on the same number.
  const model = parseTxt(readFileSync(FIXTURE, 'utf8'));

  const asNone = await measure(renderResumeHtml(model));
  const asDefault = await measure(renderResumeHtml(model), {
    margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
  });

  for (const [label, m] of [['dialog None', asNone], ['dialog Default', asDefault]]) {
    assert.ok(
      Math.abs(m.leftIn - DOCX_SIDE_IN) <= 0.05,
      `${label}: left ${m.leftIn.toFixed(2)}in should be the DOCX's ${DOCX_SIDE_IN.toFixed(2)}in`,
    );
    assert.ok(m.leftIn > 0.1, `${label}: the text must never reach the paper edge`);
  }
  assert.ok(
    Math.abs(asNone.leftIn - asDefault.leftIn) < 0.05,
    'the two dialog settings must not produce different documents',
  );
});

test('the margin is declared in the content, not in @page', async () => {
  // A SOURCE assertion, and the reason is worth stating: this bug CANNOT be
  // caught by rendering.
  //
  // Chrome's print-dialog Margins control is what discards @page, and
  // page.pdf() has no dialog -- in this Chromium the CSS @page always wins
  // there, whatever margin argument is passed. So a build that relies on
  // @page measures perfectly through every automated path available here and
  // still prints edge to edge on a machine where someone once chose "None".
  // That is exactly how it shipped.
  //
  // What can be checked is the invariant that makes the render irrelevant:
  // the margin must be padding on .sheet, and @page must be zero. Pin that.
  const model = parseTxt(readFileSync(FIXTURE, 'utf8'));
  const html = renderResumeHtml(model);

  assert.match(
    html, /@page\s*\{[^}]*margin:\s*0\s*;/,
    '@page must be zero: any margin declared there is discarded by the dialog',
  );
  assert.match(
    html, /@media print\s*\{[\s\S]*?\.sheet\s*\{[^}]*padding:\s*0\.30in 0\.60in 0\.50in/,
    'the printed margin must be padding on .sheet, which no dialog setting can remove',
  );

  // And the rendered result must still agree with the DOCX, so the invariant
  // above is not satisfied by some number that merely looks tidy.
  const m = await measure(html);
  assert.ok(Math.abs(m.leftIn - DOCX_SIDE_IN) <= 0.05);
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
