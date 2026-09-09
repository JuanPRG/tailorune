// pageFit.test.mjs — the promise, tested against the artifact.
//
// WHY THIS FILE EXISTS. A real resume was tailored to 494 words, passed the
// 510-word budget, compacted zero times, and shipped at two pages. Its
// 421-word original was one page. The bug survived a full green suite, and
// what the suite measured is why:
//
//   - render-parity.test.mjs compares the three renderers to EACH OTHER.
//     Three renderers agreeing on a layout that overflows still passes.
//   - Its "a long resume is one page" test builds a model of 444 words with
//     FOUR bullets across TWO entries. That is 66 words short of the budget,
//     and a shape no real resume has. It is a good guard against renderer
//     drift, which is what its own comment says it was written for. It was
//     never a test of the budget.
//   - resumeModel.test.mjs checks the compactor's arithmetic against a word
//     count -- which is the proxy that was wrong.
//
// Nothing asked the question the product actually promises: does an arbitrary
// realistic resume come out as one page.
//
// THE FIXTURE'S CHARACTER LENGTHS ARE THE POINT, and they cost several
// attempts to get right. Matching the reported resume's word count did not
// reproduce the bug; neither did matching its bullet count. 24 bullets over
// 6 entries at 501 words rendered to ONE page, while the real 17 bullets at
// 494 words rendered to two. The difference was character width: the real
// bullets run 108-136 characters and wrap to two lines each, while the
// synthetic ones were ~85 and fit on one. Word count is blind to that, and
// so was every fixture in this repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelWordCount, compactUntil } from '../../extension/engine/resumeModel.js';
import { countResumePages } from '../../extension/engine/renderPdf.js';
import { ONE_PAGE_WORD_BUDGET } from '../../extension/engine/tailor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FONTS = {
  regular: readFileSync(path.join(ROOT, 'extension/fonts/arimo-regular.ttf')),
  bold: readFileSync(path.join(ROOT, 'extension/fonts/arimo-bold.ttf')),
  italic: readFileSync(path.join(ROOT, 'extension/fonts/arimo-italic.ttf')),
};

// Lengths taken from the reported resume: bullets 108-136 chars, skills lines
// 105-123, headlines up to 87. Every one of those wraps to two lines at 10pt
// on a 6.8in column, which is the vertical cost a word count cannot see.
const TITLES = [
  'Financial Analyst, Corporate Reporting and Consolidation — Northwind Analytics Group',
  'Senior Reporting Analyst, Planning and Forecasting — Fabrikam Logistics International',
  'Data Analyst, Commercial Finance — Tailspin Retail',
  'Business Analyst, Revenue Operations — Contoso Consumer Products',
  'Junior Financial Analyst, Month End Close and Reconciliation — Woodgrove Bank of Commerce',
  'Analyst Intern, Treasury and Reporting — Litware Financial',
];
const BULLETS = [
  'Rebuilt the weekly management reporting pipeline in dbt and Snowflake, cutting turnaround from four days to six hours.',
  'Designed and ran twenty eight pricing experiments, of which nine shipped and raised contribution margin on a large line.',
  'Replaced a hand maintained spreadsheet forecast with a documented Python model, halving mean absolute percentage error.',
];

/** @param {number[]} bulletsPerEntry one number per role, as a real resume varies. */
function realisticModel(bulletsPerEntry) {
  return {
    name: 'Jordan Lee',
    contact: 'Vancouver, British Columbia, Canada | jordan.lee@example.com | 604-555-0199',
    summary: 'Financial and product analyst with six years turning messy operational data into '
      + 'decisions that stuck, comfortable owning a question from the initial pull through to the '
      + 'team that has to act on the answer.',
    skills: {
      heading: 'CORE COMPETENCIES',
      lines: [
        'Reporting and Close: SQL, Python, pandas, dbt, Snowflake, Airflow, month end consolidation',
        'Visualisation and Modelling: Looker, Tableau, Power BI, advanced Excel financial modelling',
        'Analytical Methods: A/B testing, causal inference, demand forecasting, variance analysis',
        'Systems: NetSuite, SAP, Workday Adaptive Planning, Oracle Hyperion, Microsoft Dynamics',
      ],
    },
    sections: [
      {
        kind: 'experience',
        heading: 'PROFESSIONAL EXPERIENCE',
        entries: bulletsPerEntry.map((n, i) => ({
          title: TITLES[i % TITLES.length],
          meta: 'Mar 2021 – Present',
          bullets: Array.from({ length: n }, (_, j) => BULLETS[j % BULLETS.length]),
        })),
      },
      {
        kind: 'education',
        heading: 'EDUCATION',
        lines: [
          'Master of Science, Data Science and Analytics | 2019', 'Simon Fraser University',
          'Bachelor of Commerce, Business Analytics | 2017', 'University of British Columbia',
        ],
      },
    ],
  };
}

/** The reported shape: six roles, seventeen bullets. */
const REPORTED_SHAPE = [3, 3, 3, 3, 3, 2];

test('THE BUG: a realistic resume passes the word budget and still renders to two pages', async () => {
  const model = realisticModel(REPORTED_SHAPE);
  const words = modelWordCount(model);
  const pages = await countResumePages(model, FONTS);

  assert.ok(words <= ONE_PAGE_WORD_BUDGET,
    `the fixture must sit UNDER the budget or it does not reproduce the bug: ${words} vs ${ONE_PAGE_WORD_BUDGET}`);
  assert.ok(pages > 1,
    `the fixture must actually overflow: ${pages} page(s) at ${words} words`);
});

test('the overflow band is wide, not a rounding error at the boundary', async () => {
  // 477 words -- 33 under the budget -- still overflows. The budget is not
  // slightly optimistic for realistic resumes; it is wrong by a wide margin,
  // which is why nobody noticed it as an off-by-a-little.
  const model = realisticModel([3, 3, 3, 3, 2, 2]);
  assert.ok(modelWordCount(model) < ONE_PAGE_WORD_BUDGET - 20);
  assert.ok(await countResumePages(model, FONTS) > 1);
});

test('measuring the page catches what the word budget missed, and compaction fixes it', async () => {
  const model = realisticModel(REPORTED_SHAPE);
  const fits = async (m) => (await countResumePages(m, FONTS)) <= 1;

  assert.equal(await fits(model), false, 'precondition: does not fit');
  const { model: compacted, iterations } = await compactUntil(model, fits);
  assert.ok(iterations > 0, 'compaction must actually do something');
  assert.equal(await countResumePages(compacted, FONTS), 1, 'the promise: one page');
});

test('a resume that already fits loses nothing', async () => {
  const model = realisticModel([2, 2]);
  const fits = async (m) => (await countResumePages(m, FONTS)) <= 1;
  assert.equal(await fits(model), true, 'precondition: fits');
  const { model: after, iterations } = await compactUntil(model, fits);
  assert.equal(iterations, 0);
  assert.deepEqual(after, model, 'a fitting resume must not lose a single bullet');
});
