import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePreferences, factoryPreferences, coverLetterWordRange, PreferenceError,
  buildResumePreferencesSection, buildCoverLetterPreferencesSection,
  RESUME_DENSITY_WORD_TARGET,
} from '../../extension/engine/preferences.js';

test('the default density is STANDARD, where v4 used detailed', () => {
  // v4 defaulted to detailed, and this asserted that for parity. It was
  // changed deliberately: "detailed" tells the model to use as much of the
  // page as possible, which is the wrong default now that overflow is paid
  // for in bullets the compactor drops rather than in a second page.
  const p = factoryPreferences();
  assert.equal(p.resume_density, 'standard');
  assert.equal(p.keyword_alignment, 'balanced');
  assert.equal(p.cover_letter_length, 'standard');
  assert.equal(p.cover_letter_tone, 'direct');
  assert.deepEqual(p.emphasis_areas, []);
});

test('validatePreferences fills unspecified fields from defaults (partial payloads are allowed)', () => {
  const p = validatePreferences({ cover_letter_tone: 'warm' });
  assert.equal(p.cover_letter_tone, 'warm');
  assert.equal(p.resume_density, 'standard'); // untouched default
});

test('validatePreferences rejects an unknown field rather than silently ignoring it', () => {
  assert.throws(() => validatePreferences({ nonsense: 1 }), PreferenceError);
});

test('validatePreferences rejects an out-of-enum value and names the allowed set', () => {
  assert.throws(
    () => validatePreferences({ cover_letter_length: 'epic' }),
    (err) => err instanceof PreferenceError && /short, standard, long/.test(err.message),
  );
});

test('validatePreferences dedupes emphasis_areas and rejects unsupported entries', () => {
  const p = validatePreferences({ emphasis_areas: ['technical', 'technical', 'data'] });
  assert.deepEqual(p.emphasis_areas, ['technical', 'data']);
  assert.throws(() => validatePreferences({ emphasis_areas: ['astrology'] }), PreferenceError);
});

test('validatePreferences enforces the text length caps (600 for preserve_points, 800 for notes)', () => {
  assert.throws(() => validatePreferences({ preserve_points: 'x'.repeat(601) }), PreferenceError);
  assert.doesNotThrow(() => validatePreferences({ preserve_points: 'x'.repeat(600) }));
  assert.throws(() => validatePreferences({ resume_notes: 'x'.repeat(801) }), PreferenceError);
  assert.doesNotThrow(() => validatePreferences({ cover_letter_notes: 'x'.repeat(800) }));
});

test('validatePreferences trims and normalizes CRLF in text fields', () => {
  const p = validatePreferences({ resume_notes: '  line one\r\nline two  ' });
  assert.equal(p.resume_notes, 'line one\nline two');
});

test('coverLetterWordRange maps each length preference to the v4 word bands', () => {
  assert.deepEqual(coverLetterWordRange({ cover_letter_length: 'short' }), [180, 250]);
  assert.deepEqual(coverLetterWordRange({ cover_letter_length: 'standard' }), [225, 275]);
  assert.deepEqual(coverLetterWordRange({ cover_letter_length: 'long' }), [300, 425]);
});

test('coverLetterWordRange falls back to the standard band for missing or bogus input', () => {
  assert.deepEqual(coverLetterWordRange(null), [225, 275]);
  assert.deepEqual(coverLetterWordRange({ cover_letter_length: 'nonsense' }), [225, 275]);
});

test('buildResumePreferencesSection is scoped style-only and always forbids fabrication', () => {
  const section = buildResumePreferencesSection(factoryPreferences());
  assert.match(section, /scope="style_only"/);
  assert.match(section, /NEVER allow invented tools, metrics, employers/);
  // aggressive guidance is unconditional in v4 -- see preferences.js header
  assert.match(section, /Aggressive tailoring guidance/);
});

test('buildResumePreferencesSection includes user free-text only when actually set', () => {
  const without = buildResumePreferencesSection(factoryPreferences());
  assert.ok(!/Key points to preserve/.test(without));
  const withText = buildResumePreferencesSection(validatePreferences({ preserve_points: 'Keep the AWS work.' }));
  assert.match(withText, /Key points to preserve when relevant: Keep the AWS work\./);
});

test('buildCoverLetterPreferencesSection reflects the chosen tone and length', () => {
  const section = buildCoverLetterPreferencesSection(validatePreferences({ cover_letter_tone: 'formal', cover_letter_length: 'long' }));
  assert.match(section, /Cover letter tone: formal/);
  assert.match(section, /Cover letter length: long/);
  assert.match(section, /NEVER allow invented/);
});

test('density actually changes the word target the prompt asks for', () => {
  // THE BUG THIS EXISTS FOR. The prompt hard-coded ONE_PAGE_WORD_BUDGET for
  // every density, so the selector claimed to change length while all three
  // settings asked for the same 510 words. Someone whose resume came out two
  // pages tried concise, standard and detailed, and correctly reported that
  // nothing changed -- because nothing did.
  const targets = ['concise', 'standard', 'detailed'].map((d) => RESUME_DENSITY_WORD_TARGET[d]);
  assert.equal(new Set(targets).size, 3, 'each density must ask for a different length');
  assert.ok(targets[0] < targets[1] && targets[1] < targets[2], 'and they must be ordered');
});
