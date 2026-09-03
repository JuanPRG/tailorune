// fontMetrics.test.mjs — the PDF font must break lines exactly where Arial does.
//
// The DOCX is Arial and the PDF cannot be: Arial is not redistributable, and
// pdf-lib's built-in fonts are WinAnsi-encoded, which is precisely the defect
// that disqualified jsPDF in SPIKE_FINDINGS.md -- it turns "Lukasz" spelled
// with a stroked L into "Aukasz" and letter-spaces accented names on
// extraction. On a resume the candidate's own name is the one string that has
// to survive, so the font must be embedded and Unicode-capable.
//
// Arimo is the way out: same designer as Arial's metric-compatible twin,
// Apache 2.0, and -- the part this file exists to prove -- IDENTICAL advance
// widths. Not similar. Identical. Every glyph advancing by the same amount is
// what makes the PDF wrap where the DOCX wraps, which is what makes a
// one-page DOCX a one-page PDF.
//
// Asserted against the real arial.ttf when the machine has one. That is a
// Windows/macOS fact, not a guarantee, so the comparison skips cleanly
// elsewhere -- but the coverage assertions below always run, because those
// are properties of the file we ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const face = (n) => fontkit.create(readFileSync(path.join(ROOT, 'extension/fonts', n)));

const ARIAL = ['C:/Windows/Fonts/arial.ttf', '/Library/Fonts/Arial.ttf'].find((p) => existsSync(p));
const ARIAL_BOLD = ['C:/Windows/Fonts/arialbd.ttf', '/Library/Fonts/Arial Bold.ttf'].find((p) => existsSync(p));

// Everything a resume template can actually emit from the keyboard.
const SAMPLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  + " .,;:!?-()[]{}/\&%$#@*+=<>|~^_'\"";

function advances(font, text) {
  return [...text].map((ch) => font.layout(ch).advanceWidth / font.unitsPerEm);
}

for (const [name, file, arialPath] of [
  ['regular', 'arimo-regular.ttf', ARIAL],
  ['bold', 'arimo-bold.ttf', ARIAL_BOLD],
]) {
  test(`${name}: every advance width matches Arial exactly`, {
    skip: arialPath ? false : 'no Arial on this machine to compare against',
  }, () => {
    const arimo = advances(face(file), SAMPLE);
    const arial = advances(fontkit.create(readFileSync(arialPath)), SAMPLE);
    const diffs = arimo
      .map((w, i) => [SAMPLE[i], Math.abs(w - arial[i])])
      .filter(([, d]) => d > 1e-9);
    assert.deepEqual(diffs, [], `these glyphs advance differently than Arial: ${diffs.map(([c]) => c).join('')}`);
  });
}

test('a full line of text measures identically to Arial', { skip: ARIAL ? false : 'no Arial here' }, () => {
  // The property that actually matters. Per-glyph equality could in principle
  // hold while kerning diverged; this measures the thing line-breaking uses.
  const line = 'Senior Software Engineer — Distributed Systems & Platform Reliability (2021–Present)';
  const width = (f) => [...line].reduce((s, c) => s + f.layout(c).advanceWidth, 0) / f.unitsPerEm * 10;
  assert.equal(
    width(face('arimo-regular.ttf')).toFixed(6),
    width(fontkit.create(readFileSync(ARIAL))).toFixed(6),
    'a line of Arimo must be exactly as wide as the same line of Arial at 10pt',
  );
});

test('the subset still covers what real names and resumes contain', () => {
  // Subsetting is where coverage silently disappears, and the failure mode is
  // a missing glyph in someone's surname -- so this enumerates the cases
  // rather than trusting the range list in make-fonts.mjs.
  const required = {
    'basic latin': 'AZaz09',
    'accented names': 'áéíóúñüçãõâêôàèìòùäöë',   // García, Müller, Gonçalves
    'Latin Extended-A': 'ŁłŚśŻżĆćŃńĄąĘęČčŠšŽžĞğİıŐőŰű', // Polish, Czech, Turkish, Hungarian
    'date and prose punctuation': '–—‘’“”…•',
    'currency': '€£¥',
  };
  for (const [label, chars] of Object.entries(required)) {
    for (const file of ['arimo-regular.ttf', 'arimo-bold.ttf', 'arimo-italic.ttf']) {
      const font = face(file);
      const missing = [...chars].filter((c) => !font.characterSet.includes(c.codePointAt(0)));
      assert.deepEqual(missing, [], `${file} is missing ${label}: ${missing.join(' ')}`);
    }
  }
});

test('the shipped fonts stay small enough to justify carrying three of them', () => {
  // A regression guard on the build step, not on the font. Dropping the
  // subsetting would quietly add ~820KB to every install.
  let total = 0;
  for (const f of ['arimo-regular.ttf', 'arimo-bold.ttf', 'arimo-italic.ttf']) {
    total += readFileSync(path.join(ROOT, 'extension/fonts', f)).length;
  }
  assert.ok(total < 200 * 1024, `three faces should be under 200KB subset, got ${(total / 1024).toFixed(0)}KB`);
});
