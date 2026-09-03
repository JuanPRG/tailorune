// run-survives-popup-close.test.mjs — tabbing out must not cost the run.
//
// Reported by the user: "when I tab out after completing a generation I lose
// all warnings and generated artifacts to preview as pdf".
//
// A browser-action popup is destroyed the moment it loses focus -- already
// confirmed in this project, and the reason popup-context.test.mjs exists at
// all. So glancing at the download shelf after a run was enough to lose both
// preview buttons and every finding, while the .docx files sat in Downloads.
// Files present, every reason for how they look gone, and no way back to the
// print-to-PDF preview short of running the whole thing again.
//
// The service worker now persists the finished result BEFORE it responds, so
// the work is safe even when there is no popup left to answer. Two things are
// checked here, and they are different claims:
//
//   1. the .docx files are produced even if the popup is gone
//   2. the result comes back when the popup is reopened
//
// The first was already true -- downloadOutputs() is awaited before
// sendResponse -- but it was true by accident of ordering, and nothing pinned
// it. Now something does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { startMockLlmServer } from './mockLlmServer.mjs';
import { getExtensionServiceWorker, fillApiKey } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE = readFileSync(path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt'), 'utf8');
const LAST_RUN_KEY = 'tailorune_last_run_v1';

test('a finished run is recoverable after the popup is gone', async (t) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-survive-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });
  // The mock answers with a full OpenAI envelope; the tailored JSON is the
  // message CONTENT, same as a real provider.
  const mock = await startMockLlmServer(() => ({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: 'TAILORED SUMMARY for a backend engineering role.',
          entries: [
            { index: 0, bullets: ['TAILORED BULLET ONE.', 'TAILORED BULLET TWO.'] },
            { index: 1, bullets: ['TAILORED BULLET THREE.'] },
          ],
        }),
      },
      finish_reason: 'stop',
    }],
    usage: { total_tokens: 42 },
  }));
  t.after(async () => {
    await mock.close();
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const sw = await getExtensionServiceWorker(context);
  const extensionId = sw.url().split('/')[2];
  const popupUrl = `chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mock.url)}`;

  // --- run it, in a page standing in for the popup ------------------------
  const page = await context.newPage();
  await page.goto(popupUrl);
  await page.fill('#resumeText', FIXTURE);
  await page.fill('#jobDescription', 'Backend engineer. Python, AWS, reliability.');
  await page.fill('#jobTitle', 'Backend Engineer');
  await page.fill('#employer', 'Acme Corp');
  await page.uncheck('#useJudge');
  // The mock answers every call with the same resume JSON, so a cover-letter
  // pass would fail validation and retry until the test times out. This test
  // is about SURVIVING a closed popup, not about letter quality.
  await page.uncheck('#includeCoverLetter');
  await fillApiKey(page, 'test-key-not-real');
  await page.click('#tailorBtn');

  await page.waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Done'),
    { timeout: 60000 },
  );

  // --- the popup goes away, exactly as it does on focus loss --------------
  await page.close();

  // 1. The documents exist regardless.
  const stored = await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], LAST_RUN_KEY);
  assert.ok(stored, 'the finished run should have been persisted by the service worker');
  assert.ok((stored.downloads || []).length >= 1, 'at least the resume should have been downloaded');

  // 2. And it is all still there: previews, findings, context.
  assert.ok(stored.htmlPreview, 'the resume preview HTML must survive');
  assert.equal(stored.jobTitle, 'Backend Engineer');
  assert.equal(stored.employer, 'Acme Corp');
  assert.ok(stored.wordCount > 0);

  // --- reopen: the user should find their run waiting ---------------------
  const reopened = await context.newPage();
  await reopened.goto(popupUrl);
  await reopened.waitForFunction(
    () => document.getElementById('status').textContent.includes('Previous run'),
    { timeout: 10000 },
  );

  const status = await reopened.textContent('#status');
  assert.match(status, /Backend Engineer at Acme Corp/, 'it should say which job the run was for');
  assert.match(status, /file/, 'and that the files are in Downloads');

  assert.equal(
    await reopened.locator('#previewBtn').isVisible(), true,
    'the resume preview button must come back -- losing it was the reported bug',
  );

  // The restored preview must actually open, not just be visible.
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    reopened.click('#previewBtn'),
  ]);
  await tab.waitForLoadState('domcontentloaded');
  assert.match(await tab.textContent('body'), /TAILORED BULLET ONE/,
    'the restored preview should contain the tailored resume');
});
