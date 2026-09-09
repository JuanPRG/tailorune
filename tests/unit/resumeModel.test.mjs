import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelWordCount, flattenEditableEntries, applyTailoredContent, compactToWordBudget, compactUntil,
} from '../../extension/engine/resumeModel.js';

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

/** Like sampleModel(), but with a chosen number of bullets per entry. */
function modelWithBullets(counts) {
  const bullet = 'Shipped a feature that measurably improved a real metric for real users.';
  return {
    name: 'José García',
    contact: 'Toronto, ON | jose@example.com',
    summary: 'A concise professional summary about José.',
    skills: { heading: 'SKILLS', lines: ['SQL, Python, JavaScript'] },
    sections: [{
      kind: 'experience',
      heading: 'EXPERIENCE',
      entries: counts.map((n, i) => ({
        title: `Engineer ${i + 1}`, meta: 'Jan 2023 - Present', bullets: Array(n).fill(bullet),
      })),
    }],
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

// --- the two-page bug ------------------------------------------------------
//
// REPORTED on a real resume, and reproduced exactly: seventeen bullets across
// six entries, tailored to 494 words. The word budget is 510, so
// compactToWordBudget ran ZERO iterations and the document shipped -- at two
// pages. The 421-word original rendered to one.
//
// Nothing about the count was wrong. The unit was: pages are made of LINES,
// every bullet ends mid-line, and every entry costs a title row, none of which
// a word count can see. The user tried all three density settings and
// correctly reported that nothing changed, because the constraint that was
// failing was never the one being enforced.
//
// compactUntil() takes the measurement from the caller so the real check can
// be "does the rendered document paginate". These tests use a cheap stand-in
// for that predicate; tests/e2e/render-parity.test.mjs measures real pages.

test('compactUntil keeps dropping while the measurement says it does not fit, even under any word budget', async () => {
  const model = modelWithBullets([4, 3, 2]);
  const wordsBefore = modelWordCount(model);

  // A predicate that ignores words entirely, exactly as a page measurement
  // does: it only accepts a model with six bullets or fewer.
  const bulletCount = (m) => m.sections.flatMap((s) => s.entries || []).reduce((n, e) => n + e.bullets.length, 0);
  const { model: after, iterations } = await compactUntil(model, (m) => bulletCount(m) <= 6);

  assert.equal(bulletCount(model), 9, 'precondition');
  assert.equal(bulletCount(after), 6);
  assert.equal(iterations, 3);
  assert.ok(modelWordCount(after) < wordsBefore, 'and it really did shorten the model');
});

test('compactUntil does nothing when the measurement already says it fits', async () => {
  const model = modelWithBullets([4, 3, 2]);
  const { model: after, iterations } = await compactUntil(model, () => true);
  assert.equal(iterations, 0);
  assert.deepEqual(after, model);
});

test('compactUntil gives up rather than looping forever when nothing can satisfy the measurement', async () => {
  const model = modelWithBullets([2, 1]);
  const { iterations } = await compactUntil(model, () => false, 50);
  // Three bullets exist, so there are three things to drop and then no more.
  assert.equal(iterations, 3);
});

test('compactUntil awaits an async measurement, since rendering a page is async', async () => {
  const model = modelWithBullets([3]);
  let calls = 0;
  const { iterations } = await compactUntil(model, async (m) => {
    calls += 1;
    await Promise.resolve();
    return m.sections[0].entries[0].bullets.length <= 1;
  });
  assert.equal(iterations, 2);
  assert.ok(calls >= 3, 'the predicate is consulted before and after each drop');
});
