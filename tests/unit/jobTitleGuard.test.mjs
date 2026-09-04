// jobTitleGuard.test.mjs — "Welcome, Juan" must not be able to live in the
// job title field, and a real title must not be mistaken for a greeting.
//
// Reported from a finished run: "Previous run — Welcome, Juan at The Mobile
// Shop". A signed-in Indeed page's greeting had become the job title.
//
// The extractor already refused to hand one over -- that rejection names this
// exact string in its comment. What it could not do was remove one ALREADY in
// the field: an automatic read only fills what is empty, so the bad title
// survived every later read, and once runs began carrying their job it was
// persisted and restored on every open. The check has to run on the way IN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanJobTitle, mergeExtractedJob } from '../../extension/engine/jobFields.js';
import { isPlausibleJobTitle } from '../../extension/engine/textUtils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const GREETINGS = [
  'Welcome, Juan',
  'Welcome back, Juan',
  'Hi Juan',
  'Hey there',
  'Hello again',
  'Dear Hiring Manager',
  'Good morning',
  'Sign in to continue',
  'Apply now',
];

// The false positives the first version of this rejection produced. Every one
// is a job somebody actually holds, and each was being silently discarded --
// a worse failure than the bug being fixed, because it is invisible.
const REAL_TITLES = [
  'Highway Maintenance Technician',
  'Higher Education Coordinator',
  'Hearing Aid Specialist',
  'Signal Engineer',
  'Head of Engineering',
  'Backend Engineer',
  'Senior Data Analyst',
  'Loganalyst',
];

test('a greeting is not a job title', () => {
  for (const greeting of GREETINGS) {
    assert.equal(cleanJobTitle(greeting), '', `"${greeting}" should have been rejected`);
  }
});

test('a real job title starting with a greeting-like prefix survives', () => {
  // "hi" matched the start of "Highway" before the alternation grew a word
  // boundary.
  for (const title of REAL_TITLES) {
    assert.equal(cleanJobTitle(title), title, `"${title}" is a real job and must be kept`);
  }
});

test('a greeting already in the field is dropped by an automatic read', () => {
  // THE REPORTED BUG. An automatic read never overwrites, so before this the
  // greeting was simply preserved, forever.
  const out = mergeExtractedJob(
    { jobDescription: 'a description', jobTitle: 'Welcome, Juan', employer: 'The Mobile Shop' },
    { text: 'a description', jobTitle: '', employer: 'The Mobile Shop', source: 'JSON-LD', confidence: 'high' },
    { overwrite: false },
  );
  assert.equal(out.jobTitle, '', 'the greeting must not survive the read');
  assert.equal(out.employer, 'The Mobile Shop', 'and nothing else should be disturbed');
});

test('a real title already in the field still survives an automatic read', () => {
  const out = mergeExtractedJob(
    { jobDescription: 'a description', jobTitle: 'Highway Maintenance Technician', employer: '' },
    { text: 'a description', jobTitle: '', employer: '', source: 'JSON-LD', confidence: 'high' },
    { overwrite: false },
  );
  assert.equal(out.jobTitle, 'Highway Maintenance Technician');
});

test('an explicit re-read cannot reinstate a greeting either', () => {
  const out = mergeExtractedJob(
    { jobDescription: '', jobTitle: '', employer: '' },
    { text: 'a description', jobTitle: 'Welcome, Juan', employer: '', source: 'page text', confidence: 'low' },
    { overwrite: true },
  );
  assert.equal(out.jobTitle, '');
});

test('the content script and textUtils use the SAME rejection', () => {
  // The content script is injected as a standalone file and cannot import, so
  // the pattern is duplicated on purpose. Duplicated patterns drift -- and a
  // drift here means the popup and the page disagree about what a job title
  // is, silently, in one direction only.
  const shared = readFileSync(path.join(ROOT, 'extension/engine/textUtils.js'), 'utf8')
    .split('\n').find((l) => l.includes('GREETING_RE ='));
  const injected = readFileSync(path.join(ROOT, 'extension/content/extractJob.js'), 'utf8')
    .split('\n').find((l) => l.includes('_TITLE_REJECT_RE ='));

  const body = (line) => line.slice(line.indexOf('/^'), line.lastIndexOf('/i'));
  assert.equal(body(injected), body(shared),
    'the injected copy has drifted from the shared one');
});

test('the shared check agrees with the guard on every case here', () => {
  for (const greeting of GREETINGS) assert.equal(isPlausibleJobTitle(greeting), false, greeting);
  for (const title of REAL_TITLES) assert.equal(isPlausibleJobTitle(title), true, title);
});
