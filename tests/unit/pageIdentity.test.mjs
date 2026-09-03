// pageIdentity.test.mjs — a finished run must not follow you to the next job.
//
// Reported: tailor a job, move to a different posting, open the popup, and
// the previous run is still there -- "Re-tailor" for a job you left, its
// findings, its save-as-PDF buttons -- with the job description never
// updating until you press Reset.
//
// Tested here rather than end to end because reading a tab's URL needs an
// activeTab grant, and that comes from a user clicking the toolbar icon,
// never from the programmatic openPopup() a test has to use. Measured: in the
// harness `chrome.tabs.query` returns url `undefined`, so the popup sees no
// page at all and every case would take the same fail-open path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePageUrl, isStampedForThisPage } from '../../extension/engine/pageIdentity.js';

const run = (pageUrl) => ({ pageUrl, jobTitle: 'Backend Engineer' });

test('the same posting keeps its run', () => {
  assert.equal(
    isStampedForThisPage(run('https://jobs.example.com/roles/42'), 'https://jobs.example.com/roles/42'),
    true,
  );
});

test('a different posting does NOT keep the previous run', () => {
  // The reported bug, stated directly.
  assert.equal(
    isStampedForThisPage(run('https://jobs.example.com/roles/42'), 'https://jobs.example.com/roles/99'),
    false,
  );
});

test('the query string is part of job identity', () => {
  // Many boards encode which posting you are viewing entirely in the query
  // string, so ignoring it would make every posting on such a site look like
  // the same page -- which is the reported bug again, on one domain.
  assert.equal(isStampedForThisPage(run('https://indeed.com/viewjob?vjk=aaa'), 'https://indeed.com/viewjob?vjk=bbb'), false);
  assert.equal(isStampedForThisPage(run('https://indeed.com/viewjob?vjk=aaa'), 'https://indeed.com/viewjob?vjk=aaa'), true);
});

test('the hash fragment is not', () => {
  // In-page anchors and tab switches are never job identity, and treating
  // them as such would throw away a run for clicking "Benefits".
  assert.equal(
    isStampedForThisPage(run('https://jobs.example.com/roles/42'), 'https://jobs.example.com/roles/42#benefits'),
    true,
  );
  assert.equal(normalizePageUrl('https://x.test/a?b=1#frag'), 'https://x.test/a?b=1');
});

test('a run saved before runs carried a page is still restored', () => {
  // Failing open on purpose: an old run is not evidence of a different job,
  // and hiding it would lose someone their results on upgrade.
  assert.equal(isStampedForThisPage({ jobTitle: 'Old' }, 'https://jobs.example.com/roles/42'), true);
  assert.equal(isStampedForThisPage(run(''), 'https://jobs.example.com/roles/42'), true);
});

test('an unreadable page still restores the run', () => {
  // chrome:// pages, the extension's own pages, anything with no grant. None
  // of those is a job posting, so there is nothing newer to show and
  // withholding the run would be a pure loss.
  const r = run('https://jobs.example.com/roles/42');
  assert.equal(isStampedForThisPage(r, ''), true);
  assert.equal(isStampedForThisPage(r, null), true);
  assert.equal(isStampedForThisPage(r, undefined), true);
});

test('no run at all is not "for this page"', () => {
  assert.equal(isStampedForThisPage(null, 'https://jobs.example.com/roles/42'), true);
});

test('normalizePageUrl survives things that are not URLs', () => {
  // tab.url can be absent or odd; this must never throw on the way to a
  // decision about whether to show someone their work.
  assert.equal(normalizePageUrl('not a url'), 'not a url');
  assert.equal(normalizePageUrl(''), '');
  assert.equal(normalizePageUrl(null), '');
  assert.equal(normalizePageUrl(undefined), '');
});

test('the same posting on http and https is not the same page', () => {
  // Origin includes the scheme, and a downgrade is a different page by any
  // reasonable reading. Stated so the choice is deliberate rather than
  // incidental.
  assert.equal(isStampedForThisPage(run('https://jobs.example.com/x'), 'http://jobs.example.com/x'), false);
});
