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

  // 2. And the context is all still there.
  // Stamped with the page it was for, so reopening over a DIFFERENT posting
  // does not present this run as current. The value is empty here because a
  // programmatically opened popup gets no activeTab grant and so cannot read
  // a tab's URL -- the key existing is the wiring; engine/pageIdentity.js
  // tests the decision it feeds.
  assert.ok('pageUrl' in stored, 'a finished run must record which page it was for');
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

test('coming back to a tailored posting brings the job back, not just the result', async (t) => {
  // Reported: tailor a job, visit a different posting (correctly cleared),
  // come back, and the header offers "Re-tailor" over an EMPTY job field.
  //
  // Three things had to line up. The stored run kept the title and employer
  // but not the description. The draft could not cover it -- there is one
  // draft slot, so the second posting overwrote the first. And a restored run
  // returns before the page is read, by design, because reading would fill
  // the description underneath its own finished output.
  //
  // The run now carries the text it was tailored against. Stored rather than
  // re-read: this is what the output came from, so re-tailoring means the
  // same job unless the user changes it, and it survives the posting being
  // edited or taken down.
  const JD = 'THE DESCRIPTION THIS RUN WAS ACTUALLY TAILORED AGAINST';
  const { popup } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate(([key, jd]) => chrome.storage.local.set({
        [key]: {
          at: Date.now(), jobTitle: 'Backend Engineer', employer: 'Acme Corp',
          jobDescription: jd, pageUrl: 'https://jobs.test/a', wordCount: 431,
          downloads: ['a.docx'], htmlPreview: '<h1>preview</h1>',
          resumeStatus: 'approved', resumeWarnings: [], resumeErrors: [],
        },
      }), [LAST_RUN_KEY, JD]);
    },
  });

  await popup.waitForFunction(
    () => document.getElementById('tailorBtnLabel').textContent === 'Re-tailor',
    { timeout: 10000 },
  );
  assert.equal(await popup.inputValue('#jobDescription'), JD,
    'offering a re-tailor with nothing to tailor is the reported bug');
  assert.equal(await popup.inputValue('#jobTitle'), 'Backend Engineer');
  assert.equal(await popup.inputValue('#employer'), 'Acme Corp');
});

test('later edits beat the snapshot the run was tailored from', async (t) => {
  // A draft for this page is the user's own more recent work, so it wins.
  // applyLastRun only ever fills fields that are empty.
  const { popup } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate(([runKey, draftKey]) => chrome.storage.local.set({
        [runKey]: {
          at: Date.now(), jobTitle: 'Backend Engineer', employer: 'Acme Corp',
          jobDescription: 'THE OLD SNAPSHOT', pageUrl: '', wordCount: 431,
          downloads: ['a.docx'], htmlPreview: '<h1>preview</h1>',
          resumeStatus: 'approved', resumeWarnings: [], resumeErrors: [],
        },
        [draftKey]: { at: Date.now(), pageUrl: '', jobDescription: 'MY LATER EDITS' },
      }), [LAST_RUN_KEY, 'tailorune_job_draft_v1']);
    },
  });

  await popup.waitForFunction(
    () => document.getElementById('jobDescription').value === 'MY LATER EDITS',
    { timeout: 10000 },
  );
});

// --- pinning a job ---------------------------------------------------------
//
// Everything else in the popup follows the tab in front of it: the job is read
// on open, and one belonging to a different posting is put away. Right by
// default, wrong when comparing two postings in adjacent tabs, or drafting
// against a description pasted out of an email while the tab shows something
// else. A pin turns the AUTOMATIC behaviour off for one job.

test('pin needs a job, and remembers being pinned', async (t) => {
  const { popup, sw } = await openRealPopup(t);
  const pressed = () => popup.$eval('#pinBtn', (el) => el.getAttribute('aria-pressed'));

  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), true,
    'there is nothing to pin before a job exists');

  await popup.fill('#jobDescription', 'A JOB WORTH HOLDING ON TO');
  await popup.waitForTimeout(700);
  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), false);
  assert.equal(await pressed(), 'false');

  await popup.click('#pinBtn');
  await popup.waitForTimeout(700);
  assert.equal(await pressed(), 'true');

  const draft = await readStorage(sw, JOB_DRAFT_KEY);
  assert.equal(draft.pinned, true, 'the pin must outlive the popup, like the draft it belongs to');
  assert.ok('pageUrl' in draft, 'and remember the page, so a finished run can still be matched to it');

  await popup.click('#pinBtn');
  await popup.waitForTimeout(700);
  assert.equal(await pressed(), 'false');
  assert.equal((await readStorage(sw, JOB_DRAFT_KEY)).pinned, false);
});

// A read that SUCCEEDS, which the harness cannot otherwise produce: activeTab
// is granted by a real toolbar click and never by the programmatic openPopup()
// a test must use, so a genuine extraction finds nothing here whatever page is
// in front. A read that finds nothing leaves the pin correctly disabled, which
// is precisely what hid the bug below. Stubbed on the service worker, ahead of
// the real handler -- that one answers after an await, so this wins the race.
// What is under test is what the POPUP does with a successful read.
const FOUND = {
  text: 'A JOB THE PAGE HANDED BACK',
  jobTitle: 'Backend Engineer',
  employer: 'Acme Corp',
  source: 'JSON-LD',
  confidence: 'high',
};
const stubExtract = async (worker) => {
  await worker.evaluate((job) => {
    chrome.runtime.onMessage.addListener((m, _s, sendResponse) => {
      if (!m || m.target !== 'sw' || m.type !== 'job:extract') return undefined;
      sendResponse({ ok: true, job });
      return true;
    });
  }, FOUND);
};

