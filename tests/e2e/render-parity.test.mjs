// render-parity.test.mjs — the DOCX, the HTML and the PDF must be one document.
//
// This began as a two-way test after a report of "it created a 2 page pdf",
// with the DOCX from the same run sitting at one page. Measured, for
// identical content:
//
//   DOCX via LibreOffice   1 page,  text span 8.60in
//   HTML via Chrome print  2 pages, text span 9.65in
//
// The HTML rendered 1.05in taller for 431 words against a 510-word budget --
// nothing was over budget, the two renderers simply disagreed about how tall
// the same words are, and only one of them had ever been measured. The cause
// was `line-height: 1.3`, chosen because it reads well on screen, against
// Word's ~1.15 for Arial: about 1.5pt on EVERY line, roughly an inch over a
// full resume.
//
// A THIRD renderer now exists. renderPdf.js writes PDF bytes directly so the
// resume can download in one click like the DOCX does, instead of going
// through Chrome's print dialog. That triples the surface for exactly the
// drift above, so this file grew to measure all three together.
//
// It caught three real defects on its first run:
//
//   1. renderPdf SUMMED adjacent vertical spacing where both other renderers
//      COLLAPSE it to the larger. 25.5pt per section boundary against the
//      DOCX's 18.5pt, compounding down the page.
//   2. renderDocx declared NO PAGE SIZE, so a .docx took the reader's default
//      -- Letter in North America, A4 nearly everywhere else. The HTML and
//      the PDF are both pinned to Letter, so the same resume opened in Warsaw
//      was a different document. Surfaced as text positions 50pt out: 842pt
//      of A4 against the 792pt everything else assumed.
//   3. renderHtml stripped a bullet marker without trimming, where renderDocx
//      trimmed -- a one-space divergence, now shared code.
//
// LIBREOFFICE is how a .docx gets measured at all, and it is not everywhere.
// Only the DOCX comparisons skip without it; PDF against HTML always runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Packer } from 'docx';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { buildResumeDocument } from '../../extension/engine/renderDocx.js';
import { renderResumeHtml } from '../../extension/engine/renderHtml.js';
import { renderResumePdf } from '../../extension/engine/renderPdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/resumes');

const FONTS = {
  regular: readFileSync(path.join(ROOT, 'extension/fonts/arimo-regular.ttf')),
  bold: readFileSync(path.join(ROOT, 'extension/fonts/arimo-bold.ttf')),
  italic: readFileSync(path.join(ROOT, 'extension/fonts/arimo-italic.ttf')),
};

const SOFFICE = [
  'C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  '/usr/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].find((p) => existsSync(p));

const NO_SOFFICE = SOFFICE ? false : 'LibreOffice not found — a .docx cannot be measured without it';

// How far apart two renderers may be before they are telling different
// stories about the same resume. A 10pt line is 0.16in, so this is under a
// line: enough slack for border and leading differences no one can see, not
// enough to hide a page break.
const TOLERANCE_IN = 0.20;

/** Page count, page size, and the vertical extent of the text on page 1. */
async function measure(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  let minY = Infinity; let maxY = -Infinity; let minX = Infinity; let text = '';
  for (const item of (await page.getTextContent()).items) {
    if (!item.str.trim()) continue;
    minY = Math.min(minY, item.transform[5]);
    maxY = Math.max(maxY, item.transform[5]);
    minX = Math.min(minX, item.transform[4]);
    text += `${item.str} `;
  }
  return {
    pages: doc.numPages,
    spanIn: (maxY - minY) / 72,
    leftIn: minX / 72,
    widthIn: viewport.width / 72,
    heightIn: viewport.height / 72,
    text,
  };
}

