// parseTxtLayouts.test.mjs — the parser against resume layouts it was NOT
// designed around.
//
// Why this file exists: every other fixture in this repo is one person's
// resume. A heuristic parser tuned and tested against a single layout will
// happily encode that layout's quirks as if they were rules — and it did. An
// earlier "a non-bullet line after a title is a subtitle" rule assumed at most
// ONE context line and treated a bare date line as a new entry, because that
// is the shape the one real fixture had. On an employer/title/date stack it
// produced two entries, buried the real job title in meta, and handed both
// bullets to a phantom entry titled with a date.
//
// These fixtures are deliberately six different people with six different
// layouts. Their job is to fail when a fix is shaped around one resume rather
// than around resumes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layout = (name) => parseTxt(
  readFileSync(path.join(__dirname, '../fixtures/resumes/layouts', name), 'utf8'),
);
const experienceOf = (model) => model.sections.find((s) => s.kind === 'experience');

test('layout A: a date range to the LEFT of the title is split out, same as one on the right', () => {
  const model = layout('a-dates-left.txt');
  const experience = experienceOf(model);

  assert.equal(experience.entries.length, 2);
  assert.equal(experience.entries[0].title, 'Senior Engineer, Shopify');
  assert.equal(experience.entries[0].meta, '2019 - Present');
  assert.equal(experience.entries[0].bullets.length, 2);
  assert.equal(experience.entries[1].title, 'Engineer, Wealthsimple');
  assert.equal(experience.entries[1].meta, '2016 - 2019');
});

test('layout B: an employer / title / date stack is ONE role, not two', () => {
  // The regression this whole file exists for. Common in consulting and
  // finance resumes, absent from the one fixture the rule was written against.
  const model = layout('b-employer-title-date-stack.txt');
  const experience = experienceOf(model);

  assert.equal(experience.entries.length, 1,
    `expected 1 role, got ${experience.entries.length}: ${JSON.stringify(experience.entries.map((e) => e.title))}`);
  const [role] = experience.entries;
  assert.equal(role.bullets.length, 2, 'both bullets must stay with the role');
  // Every line of the block survives somewhere; nothing is silently dropped.
  assert.match(role.meta, /Senior Consultant, Risk Advisory/);
  assert.match(role.meta, /Jan 2020 - Present/);
});

test('layout C: unicode bullets, an OBJECTIVE heading, and Month-Year dates all parse', () => {
  const model = layout('c-objective-heading-unicode-bullets.txt');
  const experience = experienceOf(model);

  assert.equal(model.summary, 'Registered nurse seeking an ICU role.');
  assert.equal(model.summaryHeading, 'OBJECTIVE', 'the resume’s own heading must be retained');
  assert.equal(experience.entries.length, 1);
  assert.equal(experience.entries[0].bullets.length, 2, '• bullets were not recognised');
  assert.match(experience.entries[0].meta, /March 2021 - Present/);
  assert.match(experience.entries[0].meta, /Toronto, ON/);
});

test('layout D: leading prose with no heading is still picked up as the summary', () => {
  const model = layout('d-no-summary-heading.txt');
  assert.match(model.summary, /logistics coordinator/);
  assert.equal(model.summaryHeading, null, 'there was no heading to retain');
  assert.equal(experienceOf(model).entries.length, 1);
});

test('layout E: a role with no bullets stays its own role instead of being absorbed', () => {
  const model = layout('e-bulletless-role.txt');
  const experience = experienceOf(model);

  assert.deepEqual(
    experience.entries.map((e) => e.title),
    ['Head of Design  |  Figma', 'Design Lead  |  Notion', 'Staff Designer  |  Stripe'],
  );
  assert.equal(experience.entries[1].bullets.length, 0);
  assert.equal(experience.entries[2].bullets.length, 1);
});

test('layout E: an all-caps CONTENT line is not mistaken for a section heading', () => {
  // "BFA, OCAD" is a shouted credential, not a section. The generic-header
  // fallback caught it until it was required to be punctuation-free and
  // forbidden from being a section's first line.
  const model = layout('e-bulletless-role.txt');
  const education = model.sections.find((s) => s.kind === 'education');
  assert.deepEqual(education.lines, ['BFA, OCAD']);
});

test('layout F: an unrecognised heading becomes its own section instead of merging', () => {
  const model = layout('f-unknown-section-header.txt');

  const other = model.sections.find((s) => s.kind === 'other');
  assert.ok(other, 'CERTIFICATIONS was not detected as a section of its own');
  assert.equal(other.heading, 'CERTIFICATIONS');
  assert.equal(other.lines.length, 2);

  // It must not have contaminated the sections either side of it.
  assert.equal(experienceOf(model).entries.length, 1);
  assert.equal(experienceOf(model).entries[0].bullets.length, 1);
  assert.deepEqual(model.sections.find((s) => s.kind === 'education').lines, ["BEng, Queen's University"]);
});

test('unrecognised sections are verbatim lines, never rewritable entries', () => {
  // Certifications, awards and licences are facts with issuing bodies and
  // dates. Parsing them as entries would expose their bullets to the
  // rewriter; keeping them as lines makes them structurally locked.
  const model = layout('f-unknown-section-header.txt');
  const other = model.sections.find((s) => s.kind === 'other');
  assert.equal(other.entries, undefined);
  assert.ok(Array.isArray(other.lines));
});

test('a section whose body is empty is dropped rather than rendered as a bare heading', () => {
  const model = parseTxt([
    'Sam Idris',
    'sam@example.com',
    '',
    'EXPERIENCE',
    '',
    'EDUCATION',
    'BA History, UBC',
  ].join('\n'));

  assert.deepEqual(model.sections.map((s) => s.kind), ['education']);
});
