// cover-letter.test.mjs — proves the cover letter path end to end in the
// real extension: two LLM calls (resume, then letter), TWO .docx files in
// Downloads, and the greeting/sign-off assembled locally with the real name
// rather than by the model.
//
// The mock LLM answers based on what it's asked for: the resume call expects
// JSON, the cover-letter call expects prose paragraphs. Keying off the
// request body rather than call order makes the test independent of the
// pipeline's internal call sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey,
  pdfTextOf,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE = readFileSync(path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt'), 'utf8');

const RESUME_SUMMARY = 'TAILORED SUMMARY for a backend engineering role.';
const CL_PARA_ONE = 'BODY PARAGRAPH ONE about the backend role and the work it involves. ' + Array(120).fill('word').join(' ');
const CL_PARA_TWO = 'BODY PARAGRAPH TWO about relevant transferable experience. ' + Array(120).fill('word').join(' ');

/** Content-aware mock: JSON for the resume call, prose for the letter call. */
function startSmartMockLlm() {
  const calls = [];
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const isCoverLetter = body.includes('cover letter') || body.includes('no sign-off');
      calls.push(isCoverLetter ? 'cover_letter' : 'resume');
      const content = isCoverLetter
        ? `${CL_PARA_ONE}\n\n${CL_PARA_TWO}`
        : JSON.stringify({ summary: RESUME_SUMMARY, entries: [{ index: 0, bullets: ['R1.'] }, { index: 1, bullets: ['R2.'] }] });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        calls: () => [...calls],
      });
    });
  });
}

test('cover letter path: two LLM calls, two DOCX files, greeting and sign-off built locally', async (t) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-cl-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });
  const mockLlm = await startSmartMockLlm();

  t.after(async () => {
    await context.close();
    await mockLlm.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const sw = await getExtensionServiceWorker(context);
  const extensionId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mockLlm.url)}`);

  await page.fill('#resumeText', FIXTURE);
  await page.fill('#jobDescription', 'Backend engineer, Python and AWS.');
  await page.fill('#jobTitle', 'Backend Engineer');
  await page.fill('#employer', 'Acme Corp');
  await page.check('#includeCoverLetter');
  await fillApiKey(page);
  await page.click('#tailorBtn');

  await page.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 30000 });

  const result = JSON.parse(await page.textContent('#result'));
  assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);

  // Both documents, in BOTH formats, downloaded automatically -- no clicks.
  //
  // The "PDF copy" chip is on by default, so a run produces four files. The
  // PDF used to require opening a tab and driving a print dialog while the
  // .docx arrived by itself; these assertions are what stops that asymmetry
  // coming back.
  const kinds = result.downloads.map((d) => d.kind).sort();
  assert.deepEqual(
    kinds, ['cover_letter', 'cover_letter_pdf', 'resume', 'resume_pdf'],
    `expected both documents in both formats, got ${JSON.stringify(result.downloads)}`,
  );
  assert.match(result.downloads.find((d) => d.kind === 'cover_letter').filename, /_cover_letter\.docx$/);
  assert.match(result.downloads.find((d) => d.kind === 'cover_letter_pdf').filename, /_cover_letter\.pdf$/);
  assert.match(result.downloads.find((d) => d.kind === 'resume_pdf').filename, /_tailored_resume\.pdf$/);

  // Both LLM calls really happened, and were distinguishable.
  const calls = mockLlm.calls();
  assert.ok(calls.includes('resume'), `no resume call observed: ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('cover_letter'), `no cover-letter call observed: ${JSON.stringify(calls)}`);

  assert.equal(result.coverLetter.status, 'approved', JSON.stringify(result.coverLetter));

  // The letter DOCX: model-written body, locally-assembled frame.
  const clDownload = result.downloads.find((d) => d.kind === 'cover_letter');
  const clItem = await waitForCompletedDownload(sw, clDownload.downloadId);
  const clText = await docxTextOf(readFileSync(clItem.filename));

  assert.ok(clText.includes('BODY PARAGRAPH ONE'), 'letter body missing from the docx');
  assert.ok(clText.includes('BODY PARAGRAPH TWO'), 'second letter paragraph missing from the docx');
  // Greeting and sign-off are built by renderCoverLetterDocx, never by the
  // LLM -- and the name comes from the resume, so it cannot be "John Doe".
  assert.ok(clText.includes('Dear Hiring Manager,'), 'greeting missing (should be locally assembled)');
  assert.ok(clText.includes('Sincerely,'), 'sign-off missing (should be locally assembled)');
  assert.ok(clText.includes('Juan Rivera'), 'real candidate name missing from the letter');
  assert.ok(clText.includes('Re: Backend Engineer at Acme Corp'), 'job reference line missing');

  // ...and the letter PDF that arrived on its own carries the same letter.
  //
  // Asserted against the file ON DISK, and located BY DOWNLOAD ID rather than
  // by name: Playwright renames every download to an extensionless GUID, so
  // the filename the extension asked for is not observable from a test.
  //
  // The on-demand button path is covered where it can be isolated --
  // vertical-slice.test.mjs and run-survives-popup-close.test.mjs both run
  // with the chip off, so there the button is the only thing that can produce
  // a PDF at all.
  const clPdf = result.downloads.find((d) => d.kind === 'cover_letter_pdf');
  const pdfItem = await waitForCompletedDownload(sw, clPdf.downloadId);
  const pdfText = await pdfTextOf(pdfItem.filename);
  assert.ok(pdfText.includes('Dear Hiring Manager,'), 'greeting missing from the PDF');
  assert.ok(pdfText.includes('Sincerely,'), 'sign-off missing from the PDF');
  assert.ok(pdfText.includes('Juan Rivera'), 'candidate name missing from the PDF');
  assert.ok(pdfText.includes('BODY PARAGRAPH ONE'), 'letter body missing from the PDF');
  assert.ok(
    pdfText.includes('Re: Backend Engineer at Acme Corp'),
    'job reference line missing from the PDF',
  );
});
