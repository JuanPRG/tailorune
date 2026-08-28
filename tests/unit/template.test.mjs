// template.test.mjs — the typographic rules of the output template.
//
// Derived from the strongest of the user's own resumes, and asserted here
// because a template degrades one reasonable-looking exception at a time. An
// earlier version reached FIVE type sizes — including an 8.5pt contact line,
// smaller than anything on a real resume — with every individual step
// defensible. The count is the thing worth pinning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Packer } from 'docx';
import { buildResumeDocument } from '../../extension/engine/renderDocx.js';
import { renderResumeHtml } from '../../extension/engine/renderHtml.js';
import { parseTxt } from '../../extension/engine/parseTxt.js';

const MODEL = parseTxt([
  'Juan Rivera',
  'Toronto, ON | 647-555-0100 | juan@example.com',
  '',
  'PROFILE',
  'Finance and operations professional with a decade across advisory and hospitality.',
  '',
  'SKILLS',
  '- Finance: Bookkeeping, NIIF/IFRS, budgeting',
  '- Tools: Excel, Google Workspace',
  '',
  'WORK EXPERIENCE',
  'Financial Administrator  |  Yesos Colombia S.A.S.  2018 - Present',
  'Colombia (Remote, Manufacturing and Distribution, long-form context line)',
  '- Ran full-cycle reporting under NIIF/IFRS.',
  'Hotel Operations Coordinator  |  La Rivera  2020 - 2022',
  'Palomino, Colombia',
  '- Coordinated a team of 15+ staff.',
  '',
  'EDUCATION',
  'Bachelor of Economics  2015',
].join('\n'));

