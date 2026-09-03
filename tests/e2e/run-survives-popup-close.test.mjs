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
import { BROWSER } from './browser.mjs';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { startMockLlmServer } from './mockLlmServer.mjs';
import { openRealPopup, readStorage } from './realPopup.mjs';
import { getExtensionServiceWorker, fillApiKey,
  waitForNewestDownload, pdfTextOf,
} from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE = readFileSync(path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt'), 'utf8');
const LAST_RUN_KEY = 'tailorune_last_run_v1';

test('a finished run is recoverable after the popup is gone', async (t) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-survive-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
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
  // Chip off: the PDF must come from the RESTORED button, not from the
  // automatic download this run would otherwise have produced.
  await page.uncheck('#autoDownloadPdf');
  await page.click('#tailorBtn');

  // The CTA must announce that it is working. onTailorClick sets this
  // synchronously before its first await, so it is observable the instant the
  // click handler has run -- no race with the mock's reply.
  assert.equal(await page.getAttribute('#tailorBtn', 'data-busy'), 'true',
    'the button should enter its running state immediately');
  assert.equal(await page.textContent('#tailorBtnLabel'), 'Tailoring…',
    'the label carries the state for anyone not watching the icon');

  await page.waitForFunction(
    () => document.getElementById('status').textContent.startsWith('Done'),
    { timeout: 60000 },
  );

  assert.equal(await page.getAttribute('#tailorBtn', 'data-busy'), null,
    'the running state must clear when the run ends');
  assert.equal(await page.textContent('#tailorBtnLabel'), 'Re-tailor',
    'and the label returns to the paired state, not to its pre-run text');

  // --- the popup goes away, exactly as it does on focus loss --------------
  await page.close();

  // 1. The documents exist regardless.
  const stored = await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], LAST_RUN_KEY);
  assert.ok(stored, 'the finished run should have been persisted by the service worker');
  assert.ok((stored.downloads || []).length >= 1, 'at least the resume should have been downloaded');

  // 2. And it is all still there: previews, findings, context.
  assert.ok(stored.htmlPreview, 'the resume preview HTML must survive');
  // The rendered PDF has to survive too, or "Save as PDF" after a reopen
  // silently degrades to the print dialog it was built to replace.
  assert.ok(stored.resumePdfBase64, 'the rendered resume PDF must survive the popup being destroyed');
  // Stamped with the page it was for, so reopening over a DIFFERENT posting
  // does not present this run as current. The value is empty here because a
  // programmatically opened popup gets no activeTab grant and so cannot read
  // a tab's URL -- the key existing is the wiring; engine/pageIdentity.js
  // tests the decision it feeds.
  assert.ok('pageUrl' in stored, 'a finished run must record which page it was for');
  assert.match(stored.resumePdfFilename, /\.pdf$/, 'and it must know what to call itself');
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

  // The restored button must actually SAVE, not just be visible -- and save
  // the PDF directly, the way the .docx already did, rather than reopening
  // the print dialog.
  await reopened.click('#previewBtn');
  const pdfItem = await waitForNewestDownload(sw, 'application/pdf');
  const pdfText = await pdfTextOf(pdfItem.filename);
  assert.ok(
    pdfText.includes('TAILORED BULLET ONE'),
    'the PDF saved from a RESTORED run should contain the tailored resume',
  );
  assert.ok(pdfText.includes('Juan Rivera'), 'and the candidate name');
});

test('reset clears the job and the stored run, and keeps what is expensive', async (t) => {
  // The scope IS the feature. A reset that took the resume and the API keys
  // with it would be worse than no reset at all: those are the two things a
  // user cannot cheaply re-enter, and the library exists precisely because
  // one resume serves many applications.
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-reset-'));
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
  const extensionId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  // Seed a finished run and a filled-in form.
  await sw.evaluate(async (key) => chrome.storage.local.set({
    [key]: {
      at: Date.now(), jobTitle: 'Analyst', employer: 'Acme', wordCount: 400,
      downloads: ['a.docx'], htmlPreview: '<h1>preview</h1>', resumeStatus: 'approved',
    },
  }), LAST_RUN_KEY);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('Previous run'));

  await page.fill('#resumeText', 'MY RESUME TEXT');
  await page.fill('#jobDescription', 'A very long job description that would be annoying to re-paste.');
  await page.fill('#jobTitle', 'Analyst');
  await fillApiKey(page, 'my-precious-key');
  await page.waitForTimeout(500);

  // A finished run puts the footer in its paired state: the CTA offers
  // another attempt at THIS job, the reset beside it moves on to another.
  assert.equal(await page.textContent('#tailorBtnLabel'), 'Re-tailor',
    'with a run on screen the CTA should offer another attempt, not a first one');
  assert.equal(await page.locator('#footerResetBtn').isVisible(), true,
    'the footer reset should appear alongside it');

  // Single click, by request -- no arming step.
  await page.click('#resetBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Cleared'));

  assert.equal(await page.textContent('#tailorBtnLabel'), 'Tailor resume',
    'with nothing to re-tailor the CTA should go back to its first-run label');
  assert.equal(await page.locator('#footerResetBtn').isVisible(), false,
    'and the paired reset should go with it');

  assert.equal(await page.inputValue('#jobDescription'), '', 'the job description should be cleared');
  assert.equal(await page.inputValue('#jobTitle'), '', 'the job title should be cleared');
  assert.equal(await page.locator('#previewBtn').isVisible(), false, 'the stale preview button should go');

  // The expensive things survive.
  assert.equal(await page.inputValue('#resumeText'), 'MY RESUME TEXT', 'the resume must NOT be cleared');
  assert.equal(await page.inputValue('#apiKey'), 'my-precious-key', 'the API key must NOT be cleared');

  // And the stored run is actually gone -- otherwise it would return on open.
  const stored = await sw.evaluate(async (key) => (await chrome.storage.local.get(key))[key], LAST_RUN_KEY);
  assert.equal(stored, undefined, 'the stored run should be deleted, not just hidden');

  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await reopened.waitForTimeout(900);
  assert.ok(!(await reopened.textContent('#status')).includes('Previous run'),
    'the cleared run must not come back on reopen');
});

