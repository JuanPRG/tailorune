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
import { BROWSER } from './browser.mjs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey,
} from './helpers.mjs';
import { startMockLlmServer } from './mockLlmServer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURES = path.resolve(__dirname, '../fixtures/resumes');
const DOCX_FIXTURE = path.join(FIXTURES, 'juan-rivera-tabstops.docx');
const TXT_FIXTURE = path.join(FIXTURES, 'jordan-lee-standard.txt');
// Same stem, different suffix. A resume is saved under the file's FULL name
// for this reason: these two must be two library entries, not one that
// silently overwrites the other.
const SAME_STEM_DOCX = path.join(FIXTURES, 'juan-rivera.docx');
const SAME_STEM_PDF = path.join(FIXTURES, 'juan-rivera.pdf');

const MOCKED_SUMMARY = 'TAILORED SUMMARY from a saved resume.';

/**
 * Upload a file. That files it in the library too -- there is no Save press.
 *
 * THE WAIT IS KEYED ON THE FILENAME, which is what makes it a real wait rather
 * than an assertion satisfied by the previous upload's leftovers. Waiting on
 * the extracted TEXT looks equivalent and is not: two fixtures can share their
 * contents -- juan-rivera.docx and juan-rivera.pdf do -- so a second upload's
 * wait would be met by the first upload's text, and the test would race the
 * write it is about to assert on.
 */
async function uploadResume(page, fixture) {
  const name = path.basename(fixture);
  await page.setInputFiles('#resumeFile', fixture);
  await page.waitForFunction(
    (n) => document.getElementById('libraryHint').textContent === `Saved "${n}" to your library.`,
    name,
    { timeout: 20000 },
  );
  return name;
}

/**
 * One persistent browser profile for the whole test, so chrome.storage.local
 * survives between popup pages exactly as it does for a real user.
 */
async function launch(t) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-lib-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
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

  // ONE PRESS DID ALL OF IT: read, named after the file, and filed in the
  // library. There is no Save button to follow up with and no name to type,
  // so the pill in the title row is the whole naming story.
  await first.waitForFunction(
    () => document.getElementById('libraryHint').textContent
      === 'Saved "juan-rivera-tabstops.docx" to your library.',
    { timeout: 20000 },
  );
  assert.match(await first.textContent('#resumeMeta'), /^juan-rivera-tabstops\.docx · \d+ words$/);

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
  assert.equal(selectedLabel, 'juan-rivera-tabstops.docx', 'the saved resume should be selected on open');
  assert.match(await second.textContent('#resumeMeta'), /^juan-rivera-tabstops\.docx · \d+ words$/,
    'the pill should name the restored resume');

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

  // TWO REAL UPLOADS. This used to paste two resumes and type a name for
  // each, which was cheaper but is now impossible: there is no paste box and
  // no name field, and the names under test ARE the filenames. Two fixtures
  // in different formats also keep the .docx and .txt readers on this path.
  await uploadResume(page, DOCX_FIXTURE);
  await uploadResume(page, TXT_FIXTURE);

  const labels = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(labels,
    ['Load a saved resume…', 'juan-rivera-tabstops.docx', 'jordan-lee-standard.txt']);

  // Switching the dropdown loads that resume's text and its name.
  const aValue = await page.$eval('#savedResumes option:nth-child(2)', (o) => o.value);
  await page.selectOption('#savedResumes', aValue);
  await page.waitForFunction(() => document.getElementById('resumeText').value.includes('Juan Rivera'));
  assert.match(await page.textContent('#resumeMeta'), /^juan-rivera-tabstops\.docx · \d+ words$/);

  // Deleting is two-step, since confirm() is unavailable in a real popup.
  // The first click only arms it — nothing may be removed yet.
  await page.click('#deleteResumeBtn');
  // ARMED IS AN ATTRIBUTE, not a label. The button is an icon now, so there
  // is no text to swap to "Confirm" -- writing text in would replace the SVG.
  await page.waitForFunction(
    () => document.getElementById('deleteResumeBtn').dataset.armed === 'true');
  const afterArming = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(afterArming,
    ['Load a saved resume…', 'juan-rivera-tabstops.docx', 'jordan-lee-standard.txt'],
    'arming must not delete anything');

  await page.click('#deleteResumeBtn');
  await page.waitForFunction(() => document.getElementById('libraryHint').textContent.includes('Deleted'));

  const remaining = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(remaining, ['Load a saved resume…', 'jordan-lee-standard.txt'],
    'the wrong resume was removed');
  assert.equal(await page.$eval('#deleteResumeBtn', (el) => el.dataset.armed), undefined,
    'the button should disarm itself after committing');
  assert.deepEqual(dialogs(), [], 'the popup must never open a JS dialog');
});

test('re-saving a loaded resume under the same name updates it instead of duplicating it', async (t) => {
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(() => mockLlm.close());

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);
  const dialogs = forbidDialogs(page);

  await uploadResume(page, DOCX_FIXTURE);

  // The user edited their resume on disk and uploads it again. The name has
  // not changed, so this must UPDATE that entry rather than add a second one
  // they cannot tell apart.
  //
  // The hint is blanked and the input cleared to [] first, and both matter.
  // Blanking stops the wait below from passing on the FIRST upload's message;
  // clearing guarantees the file list genuinely changes on the way back, since
  // setInputFiles with an unchanged list is not a reliable way to make the
  // change event fire a second time.
  await page.evaluate(() => { document.getElementById('libraryHint').textContent = ''; });
  await page.setInputFiles('#resumeFile', []);
  await page.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await page.waitForFunction(
    () => document.getElementById('libraryHint').textContent
      === 'Saved "juan-rivera-tabstops.docx" to your library.',
    { timeout: 20000 },
  );

  const labels = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(labels, ['Load a saved resume…', 'juan-rivera-tabstops.docx'],
    'a duplicate entry was created');
  assert.deepEqual(dialogs(), [], 'the popup must never open a JS dialog');
});

test('two formats of the same resume are two entries, not one overwriting the other', async (t) => {
  // WHY THE SAVED NAME KEEPS THE FILE EXTENSION. saveResume() upserts by
  // name, so naming these "juan-rivera" both times would make the second
  // upload silently replace the first -- a user who keeps a .docx to edit and
  // a .pdf to send would lose one of them by uploading the other.
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(() => mockLlm.close());

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);
  const dialogs = forbidDialogs(page);

  await uploadResume(page, SAME_STEM_DOCX);
  await uploadResume(page, SAME_STEM_PDF);

  const labels = await page.$$eval('#savedResumes option', (opts) => opts.map((o) => o.textContent));
  assert.deepEqual(labels, ['Load a saved resume…', 'juan-rivera.docx', 'juan-rivera.pdf'],
    'the two formats collapsed into one library entry');
  assert.deepEqual(dialogs(), [], 'the popup must never open a JS dialog');
});
