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
import { getExtensionServiceWorker, docxTextOf, waitForCompletedDownload } from './helpers.mjs';

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
  await page.fill('#apiKey', 'test-key-not-real');
  await page.click('#tailorBtn');

  await page.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 20000 });

  const resultJson = JSON.parse(await page.textContent('#result'));
  assert.equal(resultJson.ok, true, `expected ok:true, got ${JSON.stringify(resultJson)}`);
  assert.ok(resultJson.downloadId !== undefined, 'expected a real chrome.downloads id in the response');
  assert.equal(mockLlm.requestCount(), 1, 'expected exactly one real HTTP request to reach the mock LLM server');

  // Note: downloadItem.filename here is wherever Playwright's own
  // acceptDownloads artifact capture relocated the file to (a UUID, no
  // extension) -- it does not reflect the filename the extension actually
  // requested. That's Playwright's download-capture behavior, not
  // something under test; the content checks below are the real proof.
  const downloadItem = await waitForCompletedDownload(sw, resultJson.downloadId);

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

  // Secondary output path: Preview / Print PDF opens a real tab with the
  // same tailored content, rendered as HTML rather than DOCX.
  assert.equal(await page.locator('#previewBtn').isVisible(), true, 'preview button should appear after a successful tailor');
  const [previewPage] = await Promise.all([
    context.waitForEvent('page'),
    page.click('#previewBtn'),
  ]);
  await previewPage.waitForLoadState();
  const previewText = await previewPage.textContent('body');
  assert.ok(previewText.includes('Juan Rivera'), 'preview tab missing locked name');
  assert.ok(previewText.includes(MOCKED_SUMMARY), 'preview tab missing tailored summary');
  assert.ok(previewText.includes('Headers and footers'), 'preview tab missing the print-hint about Chrome header/footer defaults');
});
