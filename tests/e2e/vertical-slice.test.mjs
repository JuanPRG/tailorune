// vertical-slice.test.mjs — Phase 2 proof: load the REAL unpacked extension
// in real Chromium, mock only the network call to the LLM (everything else —
// service worker, offscreen document, message routing, chrome.downloads —
// is exercised for real), and verify the actual downloaded .docx has the
// tailored bullets applied while every locked field (name, contact, job
// titles, dates, education) survives byte-for-byte.
//
// Requires `npm run build` first (bundles offscreen.entry.js -> offscreen.bundle.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { startMockLlmServer } from './mockLlmServer.mjs';
import { getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey,
  waitForNewestDownload, pdfTextOf,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE = readFileSync(path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt'), 'utf8');

const MOCKED_SUMMARY = 'TAILORED SUMMARY: rewritten to target a backend engineering role.';
const MOCKED_PROJECT_BULLETS = ['TAILORED PROJECT BULLET ONE targeting Python and AWS.', 'TAILORED PROJECT BULLET TWO.'];
const MOCKED_EXPERIENCE_BULLETS = ['TAILORED EXPERIENCE BULLET ONE.', 'TAILORED EXPERIENCE BULLET TWO.'];

test('Phase 2 vertical slice: TXT in -> mocked LLM call -> real DOCX in Downloads, locked fields intact', async (t) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });

  const mockLlm = await startMockLlmServer(() => ({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: MOCKED_SUMMARY,
          entries: [
            { index: 0, bullets: MOCKED_PROJECT_BULLETS },
            { index: 1, bullets: MOCKED_EXPERIENCE_BULLETS },
          ],
        }),
      },
    }],
    usage: { total_tokens: 42 },
  }));

  t.after(async () => {
    await context.close();
    await mockLlm.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const sw = await getExtensionServiceWorker(context);
  const extensionId = sw.url().split('/')[2];
  const page = await context.newPage();
  // llmBaseUrlOverride points the real pipeline at the local mock server —
  // context.route() cannot mock offscreen-document fetches, see helpers.mjs.
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mockLlm.url)}`);

  await page.fill('#resumeText', FIXTURE);
  await page.fill('#jobDescription', 'Seeking a backend engineer experienced with Python and AWS.');
  await page.selectOption('#provider', 'gemini');
  await fillApiKey(page);
  await page.uncheck('#includeCoverLetter');
  // Chip OFF for this run, deliberately: it proves the preference is real,
  // and it leaves the button as the ONLY source of a PDF below. With
  // auto-download on, waiting for "a PDF download" would be satisfied by the
  // automatic one and would assert nothing about the button at all.
  await page.uncheck('#autoDownloadPdf');
  await page.click('#tailorBtn');

  await page.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 20000 });

  const resultJson = JSON.parse(await page.textContent('#result'));
  assert.equal(resultJson.ok, true, `expected ok:true, got ${JSON.stringify(resultJson)}`);

  // Timing has to survive the offscreen -> service worker -> popup hops, or
  // the breakdown silently becomes an empty string and nobody notices until
  // the next "why was that slow".
  assert.ok(resultJson.llm, 'no llm timing reached the popup');
  assert.ok(resultJson.llm.calls > 0, 'call count should be recorded');
  assert.ok(resultJson.timings && resultJson.timings.resume, 'no per-phase timing reached the popup');
  assert.equal(typeof resultJson.timings.resume.ms, 'number');
  assert.ok(Array.isArray(resultJson.downloads) && resultJson.downloads.length >= 1, 'expected at least one download in the response');
  const resumeDownload = resultJson.downloads.find((d) => d.kind === 'resume');
  assert.ok(resumeDownload && resumeDownload.downloadId !== undefined, 'expected a real chrome.downloads id for the resume');
  // At least one real HTTP request reached the mock server. It is more than
  // one because the skills section is a separate tailoring pass (see
  // tailorSkills.js) and this single-response mock never returns a valid
  // skills map, so that pass exhausts its retries -- which is exactly the
  // deterministic-revert behaviour it is supposed to have. The dedicated
  // assertion for skills lives in tests/unit/tailorSkills.test.mjs.
  assert.ok(mockLlm.requestCount() >= 1, 'expected at least one real HTTP request to reach the mock LLM server');

  // Note: downloadItem.filename here is wherever Playwright's own
  // acceptDownloads artifact capture relocated the file to (a UUID, no
  // extension) -- it does not reflect the filename the extension actually
  // requested. That's Playwright's download-capture behavior, not
  // something under test; the content checks below are the real proof.
  const downloadItem = await waitForCompletedDownload(sw, resumeDownload.downloadId);

  const buffer = readFileSync(downloadItem.filename);
  const text = await docxTextOf(buffer);

  // Editable content: the mocked tailored text must be present.
  assert.ok(text.includes(MOCKED_SUMMARY), 'tailored summary missing from the rendered docx');
  for (const bullet of [...MOCKED_PROJECT_BULLETS, ...MOCKED_EXPERIENCE_BULLETS]) {
    assert.ok(text.includes(bullet), `tailored bullet missing from the rendered docx: ${bullet}`);
  }

  // The ORIGINAL untailored bullets must be gone -- proves real replacement, not pass-through.
  assert.ok(!text.includes('Integrated Model Context Protocol'), 'original untailored bullet text should have been replaced');
  assert.ok(!text.includes('Led and mentored groups'), 'original untailored bullet text should have been replaced');

  // Locked fields: must survive untouched, verbatim, through the entire
  // real pipeline (parse -> LLM round trip -> render), not just in the
  // in-memory model tested by tests/unit/.
  assert.ok(text.includes('Juan Rivera'), 'locked name missing from rendered docx');
  assert.ok(text.includes('647-555-0142'), 'locked phone missing from rendered docx');
  assert.ok(text.includes('j.rivera@example.com'), 'locked email missing from rendered docx');
  assert.ok(text.includes('May 2025'), 'locked date missing from rendered docx');
  assert.ok(text.includes('Jan 2026'), 'locked date missing from rendered docx');
  assert.ok(text.includes('Seneca Polytechnic'), 'locked education missing from rendered docx');
  assert.ok(text.includes('Advanced Diploma in Computer Programming'), 'locked education missing from rendered docx');

  // Secondary output path: the SAME tailored content as a PDF, saved in one
  // click.
  //
  // This used to open a tab and raise the print dialog -- the only way to get
  // a PDF before renderPdf.js existed, and four clicks away from a file. The
  // button now hands real bytes to chrome.downloads, so the PDF lands in
  // Downloads exactly as the .docx above it does. What is asserted is the
  // file on disk, and specifically that it carries the LOCKED fields and the
  // TAILORED summary -- the same pair the .docx is checked for, because two
  // formats of one resume disagreeing about the phone number is the failure
  // that matters.
  // With the chip off, nothing but the .docx should have been downloaded.
  assert.deepEqual(
    resultJson.downloads.map((d) => d.kind).sort(), ['resume'],
    'with "PDF copy" unchecked a run must download the .docx only',
  );

  assert.equal(await page.locator('#previewBtn').isVisible(), true, 'resume PDF button should appear after a successful tailor');
  await page.click('#previewBtn');

  // Matched by MIME: Playwright renames downloads to extensionless GUIDs.
  const pdfItem = await waitForNewestDownload(sw, 'application/pdf');
  const pdfText = await pdfTextOf(pdfItem.filename);
  assert.ok(pdfText.includes('Juan Rivera'), 'PDF missing locked name');
  assert.ok(pdfText.includes('647-555-0142'), 'PDF missing locked phone');
  assert.ok(pdfText.includes('j.rivera@example.com'), 'PDF missing locked email');
  assert.ok(pdfText.includes('Seneca Polytechnic'), 'PDF missing locked education');
  assert.ok(pdfText.includes(MOCKED_SUMMARY), 'PDF missing the tailored summary');
});
