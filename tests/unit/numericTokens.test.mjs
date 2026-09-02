// numericTokens.test.mjs — a digit is not automatically a metric.
//
// Regression test for a bug that was costing an extra LLM call and a failed
// validation status on EVERY run, in a way that looked like model quality.
//
// The dropped-quantity check exists to catch a rewrite quietly turning
// "reduced costs by 30%" into "improved cost efficiency". The original
// implementation matched any digit run anywhere in the text, so the fixture's
// "...profitable through the COVID-19 downturn..." contributed the token "19".
// Every tailoring run then reported:
//
//   resume ERROR  Role 1 dropped quantities that were in the original: 19.
//
// because the rewrite reasonably dropped the pandemic reference. That burned a
// retry, triggered a model demotion, and finished as
// `fallback_after_validation` — a check meant to police vagueness was instead
// policing a disease name.
//
// It generalises badly, which is why this is a rule and not a special case for
// one string: resumes are full of names that contain digits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericTokens, droppedNumbers } from '../../extension/engine/textUtils.js';

const tokens = (text) => [...numericTokens(text)].sort();

// --- the metrics the guard exists to protect ------------------------------

test('a bare count is a metric', () => {
  assert.deepEqual(tokens('managed 19 vendor relationships'), ['19']);
});

test('percentages, currency and scale suffixes are metrics', () => {
  assert.deepEqual(tokens('cut costs 30%'), ['30%']);
  assert.deepEqual(tokens('saved $1.2M'), ['$1.2m']);
  assert.deepEqual(tokens('reclaimed 40k hours'), ['40k']);
  assert.deepEqual(tokens('grew throughput 3x'), ['3x']);
  assert.deepEqual(tokens('led 15+ staff'), ['15+']);
});

test('trailing sentence punctuation does not corrupt the token', () => {
  assert.deepEqual(tokens('improved margin by 12%.'), ['12%']);
  assert.deepEqual(tokens('across 8 sites, on time'), ['8']);
});

test('a metric inside brackets still counts', () => {
  // The bracket rule below must not swallow a genuine parenthetical figure.
  assert.deepEqual(tokens('reduced costs by 30% (net of fees)'), ['30%']);
});

// --- the identifiers it must ignore ---------------------------------------

test('COVID-19 is a name, not a quantity — the actual bug', () => {
  assert.deepEqual(tokens('stayed profitable through the COVID-19 downturn'), []);
});

test('a hyphenated alphanumeric name yields nothing', () => {
  for (const text of ['supported K-12 districts', 'serviced F-15 airframes', 'ran T-4 diagnostics']) {
    assert.deepEqual(tokens(text), [], `should ignore the identifier in: ${text}`);
  }
});

test('a digit glued to letters is a product name', () => {
  for (const text of ['migrated off Log4j', 'built HTML5 dashboards', 'deployed to S3', 'tuned EC2 instances']) {
    assert.deepEqual(tokens(text), [], `should ignore the identifier in: ${text}`);
  }
});

test('a bracket straight after digits marks a named thing', () => {
  assert.deepEqual(tokens('administered 401(k) enrolment'), []);
  assert.deepEqual(tokens('filed under Section 8(a)'), []);
});

// --- the guard still has teeth --------------------------------------------

test('the real failure mode is still caught: a quantified claim going vague', () => {
  const before = 'Coordinated a team of 15+ staff across 3 sites, cutting spend 22%.';
  const after = 'Coordinated staff across sites, improving cost efficiency.';
  assert.deepEqual(droppedNumbers(before, after).sort(), ['15+', '22%', '3']);
});

test('dropping only the identifier is no longer a violation', () => {
  // The exact original/rewrite pair from the failing live runs.
  const before = 'Built multi-year forecasting models and cash flow plans that kept '
    + 'the business profitable through the COVID-19 downturn.';
  const after = 'Built multi-year forecasting models and cash flow plans that sustained '
    + 'profitability through a severe market downturn.';
  assert.deepEqual(droppedNumbers(before, after), []);
});

test('a metric kept alongside a dropped product name passes', () => {
  const before = 'Ran 12 audits on Log4j services during COVID-19.';
  const after = 'Ran 12 audits across the service estate.';
  assert.deepEqual(droppedNumbers(before, after), [], 'only the identifiers were dropped');
});

test('KNOWN LIMIT: a bare four-digit year still reads as a metric', () => {
  // Recorded rather than fixed, deliberately.
  //
  // "Windows Server 2019" yields "2019", so dropping it would flag. The
  // obvious fix is to exclude bare 19xx/20xx tokens -- but checking every
  // resume fixture found ZERO bullets containing a bare year: dates live in
  // the right-aligned date column, which is not bullet text. So the failure
  // is hypothetical, and excluding years would weaken a guard the user values
  // ("processed 2019 invoices" is a real count) to fix something never
  // observed.
  //
  // Pinned so that if it does start costing retries, the behaviour is already
  // described and the tradeoff is written down.
  assert.deepEqual([...numericTokens('audited Windows Server 2019')], ['2019']);
});

test('empty and digitless input are safe', () => {
  assert.deepEqual(tokens(''), []);
  assert.deepEqual(tokens('no numbers here at all'), []);
  assert.deepEqual(droppedNumbers('', 'anything'), []);
});
