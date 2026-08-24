import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractDocxText } from '../../extension/engine/extractDocxText.js';
import { parseTxt } from '../../extension/engine/parseTxt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = (name) => path.join(__dirname, '../fixtures/resumes', name);

test('extractDocxText pulls readable paragraph text out of a real .docx resume', async () => {
  const bytes = readFileSync(fixturePath('juan-rivera.docx'));
  const text = await extractDocxText(bytes);
  assert.ok(text.length > 100, `expected substantial text, got ${text.length} chars`);
  assert.match(text, /Juan Rivera/);
  // paragraph breaks must be preserved, not flattened into one line
  assert.ok(text.includes('\n'), 'expected multiple paragraphs, got one flattened line');
});

test('extractDocxText throws a clear error on a non-docx buffer instead of a cryptic zip error', async () => {
  await assert.rejects(extractDocxText(Buffer.from('not a zip file at all')));
});

test('extracted .docx text feeds parseTxt() and produces a sane model, same as the .txt fixture would', async () => {
  const bytes = readFileSync(fixturePath('juan-rivera.docx'));
  const text = await extractDocxText(bytes);
  const model = parseTxt(text);
  assert.equal(model.name, 'Juan Rivera');
  assert.ok(model.contact.length > 0);
  assert.ok(model.sections.length > 0 || model.summary, 'parseTxt recognized nothing at all in the extracted text');
});

test('Word\'s native bulleted lists (no literal bullet character in the text, list glyph comes from <w:numPr>) are recovered as real bullets, not swallowed as bogus entries', async () => {
  // Regression test: this real resume's bullets were originally lost
  // entirely -- each bullet line was misread as a new, title-only entry
  // with zero bullets, because Word's list formatting carries no literal
  // "-"/"*"/"•" character in the run text at all.
  const bytes = readFileSync(fixturePath('juan-rivera.docx'));
  const text = await extractDocxText(bytes);
  const model = parseTxt(text);

  const experience = model.sections.find((s) => s.kind === 'experience');
  assert.equal(experience.entries.length, 2, `expected 2 real jobs, got ${experience.entries.length} (bullets likely swallowed as entries)`);
  for (const entry of experience.entries) {
    assert.ok(entry.bullets.length >= 2, `entry "${entry.title}" has only ${entry.bullets.length} bullets`);
  }

  const projects = model.sections.find((s) => s.kind === 'projects');
  assert.equal(projects.entries.length, 3, `expected 3 real projects, got ${projects.entries.length}`);
  for (const entry of projects.entries) {
    assert.ok(entry.bullets.length >= 2, `entry "${entry.title}" has only ${entry.bullets.length} bullets`);
  }
});

// --- Regression: the three defects found in a real tailored resume ---------
//
// All three came from ONE run against the user's actual general resume, which
// uses right-aligned tab stops for its dates and a location/context line under
// each job title. The pre-existing juan-rivera.docx fixture uses neither
// shape, which is precisely why every test above passed while the shipped
// document was broken. juan-rivera-tabstops.docx is that real file.

test('no raw OOXML markup survives into the extracted text', async () => {
  // Defect 1: `<w:t[^>]*>` also matched <w:tab>, <w:tabs>, <w:tblPr> and
  // <w:tc>, then swallowed everything up to the next real </w:t> as if it
  // were body text -- so raw XML was printed into the finished resume.
  const bytes = readFileSync(fixturePath('juan-rivera-tabstops.docx'));
  const text = await extractDocxText(bytes);
  const leaks = text.match(/<[^>]*>/g) || [];
  assert.deepEqual(leaks, [], `markup leaked into extracted text: ${leaks.slice(0, 5).join(' ')}`);
});

test('a tab stop between a job title and its date becomes whitespace, so the date still parses into its own field', async () => {
  // Defect 2: <w:tab/> was dropped outright, gluing the two together as
  // "...Yesos Colombia S.A.S.2018 - Present". parseTxt splits on two-or-more
  // spaces, so the date then had nowhere to go and stayed inside the title.
  const bytes = readFileSync(fixturePath('juan-rivera-tabstops.docx'));
  const model = parseTxt(await extractDocxText(bytes));
  const experience = model.sections.find((s) => s.kind === 'experience');

  for (const entry of experience.entries) {
    assert.ok(entry.meta, `entry "${entry.title}" lost its date range entirely`);
    assert.doesNotMatch(entry.title, /\d{4}\s*[-–—]/, `date stayed glued inside the title: "${entry.title}"`);
  }
  assert.ok(experience.entries.some((e) => e.meta.includes('2018 – Present')),
    `expected an open-ended date range, got ${JSON.stringify(experience.entries.map((e) => e.meta))}`);
});

test('a location/context line under a job title is kept as that job\'s subtitle, not read as a separate job', async () => {
  // Defect 3: those lines started new entries, which doubled the role count
  // (8 instead of 4) and handed every bullet to the phantom entry -- so each
  // real job rendered as a bare title with nothing under it.
  const bytes = readFileSync(fixturePath('juan-rivera-tabstops.docx'));
  const model = parseTxt(await extractDocxText(bytes));
  const experience = model.sections.find((s) => s.kind === 'experience');

  assert.equal(experience.entries.length, 4,
    `expected 4 real jobs, got ${experience.entries.length}: ${JSON.stringify(experience.entries.map((e) => e.title))}`);
  for (const entry of experience.entries) {
    assert.ok(entry.bullets.length >= 1, `job "${entry.title}" ended up with no bullets`);
  }
  const advisor = experience.entries[0];
  assert.match(advisor.title, /Retained Financial Advisor/);
  assert.match(advisor.meta, /Long-term outsourced engagement/, 'the context line was dropped instead of retained as meta');
});