// --- the job you were typing ---------------------------------------------
//
// Same failure as the run above, one field earlier. A browser-action popup
// dies the moment it loses focus, and the job fields were never persisted --
// so pasting a description, glancing at the posting in the tab behind it, and
// coming back found the form empty.
//
// Automatic detection covers the case where the page still has the job on it.
// It does nothing for a description pasted out of an email, a PDF, or a site
// the extractor cannot read, which is exactly when retyping hurts most.

const JOB_DRAFT_KEY = 'tailorune_job_draft_v1';

test('a job typed by hand survives the popup being destroyed', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  const TYPED = 'PASTED FROM AN EMAIL — this posting is on no page anywhere';
  await popup.fill('#jobDescription', TYPED);
  await popup.fill('#jobTitle', 'Staff Engineer');
  await popup.fill('#employer', 'Quiet Corp');
  await popup.waitForTimeout(900); // past the save debounce

  const draft = await readStorage(sw, JOB_DRAFT_KEY);
  assert.ok(draft, 'nothing was kept — losing popup focus would cost the whole description');
  assert.equal(draft.jobDescription, TYPED);
  assert.equal(draft.jobTitle, 'Staff Engineer');
  assert.equal(draft.employer, 'Quiet Corp');

  // STAMPED, for the same reason a finished run is. An unstamped draft would
  // follow the user to the next posting and reintroduce the very bug this
  // work started from, with the description instead of the results.
  assert.ok('pageUrl' in draft, 'a draft must record which page it belongs to');
});

test('a stored draft comes back when the popup reopens', async (t) => {
  const TYPED = 'A DESCRIPTION THE EXTRACTOR COULD NEVER HAVE FOUND';
  const { popup } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate(([key, text]) => chrome.storage.local.set({
        [key]: { at: Date.now(), pageUrl: '', jobDescription: text, jobTitle: 'Staff Engineer', employer: 'Quiet Corp' },
      }), [JOB_DRAFT_KEY, TYPED]);
    },
  });

  await popup.waitForFunction(
    (text) => document.getElementById('jobDescription').value === text,
    TYPED, { timeout: 10000 },
  );
  assert.equal(await popup.inputValue('#jobTitle'), 'Staff Engineer');
  assert.equal(await popup.inputValue('#employer'), 'Quiet Corp');
});

test('reset forgets the draft, or it would come straight back', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.fill('#jobDescription', 'SOMETHING TO THROW AWAY');
  await popup.waitForTimeout(900);
  assert.ok(await readStorage(sw, JOB_DRAFT_KEY), 'precondition: a draft exists to clear');

  await popup.click('#resetBtn');
  await popup.waitForTimeout(700);

  // readStorage normalises a missing key to null, not undefined.
  assert.equal(await readStorage(sw, JOB_DRAFT_KEY), null,
    'a cleared job must not be restored on the next open');
  assert.equal(await popup.inputValue('#jobDescription'), '');
});

test('reset re-reads the page rather than just emptying the form', async (t) => {
  // "Start a new application" should leave you ready to work on the posting
  // in front of you, not staring at an empty form with a button to press.
  //
  // Only the READ is provable here -- activeTab comes from a real toolbar
  // click, never the programmatic openPopup() a test must use, so the read
  // finds nothing in this harness whatever page is in front. Counted on the
  // service worker, which sees the request regardless.
  const { popup, sw } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate(() => {
        self.__extractCalls = 0;
        chrome.runtime.onMessage.addListener((m) => {
          if (m && m.target === 'sw' && m.type === 'job:extract') self.__extractCalls += 1;
        });
      });
    },
  });

  const MINE = 'A DESCRIPTION I ASSEMBLED BY HAND';
  await popup.fill('#jobDescription', MINE);
  await popup.waitForTimeout(800);
  const before = await sw.evaluate(() => self.__extractCalls);

  await popup.click('#resetBtn');
  await popup.waitForTimeout(1200);

  assert.equal(await sw.evaluate(() => self.__extractCalls), before + 1,
    'reset must read the current page, not just empty the form');
});
