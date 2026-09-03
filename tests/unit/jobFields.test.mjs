// jobFields.test.mjs — the read must never eat what the user typed.
//
// This logic used to live inside popup.entry.js, where nothing could reach
// it. activeTab is granted by a user invoking the extension from the toolbar,
// and a test can only open the real popup programmatically, so an end-to-end
// automatic read always fails in the harness whatever page is in front. The
// first version of that e2e test asserted "a non-posting page fills nothing"
// and would have passed on a posting too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeExtractedJob, describeExtraction } from '../../extension/engine/jobFields.js';

const JOB = {
  text: 'We need a backend engineer.',
  jobTitle: 'Senior Backend Engineer',
  employer: 'Northwind Systems',
  source: 'JSON-LD',
  confidence: 'high',
};
const EMPTY = { jobDescription: '', jobTitle: '', employer: '' };

test('an automatic read fills an empty form', () => {
  const out = mergeExtractedJob(EMPTY, JOB, { overwrite: false });
  assert.equal(out.jobDescription, JOB.text);
  assert.equal(out.jobTitle, JOB.jobTitle);
  assert.equal(out.employer, JOB.employer);
});

test('an automatic read NEVER replaces what is already there', () => {
  // The worst thing this feature could do: type a description, lose popup
  // focus, come back and find the page's words in place of your own.
  const mine = {
    jobDescription: 'MY OWN PASTED DESCRIPTION',
    jobTitle: 'My Title',
    employer: 'My Employer',
  };
  assert.deepEqual(
    mergeExtractedJob(mine, JOB, { overwrite: false }),
    { ...mine, note: describeExtraction(JOB) },
  );
});

test('an automatic read fills each field independently', () => {
  // A half-filled form is the normal case: the description read cleanly and
  // the user had already typed the title.
  const out = mergeExtractedJob(
    { jobDescription: '', jobTitle: 'Typed By Hand', employer: '' },
    JOB, { overwrite: false },
  );
  assert.equal(out.jobDescription, JOB.text, 'the empty field takes the page value');
  assert.equal(out.jobTitle, 'Typed By Hand', 'the filled field is left alone');
  assert.equal(out.employer, JOB.employer);
});

test('whitespace does not count as content worth protecting', () => {
  const out = mergeExtractedJob(
    { jobDescription: '   \n  ', jobTitle: ' ', employer: '' },
    JOB, { overwrite: false },
  );
  assert.equal(out.jobDescription, JOB.text);
  assert.equal(out.jobTitle, JOB.jobTitle);
});

test('the button overwrites, because it means "re-read THIS page"', () => {
  const stale = {
    jobDescription: 'A DIFFERENT JOB',
    jobTitle: 'Stale Title',
    employer: 'Stale Employer',
  };
  const out = mergeExtractedJob(stale, JOB, { overwrite: true });
  assert.equal(out.jobDescription, JOB.text);
  assert.equal(out.jobTitle, JOB.jobTitle);
  assert.equal(out.employer, JOB.employer);
});

test('an explicit re-read BLANKS a title the extractor rejected', () => {
  // The extractor deliberately returns no title for a signed-in greeting or
  // a nav label. Keeping the previous value would leave a rejected title in
  // the field and let it reach the cover letter -- a claim about the job that
  // nothing on the page supports.
  const out = mergeExtractedJob(
    { jobDescription: '', jobTitle: 'Welcome back, Juan', employer: '' },
    { ...JOB, jobTitle: '' }, { overwrite: true },
  );
  assert.equal(out.jobTitle, '', 'a rejected title must not survive an explicit re-read');
});

test('an automatic read does not blank a title, even a rejected one', () => {
  // The asymmetry is the point: nobody asked for this read, and silence is
  // not permission to delete.
  const out = mergeExtractedJob(
    { jobDescription: '', jobTitle: 'Typed By Hand', employer: '' },
    { ...JOB, jobTitle: '' }, { overwrite: false },
  );
  assert.equal(out.jobTitle, 'Typed By Hand');
});

test('a read that found no text describes nothing', () => {
  // Silence is what makes automatic detection tolerable on an ordinary page.
  assert.equal(describeExtraction(null), '');
  assert.equal(describeExtraction({ text: '' }), '');
  assert.equal(describeExtraction({ text: '   ' }), '');
});

test('low confidence is stated, not hidden', () => {
  // The body-text fallback always returns SOMETHING, so a quiet success there
  // would be an invitation to tailor against a page's navigation.
  const note = describeExtraction({ ...JOB, confidence: 'low', source: 'page text' });
  assert.match(note, /low confidence/);
  assert.match(note, /check the fields/);
});

test('a missing title is called out, since the cover letter uses it', () => {
  assert.match(describeExtraction({ ...JOB, jobTitle: '' }), /No usable job title/);
  assert.doesNotMatch(describeExtraction(JOB), /No usable job title/);
});
