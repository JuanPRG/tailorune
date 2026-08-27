// resume-library.test.mjs — proves the saved-resume flow through the real
// extension, against real chrome.storage.local.
//
// The claim under test is the one the feature exists for: upload a .docx
// ONCE, and every later run starts with that resume already loaded. Unit
// tests cover the store's logic against a fake adapter; only a real browser
// can show that the value actually survives the popup being closed, which is
// the entire point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey } from './helpers.mjs';
import { startMockLlmServer } from './mockLlmServer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const DOCX_FIXTURE = path.resolve(__dirname, '../fixtures/resumes/juan-rivera-tabstops.docx');

const MOCKED_SUMMARY = 'TAILORED SUMMARY from a saved resume.';

/**
 * One persistent browser profile for the whole test, so chrome.storage.local
 * survives between popup pages exactly as it does for a real user.
 */
async function launch(t) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-lib-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });
  t.after(async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const sw = await getExtensionServiceWorker(context);
  return { context, sw, extensionId: sw.url().split('/')[2] };
}

async function openPopup(context, extensionId, mockUrl) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mockUrl)}`);
  return page;
}

/**
 * Poll the extension's own storage, from the service worker, until the API key
 * has been written. Reading it through the SW rather than the popup is what
 * makes this a real persistence check instead of an assertion about a DOM
 * value that is about to be thrown away.
 */
async function waitForStoredApiKey(sw, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stored = await sw.evaluate(async () => {
      const result = await chrome.storage.local.get('tailorune_settings_v1');
      const settings = result.tailorune_settings_v1;
      return settings && settings.apiKey ? settings.apiKey : null;
    });
    if (stored) return stored;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the API key was never persisted to chrome.storage.local');
}

/**
 * Record any JS dialog the popup opens, so a test can assert there were none.
 *
 * This is a real regression guard, not hygiene. A browser-action popup is
 * DISMISSED the moment a dialog opens, and prompt() then resolves to null — so
 * naming a resume via window.prompt() silently saved nothing for a real user
 * while passing every test here, because Playwright loads popup.html as an
 * ordinary tab where dialogs behave normally. That context difference is
 * invisible to this harness, so the rule is simply: the popup opens no
 * dialogs, ever. Dismissing rather than accepting mirrors the real popup.
 */
function forbidDialogs(page) {
  const seen = [];
  page.on('dialog', (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  return () => seen;
}

test('a resume uploaded once is saved, survives the popup closing, and reloads automatically', async (t) => {
  const mockLlm = await startMockLlmServer(() => ({
    choices: [{
      message: {
        content: JSON.stringify({
          summary: MOCKED_SUMMARY,
          entries: Array.from({ length: 6 }, (_, index) => ({ index, bullets: ['Delivered a measurable result.'] })),
        }),
      },
    }],
  }));
  t.after(() => mockLlm.close());

  const { context, sw, extensionId } = await launch(t);

  // --- First visit: upload a .docx and save it under a name ---------------
  const first = await openPopup(context, extensionId, mockLlm.url);
  const firstDialogs = forbidDialogs(first);

  await first.setInputFiles('#resumeFile', DOCX_FIXTURE);
  // Extraction is async (it round-trips to the offscreen document), so wait
  // for the text to actually land rather than assuming it is instant.
  await first.waitForFunction(
    () => document.getElementById('resumeText').value.includes('Juan Rivera'),
    { timeout: 20000 },
  );

  // The name defaults to the uploaded file's base name, which beats the first
  // line of the resume — that is just the person's name, and identical across
  // every resume they own.
  assert.equal(await first.inputValue('#resumeName'), 'juan-rivera-tabstops');

  await first.fill('#resumeName', 'Finance CV');
  await first.click('#saveResumeBtn');
  await first.waitForFunction(
    () => document.getElementById('libraryHint').textContent.includes('Saved as'),
    { timeout: 5000 },
  );

  // Settings persist on change rather than only on run, so an API key typed
  // and never used still survives. Wait for the write to actually land before
  // closing — chrome.storage.local.set is async, and a popup that closes
  // mid-write is exactly how the setting would be lost.
  await fillApiKey(first);
  await waitForStoredApiKey(sw);
  assert.deepEqual(firstDialogs(), [], 'the popup must never open a JS dialog');
  await first.close(); // the popup going away is what a real user does constantly

  // --- Second visit: the resume is already there, untouched ---------------
  const second = await openPopup(context, extensionId, mockLlm.url);
  const secondDialogs = forbidDialogs(second);
  await second.waitForFunction(
    () => document.getElementById('resumeText').value.includes('Juan Rivera'),
    { timeout: 5000 },
  );

  const selectedLabel = await second.$eval('#savedResumes', (el) => el.options[el.selectedIndex].textContent);
  assert.equal(selectedLabel, 'Finance CV', 'the saved resume should be selected on open');
  assert.equal(await second.inputValue('#resumeName'), 'Finance CV', 'the name field should reflect the selection');

  const fileInputValue = await second.inputValue('#resumeFile');
  assert.equal(fileInputValue, '', 'no file should need to be re-uploaded');

  // --- And it tailors, with no file upload in this session at all ---------
  await second.fill('#jobDescription', 'Seeking a finance lead with IFRS and forecasting experience.');
  await second.uncheck('#includeCoverLetter');
  await second.uncheck('#useJudge');
  await second.click('#tailorBtn');

  await second.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 30000 });

  const result = JSON.parse(await second.textContent('#result'));
  assert.equal(result.ok, true, JSON.stringify(result));

  const download = result.downloads.find((d) => d.kind === 'resume');
  const item = await waitForCompletedDownload(sw, download.downloadId);
  const text = await docxTextOf(readFileSync(item.filename));
  assert.ok(text.includes(MOCKED_SUMMARY), 'tailored summary missing from the document');
  assert.ok(text.includes('Juan Rivera'), 'the saved resume was not the one tailored');
  assert.deepEqual(secondDialogs(), [], 'the popup must never open a JS dialog');
});

test('a second saved resume can be switched between, and deleting takes two clicks', async (t) => {
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(() => mockLlm.close());

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);
  const dialogs = forbidDialogs(page);

  // Save two distinct resumes by pasting, which needs no extraction round-trip.
  await page.fill('#resumeText', 'Ada Lovelace\nAAA distinctive body text');
  await page.fill('#resumeName', 'Resume A');
  await page.click('#saveResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Saved as'));

  await page.fill('#resumeText', 'Ada Lovelace\nBBB distinctive body text');
  await page.fill('#resumeName', 'Resume B');
  await page.click('#saveResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Resume B'));

  const labels = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(labels, ['— not saved —', 'Resume A', 'Resume B']);

  // Switching the dropdown loads that resume's text and its name.
  const aValue = await page.$eval('#savedResumes option:nth-child(2)', (o) => o.value);
  await page.selectOption('#savedResumes', aValue);
  await page.waitForFunction(() => document.getElementById('resumeText').value.includes('AAA'));
  assert.equal(await page.inputValue('#resumeName'), 'Resume A');

  // Deleting is two-step, since confirm() is unavailable in a real popup.
  // The first click only arms it — nothing may be removed yet.
  await page.click('#deleteResumeBtn');
  await page.waitForFunction(() => document.getElementById('deleteResumeBtn').textContent === 'Confirm');
  const afterArming = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(afterArming, ['— not saved —', 'Resume A', 'Resume B'], 'arming must not delete anything');

  await page.click('#deleteResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Deleted'));

  const remaining = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(remaining, ['— not saved —', 'Resume B'], 'the wrong resume was removed');
  assert.equal(await page.$eval('#deleteResumeBtn', (el) => el.textContent), 'Delete', 'the button should reset');
  assert.deepEqual(dialogs(), [], 'the popup must never open a JS dialog');
});

test('re-saving a loaded resume under the same name updates it instead of duplicating it', async (t) => {
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(() => mockLlm.close());

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);
  const dialogs = forbidDialogs(page);

  await page.fill('#resumeText', 'Ada Lovelace\noriginal body');
  await page.fill('#resumeName', 'My CV');
  await page.click('#saveResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Saved as'));

  // Edit the loaded resume and save again under the same name.
  await page.fill('#resumeText', 'Ada Lovelace\nedited body');
  await page.click('#saveResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Saved as'));

  const labels = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(labels, ['— not saved —', 'My CV'], 'a duplicate entry was created');

  // Reopening proves the edit is what persisted, not the original.
  const reopened = await openPopup(context, extensionId, mockLlm.url);
  await reopened.waitForFunction(() => document.getElementById('resumeText').value.includes('edited body'));
  assert.deepEqual(dialogs(), [], 'the popup must never open a JS dialog');
});
