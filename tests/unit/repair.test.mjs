// repair.test.mjs — v4's repair-first anti-fabrication pass (tailor.py:198-262).
//
// The distinguishing idea, and the reason this is not folded into
// validateTailoredModel: the correct response to one overreaching bullet is a
// targeted revert, not a verdict on the whole model. A bullet that claimed
// Kubernetes costs that bullet; the other five survive, and the run does not
// burn a retry on one bad line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repairTailoredModel, buildTailorMessages, MAX_BULLET_LENGTH_RATIO,
} from '../../extension/engine/tailor.js';

const modelWith = (bullets, skillsLines = ['Tools: Excel, NetSuite, QuickBooks']) => ({
  name: 'Test Candidate',
  contact: 'test@example.com',
  summary: 'A summary long enough to clear the validator minimum word count without any trouble at all.',
  summaryHeading: null,
  skills: skillsLines ? { heading: 'SKILLS', lines: skillsLines } : null,
  sections: [{
    kind: 'experience',
    heading: 'EXPERIENCE',
    entries: [{ title: 'Analyst  |  Acme', meta: '2020 - 2024', bullets }],
  }],
});

const bulletsOf = (model) => model.sections[0].entries[0].bullets;

// --- fabrication: watchlisted tools the candidate never claimed -------------

test('a bullet that introduces a watchlisted tool absent from skills and the JD is reverted', () => {
  const original = modelWith(['Reconciled accounts payable in NetSuite each month.']);
  const tailored = modelWith(['Reconciled accounts payable in NetSuite and orchestrated deployments with Kubernetes.']);

  const { model, repairs, warnings } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.equal(bulletsOf(model)[0], 'Reconciled accounts payable in NetSuite each month.');
  assert.equal(repairs.length, 1);
  assert.match(warnings[0], /kubernetes/i);
});

test('the same tool is allowed when the JOB DESCRIPTION asks for it', () => {
  // v4's rule: introduced terms are only fabrication when they appear in
  // neither the job description nor the candidate's declared skills.
  const original = modelWith(['Reconciled accounts payable in NetSuite each month.']);
  const tailored = modelWith(['Reconciled payables in NetSuite alongside Kubernetes-based reporting jobs.']);

  const { repairs } = repairTailoredModel(original, tailored, 'We use Kubernetes heavily on this team.');
  assert.deepEqual(repairs, []);
});

test('the same tool is allowed when the candidate genuinely lists it', () => {
  const original = modelWith(['Ran the reporting jobs.'], ['Tools: Kubernetes, Terraform']);
  const tailored = modelWith(['Ran the reporting jobs on Kubernetes.'], ['Tools: Kubernetes, Terraform']);

  const { repairs } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.deepEqual(repairs, []);
});

test('a multi-word watchlist phrase is caught, which v4 token matching misses', () => {
  // FABRICATION_WATCHLIST_TERMS holds entries like "six sigma" and "aws
  // certified". Neither survives tokenization, so both are matched as
  // phrases here.
  const original = modelWith(['Improved the month-end close process.']);
  const tailored = modelWith(['Improved the month-end close process using Six Sigma methods.']);

  const { repairs, warnings } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.equal(repairs.length, 1);
  assert.match(warnings[0], /six sigma/i);
});

test('only the offending bullet reverts; its neighbours keep their rewrite', () => {
  // The whole point of repair-first over batch pass/fail.
  const original = modelWith([
    'Reconciled accounts payable in NetSuite.',
    'Closed the books each month.',
  ]);
  const tailored = modelWith([
    'Reconciled payables in NetSuite while running Kubernetes clusters.',
    'Owned the month-end close, reporting to the controller.',
  ]);

  const { model, repairs } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.equal(repairs.length, 1);
  assert.equal(bulletsOf(model)[0], 'Reconciled accounts payable in NetSuite.', 'the bad bullet should revert');
  assert.equal(bulletsOf(model)[1], 'Owned the month-end close, reporting to the controller.', 'the good bullet should survive');
});