async function docxXml(model = MODEL) {
  const bytes = await Packer.toBuffer(buildResumeDocument(model));
  return (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
}

test('the whole document uses exactly two type sizes', async () => {
  const xml = await docxXml();
  const sizes = [...new Set((xml.match(/<w:sz w:val="(\d+)"/g) || []).map((s) => Number(s.match(/\d+/)[0]) / 2))];
  assert.deepEqual(sizes.sort((a, b) => b - a), [18, 10], `expected 18pt and 10pt only, got ${sizes.join(', ')}pt`);
});

test('margins are asymmetric: a narrow top, sides that control line length', async () => {
  const tag = (await docxXml()).match(/<w:pgMar[^>]*>/)[0];
  const twips = (k) => Number(tag.match(new RegExp(`w:${k}="(\\d+)"`))[1]);
  assert.equal(twips('top'), 432, 'top should be 0.30in');
  assert.equal(twips('left'), 1080, 'sides should be 0.75in');
  assert.equal(twips('right'), 1080);
  assert.equal(twips('bottom'), 864, 'bottom should be 0.60in');
});

test('a role date is right-aligned on a real tab stop, not buried in a subtitle', async () => {
  // Both reference resumes right-align dates. The previous template put the
  // date at the START of a small italic line under the title, burying the one
  // field a recruiter looks for first.
  const xml = await docxXml();
  assert.match(xml, /w:val="right"/, 'no right-aligned tab stop found');
  assert.match(xml, /<w:tab\/>/, 'no tab emitted into the role headline');
});

test('short context joins the title line; long context drops to its own', async () => {
  const bytes = await Packer.toBuffer(buildResumeDocument(MODEL));
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const lines = (await extractDocxText(bytes)).split(String.fromCharCode(10)).map((l) => l.trim());

  const short = lines.find((l) => l.startsWith('Hotel Operations Coordinator'));
  assert.match(short, /Palomino, Colombia/, 'a short context should share the title line');
  assert.match(short, /2020 – 2022|2020 - 2022/, 'the date belongs on that line too');

  const long = lines.find((l) => l.startsWith('Financial Administrator'));
  assert.doesNotMatch(long, /Manufacturing and Distribution/, 'a long context must not crowd the date');
  assert.ok(
    lines.some((l) => l.startsWith('Colombia (Remote')),
    'the long context should appear on its own line',
  );
});

test('skills lines render as real list items', async () => {
  // Each line is a labelled group; a bullet is what marks them as peers
  // rather than prose, for a reader and for a parser.
  const xml = await docxXml();
  const bullets = (xml.match(/<w:numPr>/g) || []).length;
  assert.ok(bullets >= 4, `expected skills and role bullets as list items, got ${bullets}`);
});

test('a source line that already carries a bullet marker does not print the marker as text', async () => {
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const bytes = await Packer.toBuffer(buildResumeDocument(MODEL));
  const text = await extractDocxText(bytes);
  assert.doesNotMatch(text, /^- - /m, 'a doubled bullet means the marker was rendered as literal text');
});

test('section headings are capitalised but keep their own wording', async () => {
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const model = parseTxt([
    'Ada Lovelace', 'ada@example.com', '',
    'Objective', 'A short objective statement written for the target role.',
  ].join('\n'));
  const lines = (await extractDocxText(await Packer.toBuffer(buildResumeDocument(model))))
    .split(String.fromCharCode(10)).map((l) => l.trim());
  assert.ok(lines.includes('OBJECTIVE'), 'the heading should be upper-cased for consistency');
  assert.ok(!lines.includes('SUMMARY'), 'but never reworded into a different heading');
});

// --- source section order ---------------------------------------------------

test('a resume that ends with skills comes back ending with skills', async () => {
  // Skills is parsed out of `sections` into its own field because it has its
  // own tailoring pass -- but that is an implementation detail and must not
  // decide where it prints.
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const model = parseTxt([
    'Ada Lovelace', 'ada@example.com', '',
    'WORK EXPERIENCE', 'Analyst  |  Acme  2020 - 2024', '- Did the work.', '',
    'EDUCATION', 'BA History, UBC', '',
    'SKILLS', 'Tools: Excel',
  ].join(String.fromCharCode(10)));

  const lines = (await extractDocxText(await Packer.toBuffer(buildResumeDocument(model))))
    .split(String.fromCharCode(10)).map((l) => l.trim());
  const headings = lines.filter((l) => ['WORK EXPERIENCE', 'EDUCATION', 'SKILLS'].includes(l));
  assert.deepEqual(headings, ['WORK EXPERIENCE', 'EDUCATION', 'SKILLS']);
});

test('a resume that leads with skills still leads with skills', async () => {
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const model = parseTxt([
    'Ada Lovelace', 'ada@example.com', '',
    'SKILLS', 'Tools: Excel', '',
    'WORK EXPERIENCE', 'Analyst  |  Acme  2020 - 2024', '- Did the work.',
  ].join(String.fromCharCode(10)));

  const lines = (await extractDocxText(await Packer.toBuffer(buildResumeDocument(model))))
    .split(String.fromCharCode(10)).map((l) => l.trim());
  assert.ok(lines.indexOf('SKILLS') < lines.indexOf('WORK EXPERIENCE'));
});

test('a hand-built model with no recorded order still renders', () => {
  // Older callers and tests construct models directly; they must not crash on
  // a missing order field.
  const model = {
    name: 'X', contact: 'x@y.z', summary: null, summaryHeading: null,
    skills: { heading: 'SKILLS', lines: ['Tools: Excel'] },
    sections: [{ kind: 'education', heading: 'EDUCATION', lines: ['BA History'] }],
  };
  assert.doesNotThrow(() => buildResumeDocument(model));
});

// --- justification ----------------------------------------------------------

test('bullets, summary and skills are justified; titles and dated rows are not', async () => {
  const xml = await docxXml();
  const justified = (xml.match(/w:val="both"/g) || []).length;
  assert.ok(justified >= 4, `expected justified body paragraphs, got ${justified}`);

  // A role headline carries a right-aligned tab stop; justifying it would
  // stretch the title across the page against a date that cannot move.
  const roleParagraphs = (xml.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*?w:val="right"[\s\S]*?<\/w:p>/g) || []);
  assert.ok(roleParagraphs.length > 0, 'no dated rows found to check');
  for (const p of roleParagraphs) {
    assert.doesNotMatch(p, /w:val="both"/, 'a dated row must not be justified');
  }
});

