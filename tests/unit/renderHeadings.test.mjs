// renderHeadings.test.mjs — the summary heading and the cover-letter subject
// line, both of which were emitting output no one would write by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Packer } from 'docx';
import { buildResumeDocument } from '../../extension/engine/renderDocx.js';
import { extractDocxText } from '../../extension/engine/extractDocxText.js';
import { renderResumeHtml } from '../../extension/engine/renderHtml.js';
import { coverLetterSubject } from '../../extension/engine/coverLetter.js';
import { parseTxt } from '../../extension/engine/parseTxt.js';

const baseModel = (extra = {}) => ({
  name: 'Test Candidate',
  contact: 'test@example.com',
  summary: 'A short professional summary aimed at the target role.',
  summaryHeading: null,
  skills: null,
  sections: [],
  ...extra,
});

/**
 * Render to real .docx bytes and read them back.
 *
 * Inspecting the in-memory Document object would assert against the `docx`
 * library's internals rather than against the file a user actually opens;
 * round-tripping proves the heading survives packing.
 */
async function renderedLines(model) {
  const bytes = await Packer.toBuffer(buildResumeDocument(model));
  const text = await extractDocxText(bytes);
  return text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
}

test('the resume’s own summary heading is carried into the .docx', async () => {
  // Previously dropped outright, leaving the summary as an unlabelled
  // paragraph between the contact block and the first real heading — an
  // orphan that a heading-segmenting parser has nothing to attach to.
  const lines = await renderedLines(baseModel({ summaryHeading: 'PROFILE' }));
  assert.ok(lines.includes('PROFILE'), `PROFILE missing from ${JSON.stringify(lines)}`);
  assert.ok(
    lines.indexOf('PROFILE') < lines.findIndex((l) => l.startsWith('A short professional')),
    'the heading must come before the summary it labels',
  );
});

test('a summary with no heading in the source still gets a neutral one', async () => {
  assert.ok((await renderedLines(baseModel({ summaryHeading: null }))).includes('SUMMARY'));
});

test('OBJECTIVE and ABOUT ME survive as themselves rather than being normalised away', async () => {
  for (const heading of ['OBJECTIVE', 'ABOUT ME', 'CAREER SUMMARY']) {
    const lines = await renderedLines(baseModel({ summaryHeading: heading }));
    assert.ok(lines.includes(heading), `${heading} was not preserved`);
  }
});

test('the HTML preview labels the summary too, so both exits show the same document', () => {
  const html = renderResumeHtml(baseModel({ summaryHeading: 'PROFILE' }));
  assert.match(html, /<h2>PROFILE<\/h2>/);
});

test('end to end: a parsed resume keeps its heading all the way to the rendered document', async () => {
  const model = parseTxt([
    'Rae Osei',
    'rae@example.com',
    '',
    'PROFILE',
    'Operations lead with a decade in cold-chain logistics.',
    '',
    'EXPERIENCE',
    'Ops Lead  |  Maersk   2015 - 2024',
    '- Ran the reefer fleet.',
  ].join('\n'));

  assert.equal(model.summaryHeading, 'PROFILE');
  assert.ok((await renderedLines(model)).includes('PROFILE'));
});

// --- cover letter subject ---------------------------------------------------

test('coverLetterSubject uses the title and company when both are trustworthy', () => {
  assert.equal(
    coverLetterSubject({ title: 'Backend Engineer', company: 'Acme' }, { name: 'Rae Osei' }),
    'Re: Backend Engineer at Acme',
  );
});

test('coverLetterSubject falls back to the company when the title is page furniture', () => {
  // The real failure: "Re: Welcome, Juan at TP Canada" on a finished letter.
  assert.equal(
    coverLetterSubject({ title: 'Welcome, Juan', company: 'TP Canada' }, { name: 'Juan Rivera' }),
    'Re: Application to TP Canada',
  );
});

test('coverLetterSubject omits the line entirely when nothing is trustworthy', () => {
  // A letter with no subject line reads as a stylistic choice; a letter
  // addressed to a greeting reads as a machine that was not checked.
  assert.equal(coverLetterSubject({ title: 'Hello there', company: '' }, { name: 'Juan Rivera' }), '');
  assert.equal(coverLetterSubject({}, {}), '');
});