// --- length: a bullet that became a paragraph ------------------------------

test('a bullet grown past the length ratio is reverted', () => {
  const original = modelWith(['Closed the books each month.']);
  const long = `${'Closed the books each month while coordinating with every stakeholder '.repeat(4)}across the business.`;
  const tailored = modelWith([long]);

  const { model, repairs, warnings } = repairTailoredModel(original, tailored, 'A role.');
  assert.equal(repairs.length, 1);
  assert.equal(bulletsOf(model)[0], 'Closed the books each month.');
  assert.match(warnings[0], /too long/i);
});

test('a bullet just under the ratio is left alone', () => {
  const original = modelWith(['Closed the books each month for three entities.']); // 8 words
  const words = 8;
  const allowed = Math.floor(words * MAX_BULLET_LENGTH_RATIO) - 1;
  const tailored = modelWith([Array.from({ length: allowed }, () => 'word').join(' ')]);

  assert.deepEqual(repairTailoredModel(original, tailored, 'A role.').repairs, []);
});

// --- structural safety ------------------------------------------------------

test('when the model returns a different bullet count, the whole role reverts', () => {
  // There is no "the original of this bullet" to revert to when the counts
  // differ, and reverting one of a re-split pair would pair a repaired bullet
  // with an unrepaired neighbour that shared its claim.
  const original = modelWith(['Reconciled payables in NetSuite.', 'Closed the books monthly.']);
  const tailored = modelWith(['Reconciled payables in NetSuite while running Kubernetes clusters and closing the books.']);

  const { model, repairs } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.equal(repairs.length, 1);
  assert.deepEqual(bulletsOf(model), ['Reconciled payables in NetSuite.', 'Closed the books monthly.']);
});

test('a clean rewrite is returned untouched, with no repairs recorded', () => {
  const original = modelWith(['Reconciled accounts payable in NetSuite for 3 entities.']);
  const tailored = modelWith(['Owned payables reconciliation in NetSuite across 3 entities.']);

  const { model, repairs, warnings } = repairTailoredModel(original, tailored, 'A finance role.');
  assert.deepEqual(repairs, []);
  assert.deepEqual(warnings, []);
  assert.equal(model, tailored, 'an untouched model should be returned as-is, not rebuilt');
});

test('repairing never disturbs locked fields', () => {
  const original = modelWith(['Reconciled payables in NetSuite.']);
  const tailored = modelWith(['Reconciled payables while running Kubernetes clusters.']);

  const { model } = repairTailoredModel(original, tailored, 'A finance role.');
  const entry = model.sections[0].entries[0];
  assert.equal(entry.title, 'Analyst  |  Acme');
  assert.equal(entry.meta, '2020 - 2024');
  assert.equal(model.name, 'Test Candidate');
});

// --- the prompt half of the same guard --------------------------------------

test('the prompt names the candidate skills as an explicit allow-list', () => {
  // v4 tailor.py:123-125. Without it, the only thing between a JD that
  // mentions Kubernetes and a resume claiming it is the model's restraint.
  const system = buildTailorMessages(modelWith(['A bullet.']), 'A JD.', undefined, [])[0].content;
  assert.match(system, /verified skills and tools are/i);
  assert.match(system, /netsuite/i);
  assert.match(system, /Do not introduce a skill, tool, certification or technology/i);
});

test('the prompt forbids inventing numbers and team sizes, not just credentials', () => {
  const system = buildTailorMessages(modelWith(['A bullet.']), 'A JD.', undefined, [])[0].content;
  assert.match(system, /Do not invent numbers, metrics, team sizes/i);
});

test('a resume with no skills section still gets a boundary instruction', () => {
  const system = buildTailorMessages(modelWith(['A bullet.'], null), 'A JD.', undefined, [])[0].content;
  assert.match(system, /no skills section/i);
});
