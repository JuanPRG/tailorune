// prior-tailoring.test.mjs — "you already tailored for this job".
//
// The matching rules are unit-tested in tests/unit/jobHistory.test.mjs, where
// the interesting cases live. What is proved here is the WIRING, which is the
// half that cannot be reasoned about: that the popup reads the history it was
// given, matches it against the job actually on screen, and stays quiet in
// the case where something else is already saying the same thing.
//
// Every fixture pins the job. A pinned draft short-circuits the page checks
// in restoreOrDetect, which is the only way to make this deterministic --
// reading a tab's URL needs an activeTab grant, and that comes from a real
// toolbar click, never the programmatic openPopup() a test must use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openRealPopup } from './realPopup.mjs';

const HISTORY_KEY = 'tailorune_history_v1';
const JOB_DRAFT_KEY = 'tailorune_job_draft_v1';
const LAST_RUN_KEY = 'tailorune_last_run_v1';

const PAGE = 'https://jobs.example.com/roles/42';
const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;

/** A job pinned to PAGE, so the popup restores it without asking any tab. */
const draftFor = (job) => ({
  at: Date.now(),
  pageUrl: PAGE,
  pinned: true,
  jobDescription: 'A job description long enough to be real.',
  jobTitle: job.jobTitle,
  employer: job.employer,
});

const seed = (records) => async (worker) => {
  await worker.evaluate((entries) => chrome.storage.local.set(entries), records);
};

const notice = async (popup) => ({
  hidden: await popup.$eval('#priorTailorNotice', (el) => el.hidden),
  text: (await popup.textContent('#priorTailorNotice')) || '',
});

test('coming back to a job tailored for weeks ago says so', async (t) => {
  // The case nothing else covers. The single last-run slot has long since
  // moved on to other postings, the draft with it -- so without the history
  // this posting looks brand new.
  const { popup } = await openRealPopup(t, {
    beforeOpen: seed({
      [HISTORY_KEY]: [{
        at: Date.now() - THREE_DAYS,
        pageUrl: PAGE,
        employer: 'Acme Corp',
        jobTitle: 'Backend Engineer',
        times: 1,
      }],
      [JOB_DRAFT_KEY]: draftFor({ employer: 'Acme Corp', jobTitle: 'Backend Engineer' }),
    }),
  });
  await popup.waitForTimeout(2000);

  const shown = await notice(popup);
  assert.equal(shown.hidden, false, 'the notice must be visible');
  assert.match(shown.text, /already tailored/i);
  assert.match(shown.text, /Backend Engineer/, 'and name the job');
  assert.match(shown.text, /Acme Corp/);
  assert.match(shown.text, /3 days ago/, 'and say when');
  assert.doesNotMatch(shown.text, /\bapplied\b/i,
    'it knows a resume was made, not that one was ever sent');
});

test('a job never tailored for is not accused of it', async (t) => {
  const { popup } = await openRealPopup(t, {
    beforeOpen: seed({
      [HISTORY_KEY]: [{
        at: Date.now() - THREE_DAYS,
        pageUrl: 'https://jobs.example.com/roles/999',
        employer: 'Northwind Systems',
        jobTitle: 'Data Analyst',
        times: 1,
      }],
      [JOB_DRAFT_KEY]: draftFor({ employer: 'Acme Corp', jobTitle: 'Backend Engineer' }),
    }),
  });
  await popup.waitForTimeout(2000);

  assert.equal((await notice(popup)).hidden, true);
});

test('a second role at an employer already tailored for is a different job', async (t) => {
  // The expensive mistake this feature could make. A wrong "you already did
  // this" makes someone skip a job they wanted; a missed repeat costs one
  // duplicate document.
  const { popup } = await openRealPopup(t, {
    beforeOpen: seed({
      [HISTORY_KEY]: [{
        at: Date.now() - THREE_DAYS,
        pageUrl: 'https://jobs.example.com/roles/7',
        employer: 'Acme Corp',
        jobTitle: 'Backend Engineer',
        times: 1,
      }],
      [JOB_DRAFT_KEY]: draftFor({ employer: 'Acme Corp', jobTitle: 'Frontend Engineer' }),
    }),
  });
  await popup.waitForTimeout(2000);

  assert.equal((await notice(popup)).hidden, true,
    'same employer, different role -- and the URLs differ too');
});

test('it keeps quiet while the run itself is on screen', async (t) => {
  // A restored run already says "Previous run — Backend Engineer at Acme" in
  // the status line, and that is the same job that would match here. Two
  // voices saying one thing is worse than one.
  const { popup } = await openRealPopup(t, {
    beforeOpen: seed({
      [HISTORY_KEY]: [{
        at: Date.now() - THREE_DAYS,
        pageUrl: PAGE,
        employer: 'Acme Corp',
        jobTitle: 'Backend Engineer',
        times: 1,
      }],
      [JOB_DRAFT_KEY]: draftFor({ employer: 'Acme Corp', jobTitle: 'Backend Engineer' }),
      [LAST_RUN_KEY]: {
        at: Date.now() - 60000,
        pageUrl: PAGE,
        jobTitle: 'Backend Engineer',
        employer: 'Acme Corp',
        jobDescription: 'A job description long enough to be real.',
        wordCount: 393,
        downloads: ['a.docx'],
        resumeStatus: 'approved',
      },
    }),
  });
  await popup.waitForTimeout(2000);

  // Proven silent for the RIGHT reason: the run really is restored, and the
  // job really is the one that would otherwise match.
  assert.equal(await popup.textContent('#tailorBtnLabel'), 'Re-tailor',
    'precondition: a finished run is on screen');
  assert.equal(await popup.inputValue('#employer'), 'Acme Corp',
    'precondition: showing the job the history knows about');
  assert.equal((await notice(popup)).hidden, true, 'silent while the run is showing');
});

test('clearing the history in settings silences it', async (t) => {
  // The history has to outlive Reset or it could not do its job, so Reset is
  // no longer the whole privacy story and this is the rest of it.
  const { popup } = await openRealPopup(t, {
    beforeOpen: seed({
      [HISTORY_KEY]: [{
        at: Date.now() - THREE_DAYS,
        pageUrl: PAGE,
        employer: 'Acme Corp',
        jobTitle: 'Backend Engineer',
        times: 1,
      }],
      [JOB_DRAFT_KEY]: draftFor({ employer: 'Acme Corp', jobTitle: 'Backend Engineer' }),
    }),
  });
  await popup.waitForTimeout(2000);
  assert.equal((await notice(popup)).hidden, false, 'precondition: the notice is up');

  await popup.click('#settingsBtn');
  await popup.click('#clearHistoryBtn');
  await popup.waitForTimeout(700);

  assert.equal((await notice(popup)).hidden, true, 'the notice goes with the history');
  const left = await popup.evaluate(
    (key) => chrome.storage.local.get(key).then((got) => got[key]), HISTORY_KEY,
  );
  assert.equal(left, undefined, 'and the record is actually gone from storage');
});
