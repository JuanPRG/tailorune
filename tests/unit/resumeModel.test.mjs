import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelWordCount, flattenEditableEntries, applyTailoredContent, compactToWordBudget } from '../../extension/engine/resumeModel.js';

function sampleModel(bulletsPerEntry = 3) {
  const bullet = 'Shipped a feature that measurably improved a real metric for real users.';
  return {
    name: 'José García',
    contact: 'Toronto, ON | jose@example.com',
    summary: 'A concise professional summary about José.',
    skills: { heading: 'SKILLS', lines: ['SQL, Python, JavaScript'] },
    sections: [
      {
        kind: 'experience',
        heading: 'EXPERIENCE',
        entries: [
          { title: 'Engineer A', meta: 'Jan 2023 - Present', bullets: Array(bulletsPerEntry).fill(bullet) },
          { title: 'Engineer B', meta: 'Jan 2021 - Dec 2022', bullets: Array(bulletsPerEntry).fill(bullet) },
        ],
      },
      { kind: 'education', heading: 'EDUCATION', lines: ['Diploma, Seneca Polytechnic'] },
    ],
  };
}

test('modelWordCount counts every text field, locked and editable alike', () => {
  const model = sampleModel(1);
  const count = modelWordCount(model);
  // sanity: must be > 0 and roughly in the right range, not exact-matching a magic number
  assert.ok(count > 20 && count < 100, `unexpected word count: ${count}`);
});

test('flattenEditableEntries assigns stable 0-based indices in document order', () => {
  const entries = flattenEditableEntries(sampleModel());
  assert.deepEqual(entries.map((e) => e.index), [0, 1]);
  assert.equal(entries[0].title, 'Engineer A');
  assert.equal(entries[1].title, 'Engineer B');
});

test('applyTailoredContent replaces summary and bullets by index, leaves locked fields untouched', () => {
  const model = sampleModel();
  const tailored = {
    summary: 'A rewritten summary targeting the job description.',
    entries: [
      { index: 0, bullets: ['Rewritten bullet for role A.'] },
      { index: 1, bullets: ['Rewritten bullet for role B.'] },
    ],
  };
  const next = applyTailoredContent(model, tailored);
  assert.equal(next.summary, tailored.summary);
  assert.deepEqual(next.sections[0].entries[0].bullets, ['Rewritten bullet for role A.']);
  assert.deepEqual(next.sections[0].entries[1].bullets, ['Rewritten bullet for role B.']);
  // locked fields: untouched
  assert.equal(next.name, model.name);
  assert.equal(next.contact, model.contact);
  assert.equal(next.sections[0].entries[0].title, 'Engineer A');
  assert.equal(next.sections[0].entries[0].meta, 'Jan 2023 - Present');
  assert.deepEqual(next.sections[1], model.sections[1]);
});

test('applyTailoredContent ignores keys it never reads -- an attempt to rewrite a title has no effect', () => {
  const model = sampleModel();
  const tailored = {
    summary: 'ok',
    name: 'Someone Else', // not a recognized key -- must be ignored, not merely disallowed
    entries: [{ index: 0, bullets: ['ok'], title: 'A Different Title' }],
  };
  const next = applyTailoredContent(model, tailored);
  assert.equal(next.name, 'José García');
  assert.equal(next.sections[0].entries[0].title, 'Engineer A');
});

test('applyTailoredContent does not overwrite bullets when the tailored entry has none', () => {
  const model = sampleModel();
  const tailored = { summary: 'ok', entries: [{ index: 0, bullets: [] }] };
  const next = applyTailoredContent(model, tailored);
  // empty bullets array means "no change" -- original bullets survive
  assert.deepEqual(next.sections[0].entries[0].bullets, model.sections[0].entries[0].bullets);
});

test('compactToWordBudget is a no-op when already under budget', () => {
  const model = sampleModel(1);
  const before = modelWordCount(model);
  const { model: after, wordCount, iterations } = compactToWordBudget(model, 10_000);
  assert.equal(iterations, 0);
  assert.equal(wordCount, before);
  assert.deepEqual(after, model);
});

test('compactToWordBudget drops bullets from the entry with the most bullets first, until under budget', () => {
  const model = sampleModel(6); // both entries start with 6 identical bullets each
  const budget = modelWordCount(model) - 20; // force at least one drop
  const { model: after, wordCount, iterations } = compactToWordBudget(model, budget);
  assert.ok(iterations > 0);
  assert.ok(wordCount <= budget);
  const totalBulletsAfter = after.sections[0].entries.reduce((s, e) => s + e.bullets.length, 0);
  assert.ok(totalBulletsAfter < 12, 'expected at least one bullet to be dropped');
});

test('compactToWordBudget gives up cleanly once every bullet is gone, rather than looping forever', () => {
  const model = sampleModel(1);
  const { iterations } = compactToWordBudget(model, 0, 50);
  assert.ok(iterations <= 50);
});
