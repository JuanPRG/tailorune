// make-fonts.mjs — subset Arimo down to what a resume actually contains.
//
// WHY ARIMO. The DOCX is Arial, so the PDF has to break lines in the same
// places or the two files stop being the same document. Arimo is Arial's
// metric-compatible twin (same designer, SIL Open Font License 1.1,
// redistributable where Arial is not), and "metric-compatible" here is not a
// marketing word --
// tests/unit/fontMetrics.test.mjs measures every advance width against the
// real arial.ttf and requires them IDENTICAL, not merely close.
//
// WHY SUBSET. The shipped TTFs are ~311KB each because they carry Cyrillic,
// Greek, Hebrew and Vietnamese. Three weights of that is nearly a megabyte of
// extension for glyphs no resume template can reach. Subsetting to the Latin
// ranges cuts it by roughly 80% and changes no metric of any glyph kept.
//
// The ranges are chosen from what resumes really contain, which is wider than
// ASCII: accented names (Latin-1), Polish/Czech/Turkish/Croatian names
// (Latin Extended-A/B), the en-dash in every date range, curly quotes that
// arrive via LLM output, and the bullet character.
//
// Outputs are committed, so the extension needs no build step to be loadable
// and no network at package time. Re-run only when the ranges change.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import subsetFont from 'subset-font';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension/fonts');

const RANGES = [
  [0x0020, 0x024f], // Basic Latin, Latin-1, Latin Extended-A and -B
  [0x2013, 0x2014], // en dash, em dash -- every "2021 - Present"
  [0x2018, 0x201f], // curly quotes and apostrophes, which LLM prose is full of
  [0x2020, 0x2022], // dagger, double dagger, bullet
  [0x2026, 0x2026], // ellipsis
  [0x20a0, 0x20bf], // currency, for salary and euro-denominated figures
];

const FACES = [
  ['400Regular/Arimo_400Regular.ttf', 'arimo-regular.ttf'],
  ['700Bold/Arimo_700Bold.ttf', 'arimo-bold.ttf'],
  ['400Regular_Italic/Arimo_400Regular_Italic.ttf', 'arimo-italic.ttf'],
];

let text = '';
for (const [lo, hi] of RANGES) for (let c = lo; c <= hi; c++) text += String.fromCodePoint(c);

mkdirSync(OUT, { recursive: true });
let before = 0; let after = 0;

for (const [src, out] of FACES) {
  const raw = readFileSync(path.join(ROOT, 'node_modules/@expo-google-fonts/arimo', src));
  const sub = await subsetFont(raw, text, { targetFormat: 'truetype' });
  writeFileSync(path.join(OUT, out), sub);
  before += raw.length; after += sub.length;
  console.log(`  ${out.padEnd(20)} ${(raw.length / 1024).toFixed(1).padStart(7)} KB -> ${(sub.length / 1024).toFixed(1).padStart(6)} KB`);
}
console.log(`  ${'TOTAL'.padEnd(20)} ${(before / 1024).toFixed(1).padStart(7)} KB -> ${(after / 1024).toFixed(1).padStart(6)} KB`
  + `  (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
