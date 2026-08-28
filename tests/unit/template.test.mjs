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
