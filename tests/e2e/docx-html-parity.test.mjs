// docx-html-parity.test.mjs — the DOCX and the PDF must be the same document.
//
// Reported as "it created a 2 page pdf", with the DOCX from the same run
// sitting at one page. Measured, for identical content:
//
//   DOCX via LibreOffice   1 page,  text span 8.60in
//   HTML via Chrome print  2 pages, text span 9.65in
//
// The HTML rendered 1.05in taller. The word count was 431 against a
// ONE_PAGE_WORD_BUDGET of 510, so nothing was over budget -- the two renderers
// simply disagreed about how tall the same words are, and only one of them was
// ever measured when the budget was set.
//
// The cause was `line-height: 1.3`, chosen because it reads well on screen.
// The DOCX uses Word's single spacing, about 1.15 for Arial. That is ~1.5pt on
// EVERY line, roughly an inch over a full resume -- enough to push a one-page
// document onto a second page. The rest of the stylesheet had drifted the same
// way: paragraph and heading margins picked in round pixels rather than
// converted from the DOCX's twips.
//
// renderHtml.js now derives its spacing from renderDocx.js (twips / 20 = pt),
// and this test is what keeps them honest. A stylesheet that merely looks
// comfortable is not the same thing as one that matches.
//
// REQUIRES LIBREOFFICE, which is how a .docx gets measured at all. Skipped
// with a clear message when it is absent, rather than failing on a machine
// that never claimed to have it.

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures/resumes');

const SOFFICE = [
  'C:/Program Files/LibreOffice/program/soffice.exe',
  'C:/Program Files (x86)/LibreOffice/program/soffice.exe',
  '/usr/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].find((p) => existsSync(p));

/** Vertical extent of the text on page 1, plus the page count. */
async function measurePdf(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  let minY = Infinity; let maxY = -Infinity;
  for (const item of (await page.getTextContent()).items) {
    if (!item.str.trim()) continue;
    minY = Math.min(minY, item.transform[5]);
    maxY = Math.max(maxY, item.transform[5]);
  }
  return { pages: doc.numPages, spanIn: (maxY - minY) / 72 };
}

async function renderBoth(model) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-parity-'));
  try {
    writeFileSync(path.join(dir, 'r.docx'), await Packer.toBuffer(buildResumeDocument(model)));
    execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'r.docx')], {
      stdio: 'ignore', timeout: 120000,
    });
    const docx = await measurePdf(readFileSync(path.join(dir, 'r.pdf')));

    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.setContent(renderResumeHtml(model));
      const html = await measurePdf(await page.pdf({ printBackground: true }));
      return { docx, html };
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

const SKIP = SOFFICE ? false : 'LibreOffice not found — a .docx cannot be measured without it';

test('a long resume is one page in BOTH renderers', { skip: SKIP }, async () => {
  // The reported failure, at the length it happened: ~440 words, comfortably
  // under the 510 budget, one page as a DOCX and two as a PDF.
  const { docx, html } = await renderBoth(longModel());
  assert.equal(docx.pages, 1, 'the DOCX must be one page, or this tests the wrong thing');
  assert.equal(
    html.pages, 1,
    `the PDF spilled to ${html.pages} pages for content the DOCX fits on one`,
  );
});

test('the two renderers agree on how tall the same words are', { skip: SKIP }, async () => {
  // The underlying defect, stated directly. A page-count assertion alone would
  // pass right up until the moment content crossed the boundary; this catches
  // the drift while it is still a fraction of an inch.
  const { docx, html } = await renderBoth(longModel());
  const delta = Math.abs(html.spanIn - docx.spanIn);
  assert.ok(
    delta < 0.20,
    `text span differs by ${delta.toFixed(2)}in `
    + `(DOCX ${docx.spanIn.toFixed(2)}in, HTML ${html.spanIn.toFixed(2)}in). `
    + 'renderHtml.js spacing must stay derived from renderDocx.js twips.',
  );
});

for (const name of ['taylor-reed-sparse.txt', 'jordan-lee-standard.txt', 'juan-rivera-full.txt']) {
  test(`${name}: the renderers agree`, { skip: SKIP }, async () => {
    const model = parseTxt(readFileSync(path.join(FIXTURES, name), 'utf8'));
    const { docx, html } = await renderBoth(model);
    assert.equal(html.pages, docx.pages, 'same content, same page count');
    assert.ok(
      Math.abs(html.spanIn - docx.spanIn) < 0.20,
      `span differs by ${Math.abs(html.spanIn - docx.spanIn).toFixed(2)}in`,
    );
  });
}
