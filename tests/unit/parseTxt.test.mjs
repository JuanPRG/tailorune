import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');

test('juan-rivera-full: name, contact, summary, skills, projects, experience, education all recognized', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  assert.equal(model.name, 'Juan Rivera');
  assert.match(model.contact, /Toronto, ON/);
  assert.match(model.contact, /j.rivera@example\.com/);
  assert.ok(model.summary && model.summary.includes('backend development'));

  assert.ok(model.skills);
  assert.equal(model.skills.heading, 'TECHNICAL SKILLS');
  assert.equal(model.skills.lines.length, 2);

  const kinds = model.sections.map((s) => s.kind);
  assert.deepEqual(kinds, ['projects', 'experience', 'education']);
});

test('juan-rivera-full: project entry with no date at all (real edge case) keeps meta null', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const projects = model.sections.find((s) => s.kind === 'projects');
  assert.equal(projects.entries.length, 1);
  const entry = projects.entries[0];
  assert.match(entry.title, /AI-Powered Job Automation Engine/);
  assert.equal(entry.meta, null);
  assert.equal(entry.bullets.length, 2);
});

test('juan-rivera-full: title+date on the same line (2+ space gap) splits correctly', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const exp = model.sections.find((s) => s.kind === 'experience');
  const entry = exp.entries[0];
  assert.match(entry.title, /^Co-Op Support Services Officer \(SLG Leader\) \| Seneca Polytechnic \| Toronto, ON$/);
  assert.equal(entry.meta, 'May 2025 - Jan 2026');
  assert.equal(entry.bullets.length, 2);
});

test('juan-rivera-full: education is kept as locked raw lines, not parsed into entries', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const edu = model.sections.find((s) => s.kind === 'education');
  assert.ok(Array.isArray(edu.lines));
  assert.equal(edu.entries, undefined);
  assert.equal(edu.lines.length, 2);
});

test('jordan-lee-standard: title and date on separate lines are joined into one entry', () => {
  const model = parseTxt(fixture('jordan-lee-standard.txt'));
  const exp = model.sections.find((s) => s.kind === 'experience');
  assert.equal(exp.entries.length, 1);
  const entry = exp.entries[0];
  assert.match(entry.title, /^Product Analyst \| Northwind Analytics \| Vancouver, BC$/);
  assert.equal(entry.meta, 'Mar 2021 - Present');
  assert.equal(entry.bullets.length, 1);
});

test('jordan-lee-standard: no SUMMARY header present -> summary stays null, not fabricated', () => {
  const model = parseTxt(fixture('jordan-lee-standard.txt'));
  assert.equal(model.summary, null);
});

test('jordan-lee-standard: a bare linkedin URL on its own line is recognized as contact, not prose', () => {
  const model = parseTxt(fixture('jordan-lee-standard.txt'));
  assert.match(model.contact, /linkedin\.com\/in\/jordanlee/);
});

test('taylor-reed-sparse: no section headers at all -> implicit summary paragraph, zero sections', () => {
  const model = parseTxt(fixture('taylor-reed-sparse.txt'));
  assert.equal(model.name, 'Taylor Reed');
  assert.match(model.contact, /taylor\.reed@example\.com/);
  assert.ok(model.summary && model.summary.includes('Software person'));
  assert.equal(model.sections.length, 0);
  assert.equal(model.skills, null);
});
