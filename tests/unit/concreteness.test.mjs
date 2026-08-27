// concreteness.test.mjs — the guard against a rewrite that keeps every fact
// and still ruins the resume.
//
// Asked to make bullets sound stronger, models reliably trade specific nouns
// for abstract process verbs. Nothing is fabricated, so every other check
// passes — but screening is keyword-driven first, and the searchable terms
// are gone. This is measured rather than requested, because instructions
// alone do not hold across models or prompts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptTokens, conceptRetentionRatio, droppedNumbers, isPlausibleJobTitle } from '../../extension/engine/textUtils.js';
import { validateTailoredModel, buildTailorMessages, MIN_BULLET_CONCEPT_RETENTION } from '../../extension/engine/tailor.js';

const modelWith = (bullets) => ({
  name: 'Test Candidate',
  contact: 'test@example.com',
  summary: 'A summary long enough to clear the minimum word count for the validator to be happy with it.',
  skills: null,
  sections: [{
    kind: 'experience',
    heading: 'EXPERIENCE',
    entries: [{ title: 'Analyst  |  Acme', meta: '2020 - 2024', bullets }],
  }],
});

test('conceptTokens ignores filler so that padding cannot masquerade as retained meaning', () => {
  const tokens = conceptTokens('Managed comprehensive strategic initiatives using robust processes');
  // Every word above is generic resume filler; none of it is matchable.
  assert.deepEqual([...tokens].sort(), ['initiatives', 'processes']);
});

test('conceptTokens keeps tools, standards and domain terms', () => {
  const tokens = conceptTokens('Reconciled accounts payable in NetSuite under IFRS');
  for (const term of ['reconciled', 'accounts', 'payable', 'netsuite', 'ifrs']) {
    assert.ok(tokens.has(term), `expected "${term}" to count as concrete`);
  }
});

test('conceptRetentionRatio treats an empty original as fully retained', () => {
  assert.equal(conceptRetentionRatio('', 'anything at all'), 1);
});

test('droppedNumbers catches a quantity that vanished, in any of its forms', () => {
  assert.deepEqual(droppedNumbers('Led a team of 15+ across 3 sites', 'Led cross-functional teams'), ['15+', '3']);
  assert.deepEqual(droppedNumbers('Cut latency by 40%', 'Cut checkout latency by 40%'), []);
  // Commas and spacing must not make the same number look different.
  assert.deepEqual(droppedNumbers('Processed 1,200 invoices', 'Processed 1200 invoices'), []);
});

test('a hollowed-out rewrite is rejected, with the lost terms named so the retry can restore them', () => {
  const original = modelWith([
    'Handled day-to-day bookkeeping, financial reporting, and budget tracking for a manufacturing firm.',
  ]);
  const hollow = modelWith([
    'Executed comprehensive financial administration, optimizing operational efficiency for stakeholders.',
  ]);

  const result = validateTailoredModel(original, hollow);
  assert.equal(result.passed, false);
  const retention = result.errors.find((e) => /specific vocabulary/.test(e));
  assert.ok(retention, `expected a retention error, got ${JSON.stringify(result.errors)}`);
  // The feedback must be actionable: the terms come from the original bullets,
  // which the model is already shown, so naming them leaks nothing locked.
  assert.match(retention, /bookkeeping/);
});

test('a legitimately aggressive rewrite that keeps the concrete words PASSES', () => {
  // The guard must not make ordinary tailoring impossible. This rewrite
  // changes framing, ordering and emphasis, and adds a JD keyword — but
  // carries every specific term across.
  const original = modelWith([
    'Reconciled accounts payable in NetSuite and closed month-end books for 3 entities.',
  ]);
  const rewritten = modelWith([
    'Owned month-end close for 3 entities, reconciling accounts payable in NetSuite to a strict reporting deadline.',
  ]);

  const result = validateTailoredModel(original, rewritten);
  assert.deepEqual(result.errors, []);
  assert.ok(
    conceptRetentionRatio(original.sections[0].entries[0].bullets[0], rewritten.sections[0].entries[0].bullets[0])
      >= MIN_BULLET_CONCEPT_RETENTION,
  );
});