test('reset leaves the pin usable for the job it just re-read', async (t) => {
  // REPORTED. Finish a run, press Reset, and the job comes straight back off
  // the page -- into a form whose pin is greyed out and still offering to
  // wait for a job that is sitting right there.
  //
  // Reset disables the pin the moment it empties the fields, which is right,
  // and then never asks again once the re-read fills them. Nothing did: the
  // pin was recomputed on the description's `input` event, which a user
  // typing fires and `.value = ...` does not. Boot got away with it because
  // it renders the pin after restoreOrDetect settles; Reset had no such
  // backstop, so it is the one path that could disable the button and then
  // leave it that way.
  const { popup } = await openRealPopup(t, { beforeOpen: stubExtract });
  await popup.fill('#jobDescription', 'THE JOB I HAVE FINISHED WITH');
  await popup.waitForTimeout(700);

  await popup.click('#resetBtn');
  await popup.waitForTimeout(1500);

  assert.equal(await popup.inputValue('#jobDescription'), FOUND.text,
    'precondition: reset re-read the page and refilled the form');
  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), false,
    'the job is back, so the pin must be usable again');
  assert.doesNotMatch(await popup.$eval('#pinBtn', (el) => el.title), /nothing to pin/i,
    'and must not still be waiting for one');
});

test('reading the page makes its job pinnable', async (t) => {
  // The same defect through the other door: both fills run through
  // applyExtractedJob, which is why the fix belongs there and not at each
  // caller -- one rule, at the write, instead of three call sites to
  // remember.
  //
  // The form is emptied by TYPING rather than by Reset, which with a read
  // that succeeds would simply refill it. Clearing it this way fires the
  // `input` event, so the pin greys out honestly and the button click that
  // follows is the only thing that can bring it back.
  const { popup } = await openRealPopup(t, { beforeOpen: stubExtract });
  await popup.waitForTimeout(1200);

  await popup.fill('#jobDescription', '');
  await popup.waitForTimeout(700);
  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), true,
    'precondition: an empty form has nothing to pin');

  await popup.click('#readPageBtn');
  await popup.waitForTimeout(1200);

  assert.equal(await popup.inputValue('#jobDescription'), FOUND.text);
  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), false,
    'a job read from the page is a job, and must be pinnable');
});

test('a pinned job never asks which page it is on', async (t) => {
  // THE POINT OF THE FEATURE, and the one part of it this harness can prove.
  //
  // Page identity cannot be exercised here -- reading a tab's URL needs an
  // activeTab grant that a programmatically opened popup never gets, so every
  // comparison takes the fail-open path and pinned and unpinned look alike.
  //
  // What IS observable is that a pinned job short-circuits before any of it:
  // it asks the service worker neither which page this is nor to read one.
  // Unpinned, with a draft stored, it asks.
  const spy = async (worker) => {
    await worker.evaluate(() => {
      self.__urlCalls = 0;
      self.__extractCalls = 0;
      chrome.runtime.onMessage.addListener((m) => {
        if (!m || m.target !== 'sw') return;
        if (m.type === 'tab:url') self.__urlCalls += 1;
        if (m.type === 'job:extract') self.__extractCalls += 1;
      });
    });
  };
  const seed = (pinned) => async (worker) => {
    await spy(worker);
    await worker.evaluate(([key, isPinned]) => chrome.storage.local.set({
      [key]: {
        at: Date.now(),
        pageUrl: 'https://jobs.example.com/roles/42',
        pinned: isPinned,
        jobDescription: 'THE PINNED JOB',
        jobTitle: 'Backend Engineer',
        employer: 'Acme Corp',
      },
    }), [JOB_DRAFT_KEY, pinned]);
  };

  const pinnedPopup = await openRealPopup(t, { beforeOpen: seed(true) });
  await pinnedPopup.popup.waitForTimeout(2000);
  assert.equal(await pinnedPopup.sw.evaluate(() => self.__urlCalls), 0,
    'a pinned job must not care which tab is in front');
  assert.equal(await pinnedPopup.sw.evaluate(() => self.__extractCalls), 0,
    'nor let the page read over it');
  assert.equal(await pinnedPopup.popup.inputValue('#jobDescription'), 'THE PINNED JOB');
  assert.equal(await pinnedPopup.popup.$eval('#pinBtn', (el) => el.getAttribute('aria-pressed')), 'true',
    'and it must come back looking pinned');

  const loosePopup = await openRealPopup(t, { beforeOpen: seed(false) });
  await loosePopup.popup.waitForTimeout(2000);
  assert.ok(await loosePopup.sw.evaluate(() => self.__urlCalls) >= 1,
    'unpinned, the same draft DOES get checked against the page');
});

test('reset releases the pin along with the job', async (t) => {
  // Reset discards the job, so there is nothing left to hold in place. Leaving
  // the pin set would silently suppress the read on the next posting.
  const { popup, sw } = await openRealPopup(t);
  await popup.fill('#jobDescription', 'SOMETHING PINNED THEN DISCARDED');
  await popup.waitForTimeout(700);
  await popup.click('#pinBtn');
  await popup.waitForTimeout(700);
  assert.equal(await popup.$eval('#pinBtn', (el) => el.getAttribute('aria-pressed')), 'true');

  await popup.click('#resetBtn');
  await popup.waitForTimeout(900);

  assert.equal(await popup.$eval('#pinBtn', (el) => el.getAttribute('aria-pressed')), 'false');
  assert.equal(await popup.$eval('#pinBtn', (el) => el.disabled), true, 'and back to nothing to pin');
  assert.equal(await readStorage(sw, JOB_DRAFT_KEY), null);
});
