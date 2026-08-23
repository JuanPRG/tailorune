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