async function asDocx(model) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-parity-'));
  try {
    writeFileSync(path.join(dir, 'r.docx'), await Packer.toBuffer(buildResumeDocument(model)));
    execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'r.docx')], {
      stdio: 'ignore', timeout: 120000,
    });
    return await measure(readFileSync(path.join(dir, 'r.pdf')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function asHtml(model) {
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(renderResumeHtml(model));
    return await measure(await page.pdf({ printBackground: true }));
  } finally {
    await browser.close();
  }
}

const asPdf = async (model) => measure(await renderResumePdf(model, FONTS));

const fixture = (name) => parseTxt(readFileSync(path.join(FIXTURES, name), 'utf8'));

/** A resume long enough for a per-line error to accumulate into a page break. */
function longModel() {
  const lines = readFileSync(path.join(FIXTURES, 'juan-rivera-full.txt'), 'utf8').split('\n');
  const bullets = lines.filter((l) => l.trim().startsWith('-'));
  const out = [...lines];
  let words = out.join(' ').split(/\s+/).filter(Boolean).length;
  for (let i = 0; words < 440 && i < 400; i++) {
    out.splice(out.length - 1, 0,
      `${bullets[i % bullets.length]} Extended detail ${i} covering additional scope and measurable outcomes.`);
    words = out.join(' ').split(/\s+/).filter(Boolean).length;
  }
  return parseTxt(out.join('\n'));
}

// --- PDF against HTML: always runs -----------------------------------------

for (const name of ['taylor-reed-sparse.txt', 'jordan-lee-standard.txt', 'juan-rivera-full.txt']) {
  test(`${name}: the PDF and the HTML agree`, async () => {
    const model = fixture(name);
    const [html, pdf] = [await asHtml(model), await asPdf(model)];
    assert.equal(pdf.pages, html.pages, 'same content, same page count');
    assert.ok(
      Math.abs(pdf.spanIn - html.spanIn) < TOLERANCE_IN,
      `span differs by ${Math.abs(pdf.spanIn - html.spanIn).toFixed(2)}in `
      + `(HTML ${html.spanIn.toFixed(2)}in, PDF ${pdf.spanIn.toFixed(2)}in)`,
    );
  });
}

test('every renderer puts the text block in the same place on US Letter', async () => {
  // Page SIZE is its own failure mode, separate from spacing: renderDocx
  // shipped with none declared, and a reader outside North America silently
  // laid the same file out on A4.
  const model = fixture('juan-rivera-full.txt');
  const results = [['HTML', await asHtml(model)], ['PDF', await asPdf(model)]];
  if (SOFFICE) results.push(['DOCX', await asDocx(model)]);

  for (const [label, m] of results) {
    assert.ok(Math.abs(m.widthIn - 8.5) < 0.02, `${label}: page should be 8.5in wide, got ${m.widthIn.toFixed(2)}in`);
    assert.ok(Math.abs(m.heightIn - 11) < 0.02, `${label}: page should be 11in tall, got ${m.heightIn.toFixed(2)}in`);
    // renderDocx MARGIN_SIDE is 864 twips.
    assert.ok(
      Math.abs(m.leftIn - 0.6) <= 0.03,
      `${label}: left margin ${m.leftIn.toFixed(2)}in should be the DOCX's 0.60in`,
    );
  }
});

test('the PDF keeps a name that pdf-lib\'s built-in fonts would corrupt', async () => {
  // THE REASON A FONT IS EMBEDDED AT ALL. pdf-lib's StandardFonts are
  // WinAnsi-encoded, which is the same defect that disqualified jsPDF in
  // SPIKE_FINDINGS.md: a stroked L becomes "A", and accented names come back
  // letter-spaced so `"José" in text` is false. On a resume the candidate's
  // own name is the one string that must survive, and a corrupted name is
  // invisible to whoever generated it and obvious to whoever receives it.
  const model = fixture('taylor-reed-sparse.txt');
  model.name = 'Łukasz José Gonçalves-Müller';
  model.contact = 'Kraków, PL\nlukasz@example.com';
  const { text } = await asPdf(model);
  for (const needle of ['Łukasz', 'José', 'Gonçalves-Müller', 'Kraków']) {
    assert.ok(text.includes(needle), `the PDF lost "${needle}" — it extracted as: ${text.slice(0, 120)}`);
  }
});

test('no line in the PDF runs past the right margin', async () => {
  // The justifier computes its own inter-word gaps, so an off-by-one in the
  // gap maths shows up as ink in the margin rather than as an exception.
  const model = longModel();
  const bytes = await renderResumePdf(model, FONTS);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const RIGHT_EDGE = 612 - 0.6 * 72;

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    for (const item of (await page.getTextContent()).items) {
      if (!item.str.trim()) continue;
      const right = item.transform[4] + (item.width || 0);
      assert.ok(
        right <= RIGHT_EDGE + 0.6,
        `page ${n}: "${item.str.slice(0, 40)}" ends ${(right - RIGHT_EDGE).toFixed(2)}pt past the margin`,
      );
      assert.ok(item.transform[4] >= 0.6 * 72 - 7, `page ${n}: "${item.str.slice(0, 40)}" starts left of the margin`);
    }
  }
});

// --- Anything involving the DOCX -------------------------------------------

test('a long resume is one page in ALL THREE renderers', { skip: NO_SOFFICE }, async () => {
  // The reported failure, at the length it happened: ~440 words, comfortably
  // under the 510 budget, one page as a DOCX and two as a PDF.
  const model = longModel();
  const [docx, html, pdf] = [await asDocx(model), await asHtml(model), await asPdf(model)];
  assert.equal(docx.pages, 1, 'the DOCX must be one page, or this tests the wrong thing');
  assert.equal(html.pages, 1, `the printed HTML spilled to ${html.pages} pages`);
  assert.equal(pdf.pages, 1, `the generated PDF spilled to ${pdf.pages} pages`);
});

test('all three renderers agree on how tall the same words are', { skip: NO_SOFFICE }, async () => {
  // The underlying defect, stated directly. A page-count assertion alone
  // passes right up until content crosses the boundary; this catches drift
  // while it is still a fraction of an inch. Compared pairwise, because
  // "close to the DOCX" twice does not mean "close to each other".
  const model = longModel();
  const all = [['DOCX', await asDocx(model)], ['HTML', await asHtml(model)], ['PDF', await asPdf(model)]];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [an, a] = all[i]; const [bn, b] = all[j];
      assert.ok(
        Math.abs(a.spanIn - b.spanIn) < TOLERANCE_IN,
        `${an} and ${bn} differ by ${Math.abs(a.spanIn - b.spanIn).toFixed(2)}in `
        + `(${an} ${a.spanIn.toFixed(2)}in, ${bn} ${b.spanIn.toFixed(2)}in). `
        + 'Spacing in all three must stay derived from renderDocx.js twips.',
      );
    }
  }
});

for (const name of ['taylor-reed-sparse.txt', 'jordan-lee-standard.txt', 'juan-rivera-full.txt']) {
  test(`${name}: all three renderers agree`, { skip: NO_SOFFICE }, async () => {
    const model = fixture(name);
    const all = [['DOCX', await asDocx(model)], ['HTML', await asHtml(model)], ['PDF', await asPdf(model)]];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [an, a] = all[i]; const [bn, b] = all[j];
        assert.equal(a.pages, b.pages, `${an} is ${a.pages} page(s), ${bn} is ${b.pages}`);
        assert.ok(
          Math.abs(a.spanIn - b.spanIn) < TOLERANCE_IN,
          `${an} vs ${bn}: span differs by ${Math.abs(a.spanIn - b.spanIn).toFixed(2)}in`,
        );
      }
    }
  });
}