// --- education dates --------------------------------------------------------

test('an education line ending in a year gets that year flush right, like a role', async () => {
  const { extractDocxText } = await import('../../extension/engine/extractDocxText.js');
  const model = parseTxt([
    'Ada Lovelace', 'ada@example.com', '',
    'EDUCATION',
    'Bachelor of Economics  2015',
    'Universidad de Ibague — Ibague, Colombia',
    'Advanced Diploma in Computer Programming (CPA)  May 2023 - Apr 2026',
  ].join(String.fromCharCode(10)));

  const bytes = await Packer.toBuffer(buildResumeDocument(model));
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml').async('string');
  // Two dated degree lines, and the institution line between them is not one.
  assert.equal((xml.match(/w:val="right"/g) || []).length, 2);

  const text = await extractDocxText(bytes);
  assert.match(text, /Bachelor of Economics\s+2015/);
  assert.match(text, /May 2023 - Apr 2026/);
});

test('the trailing-year pattern survives being a regex, not an assembled string', () => {
  // It did not, at first: \s and \d are invalid escapes inside a template
  // literal and collapse to bare `s` and `d`, so the assembled pattern matched
  // nothing and failed silently. This asserts the behaviour that bug removed.
  const model = parseTxt([
    'Ada Lovelace', 'ada@example.com', '',
    'EDUCATION', 'Bachelor of Economics  2015',
  ].join(String.fromCharCode(10)));
  const html = renderResumeHtml(model);
  assert.match(html, /class="role-date">2015</, 'the year should be split out and right-aligned');
});

// --- the one-page budget is tied to the geometry ----------------------------

test('the one-page word budget sits under the measured page boundary', async () => {
  // The budget is not a style preference, it is a property of the TEMPLATE:
  // font size, line height and margins together decide how many words fit.
  // 570 was measured at Arial 10.5pt with 0.75in margins all round; the
  // template has since moved to 10pt with a 0.30in top and 0.60in bottom, and
  // re-running the same LibreOffice page-count sweep put the real boundary at
  // 522 words for one page, 543 for two. The old value was letting documents
  // run onto page two.
  const { ONE_PAGE_WORD_BUDGET } = await import('../../extension/engine/tailor.js');
  assert.ok(
    ONE_PAGE_WORD_BUDGET < 522,
    `budget ${ONE_PAGE_WORD_BUDGET} is at or above the measured 522-word one-page boundary`,
  );
  // And not so low that it needlessly guts a resume.
  assert.ok(ONE_PAGE_WORD_BUDGET > 450, `budget ${ONE_PAGE_WORD_BUDGET} is unnecessarily tight`);
});

// --- the HTML exit is the same design, not a second one ---------------------

test('the HTML preview uses one body size and inherits it for headings', () => {
  const html = renderResumeHtml(MODEL);
  assert.match(html, /body\s*\{[^}]*font-size:\s*10pt/);
  assert.match(html, /h2\s*\{[^}]*font-size:\s*inherit/);
  assert.match(html, /h2\s*\{[^}]*text-transform:\s*uppercase/);
});

test('the HTML preview right-aligns role dates the same way the DOCX does', () => {
  const html = renderResumeHtml(MODEL);
  assert.match(html, /class="role-head"/);
  assert.match(html, /class="role-date"/);
  assert.match(html, /\.role-head\s*\{[^}]*justify-content:\s*space-between/);
});

test('the HTML preview and the DOCX agree on which context is inline', () => {
  // One content model, two exits: a role that reads as one line in the
  // document must not read as two in the preview.
  const html = renderResumeHtml(MODEL);
  assert.match(html, /Hotel Operations Coordinator[^<]*Palomino, Colombia/, 'short context should be inline');
  assert.match(html, /class="role-context"[^>]*>Colombia \(Remote/, 'long context should be its own line');
});
