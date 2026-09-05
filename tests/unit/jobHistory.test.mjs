// jobHistory.test.mjs — "you have tailored for this job before".
//
// The whole feature is a claim about identity, and the cost of the two
// mistakes is not symmetric. Telling someone they have already done a job
// they have not is the expensive one: they skip it. Failing to notice a
// repeat costs a duplicate document and nothing else. Every matching rule
// below is written to under-claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HISTORY, rememberTailoring, findPriorTailoring, describePriorTailoring,
} from '../../extension/engine/jobHistory.js';

const AT = new Date(2026, 8, 1).getTime();
const ACME = {
  pageUrl: 'https://ca.indeed.com/?vjk=abc123',
  employer: 'Acme Corp',
  jobTitle: 'Backend Engineer',
  at: AT,
};
const remember = (entries, e) => rememberTailoring(entries, e);

test('a run is remembered, and found again', () => {
  const history = remember([], ACME);
  assert.equal(history.length, 1);
  assert.ok(findPriorTailoring(history, ACME), 'the same job must be recognised');
});

test('a job never tailored is not claimed as one that was', () => {
  const history = remember([], ACME);
  assert.equal(findPriorTailoring(history, {
    pageUrl: 'https://boards.greenhouse.io/other/jobs/9',
    employer: 'Northwind Systems',
    jobTitle: 'Data Analyst',
  }), null);
  assert.equal(findPriorTailoring([], ACME), null, 'and an empty history claims nothing');
});

// --- what counts as the same job -----------------------------------------

test('the same posting reached by a different URL is still the same job', () => {
  // ca.indeed.com and www.indeed.com serve one posting; so do the desktop
  // and mobile hosts. The employer and title carry it when the URL cannot.
  const history = remember([], ACME);
  assert.ok(findPriorTailoring(history, {
    pageUrl: 'https://www.indeed.com/viewjob?jk=abc123&from=serp',
    employer: 'Acme Corp',
    jobTitle: 'Backend Engineer',
  }), 'employer and title together identify it');
});

test('the same URL is the same job even when the title was read differently', () => {
  const history = remember([], ACME);
  assert.ok(findPriorTailoring(history, {
    pageUrl: 'https://ca.indeed.com/?vjk=abc123',
    employer: '',
    jobTitle: '',
  }), 'a re-read that found no title must not make it a new job');
});

test('matching ignores case and stray whitespace', () => {
  const history = remember([], ACME);
  assert.ok(findPriorTailoring(history, {
    pageUrl: '', employer: '  acme   CORP ', jobTitle: 'backend engineer',
  }));
});

// --- the false positives that would cost someone a job -------------------

test('THE SAME EMPLOYER IS NOT THE SAME JOB', () => {
  // A big employer posts dozens of roles. Matching on employer alone would
  // tell someone they had applied to all of them.
  const history = remember([], ACME);
  assert.equal(findPriorTailoring(history, {
    pageUrl: 'https://ca.indeed.com/?vjk=zzz999',
    employer: 'Acme Corp',
    jobTitle: 'Frontend Engineer',
  }), null);
});

test('THE SAME TITLE IS NOT THE SAME JOB', () => {
  const history = remember([], ACME);
  assert.equal(findPriorTailoring(history, {
    pageUrl: 'https://ca.indeed.com/?vjk=zzz999',
    employer: 'Northwind Systems',
    jobTitle: 'Backend Engineer',
  }), null);
});

test('a half-known job is not matched on the half that is known', () => {
  const history = remember([], ACME);
  for (const partial of [
    { pageUrl: '', employer: 'Acme Corp', jobTitle: '' },
    { pageUrl: '', employer: '', jobTitle: 'Backend Engineer' },
    { pageUrl: '', employer: '', jobTitle: '' },
  ]) {
    assert.equal(findPriorTailoring(history, partial), null,
      `matched on too little: ${JSON.stringify(partial)}`);
  }
});

test('an entry stored with nothing identifying can never match', () => {
  const history = remember([], { pageUrl: '', employer: '', jobTitle: '', at: AT });
  assert.equal(findPriorTailoring(history, { pageUrl: '', employer: '', jobTitle: '' }), null);
});

// --- the list itself ------------------------------------------------------

test('tailoring the same job again updates it rather than stacking up', () => {
  let history = remember([], ACME);
  history = remember(history, { ...ACME, at: AT + 60000 });
  assert.equal(history.length, 1, 'one job, one entry');
  assert.equal(history[0].times, 2, 'but it remembers how often');
  assert.equal(history[0].at, AT + 60000, 'and when it last happened');
});

test('the newest job comes first', () => {
  let history = remember([], ACME);
  history = remember(history, {
    pageUrl: 'https://x.example/2', employer: 'Northwind', jobTitle: 'Data Analyst', at: AT + 1,
  });
  assert.equal(history[0].employer, 'Northwind');
});

test('the list is capped, dropping the oldest', () => {
  let history = [];
  for (let i = 0; i < MAX_HISTORY + 25; i++) {
    history = remember(history, {
      pageUrl: `https://x.example/${i}`, employer: `E${i}`, jobTitle: 'Role', at: AT + i,
    });
  }
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[0].employer, `E${MAX_HISTORY + 24}`, 'newest kept');
  assert.ok(!history.some((e) => e.employer === 'E0'), 'oldest dropped');
});

test('a corrupt or absent history is survivable, not fatal', () => {
  for (const junk of [null, undefined, 'nonsense', 42, {}]) {
    assert.deepEqual(findPriorTailoring(junk, ACME), null);
    assert.equal(remember(junk, ACME).length, 1);
  }
});

// --- what it says ---------------------------------------------------------

test('the notice names the job and when, and never overstates it', () => {
  const said = describePriorTailoring({ ...ACME, times: 1 }, '3 days ago.');
  assert.match(said, /tailored/i);
  assert.match(said, /Backend Engineer/);
  assert.match(said, /Acme Corp/);
  assert.match(said, /3 days ago/);
  // It knows a resume was made. It does not know one was ever sent.
  assert.doesNotMatch(said, /\bapplied\b/i);
});

test('a repeat says how many times', () => {
  assert.match(describePriorTailoring({ ...ACME, times: 3 }, 'an hour ago.'), /3 times/);
});

test('it still reads as a sentence when the job barely has a name', () => {
  const said = describePriorTailoring(
    { pageUrl: 'https://x.example/1', employer: '', jobTitle: '', times: 1 }, '2 days ago.',
  );
  assert.match(said, /tailored/i);
  assert.doesNotMatch(said, /\bat\s*$|\bfor\s*$|\s{2,}/, `dangling wording: ${said}`);
});