test('a dropped quantity is reported even when the wording is otherwise faithful', () => {
  const original = modelWith(['Coordinated a team of 15+ staff across housekeeping and front desk.']);
  const rewritten = modelWith(['Coordinated staff across housekeeping and front desk operations.']);

  const result = validateTailoredModel(original, rewritten);
  const numeric = result.errors.find((e) => /quantities/.test(e));
  assert.ok(numeric, `expected a dropped-quantity error, got ${JSON.stringify(result.errors)}`);
  assert.match(numeric, /15\+/);
});

test('the summary is exempt: rewriting it wholesale is the legitimate core of tailoring', () => {
  const original = modelWith(['Reconciled accounts payable in NetSuite for 3 entities.']);
  const rewritten = {
    ...modelWith(['Reconciled accounts payable in NetSuite for 3 entities.']),
    summary: 'Completely different positioning statement aimed squarely at the target role and its stated priorities.',
  };
  assert.deepEqual(validateTailoredModel(original, rewritten).errors, []);
});

// --- the opposite failure: echoing the input back ---------------------------

test('a response that returns everything unchanged is rejected, not approved', () => {
  // Observed in a real run. Told firmly to keep the concrete words, the model
  // satisfied that by copying the input verbatim -- which scores perfectly on
  // retention, drops no numbers and fabricates nothing, so it shipped an
  // untailored resume reported as "approved". The retention floor rewards
  // copying unless this check exists to counterbalance it.
  const bullets = ['Reconciled accounts payable in NetSuite for 3 entities.'];
  const original = modelWith(bullets);
  const echoed = modelWith([...bullets]);

  const result = validateTailoredModel(original, echoed);
  assert.equal(result.passed, false, 'an untailored resume must not report as approved');
  assert.ok(result.errors.some((e) => /nothing was tailored/.test(e)), JSON.stringify(result.errors));
});

test('whitespace and casing changes alone do not count as tailoring', () => {
  const original = modelWith(['Reconciled accounts payable in NetSuite for 3 entities.']);
  const cosmetic = modelWith(['reconciled   accounts payable in netsuite for 3 entities.']);
  assert.equal(validateTailoredModel(original, cosmetic).passed, false);
});

test('unchanged bullets with a genuinely rewritten summary warn rather than fail', () => {
  // Partial work is not the same as no work: the summary is the most
  // job-specific part, so this ships with a warning instead of a retry.
  const bullets = ['Reconciled accounts payable in NetSuite for 3 entities.'];
  const original = modelWith(bullets);
  const summaryOnly = { ...modelWith([...bullets]), summary: 'A completely different positioning statement written for this specific role and its priorities.' };

  const result = validateTailoredModel(original, summaryOnly);
  assert.equal(result.passed, true);
  assert.ok(result.warnings.some((w) => /bullets unchanged/.test(w)), JSON.stringify(result.warnings));
});

test('the prompt tells the model that copying is a failure, not just that dropping terms is', () => {
  // Both directions must be stated. Fixing one caused the other in a real run.
  const messages = buildTailorMessages(modelWith(['Reconciled accounts payable in NetSuite.']), 'A job description.', undefined, []);
  const system = messages[0].content;
  assert.match(system, /CARRY OVER THE CONCRETE WORDS/);
  assert.match(system, /unchanged is a failed/i);
});

// --- job title plausibility -------------------------------------------------

test('isPlausibleJobTitle rejects the page furniture that scraping picks up', () => {
  for (const bad of ['Welcome, Juan', 'Sign in', 'Apply now', 'Hello there', 'Save this job', 'Thanks!']) {
    assert.equal(isPlausibleJobTitle(bad), false, `"${bad}" should be rejected`);
  }
});

test('isPlausibleJobTitle accepts real titles, including long and punctuated ones', () => {
  for (const good of [
    'Backend Engineer',
    'Senior Consultant, Risk Advisory',
    'Digital Account Strategist (Google Ads)',
    'VP of Finance & Operations',
  ]) {
    assert.equal(isPlausibleJobTitle(good), true, `"${good}" should be accepted`);
  }
});

test('isPlausibleJobTitle rejects a title that is just the candidate name', () => {
  assert.equal(isPlausibleJobTitle('Juan Rivera', 'Juan Rivera'), false);
  assert.equal(isPlausibleJobTitle('Welcome back, Juan Rivera', 'Juan Rivera'), false);
  // A real title that merely shares a common word must survive.
  assert.equal(isPlausibleJobTitle('Rivera Program Manager', 'Juan Rivera'), true);
});
