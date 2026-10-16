// summary.test.mjs — redact(), the last stop before an error message is shown or stored.
//
// Found in production (M5): a provider key truncated to the single letter "g"
// by a broken deploy script made redact() replace every "g" in the error, so
// the one message that would have explained the problem came out unreadable.
// A real provider key is tens of characters; anything short is not one, and
// must never be used as a search string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, summarizeRun } from '../../server/summary.mjs';

const KEY = 'gsk_RealLookingKey0123456789abcdefghijklmnop';

test('a real key is redacted wherever it appears', () => {
  assert.equal(redact(`bad key ${KEY} for groq`, { groq: KEY }), 'bad key [redacted] for groq');
});

test('a value too short to be a key is never used to redact', () => {
  const message = 'gemini/gemini-3.1-flash-lite: request_incompatible; groq: provider_configuration_error';
  assert.equal(redact(message, { groq: 'g', gemini: '', openrouter: 'short' }), message);
});

test('a failed letter is reported as failed, with why, and no text', () => {
  const summary = summarizeRun({
    resumeStatus: 'approved', wordCount: 400, resumeWarnings: [], resumeErrors: [],
    skills: { status: 'approved' },
    coverLetter: {
      status: 'failed', text: null, wordCount: null, warnings: [], errors: [],
      failure: { kind: 'providers_temporarily_unavailable', message: 'Retry in about 30s.' },
    },
    llm: { calls: 4, ms: 9_000 },
  }, { job: { title: 'T', employer: 'E' }, files: [] });

  assert.deepEqual(summary.cover_letter, {
    status: 'failed',
    word_count: null,
    warnings: [],
    errors: [],
    error: { kind: 'providers_temporarily_unavailable', message: 'Retry in about 30s.' },
  });
  assert.equal(summary.cover_letter_text, null);
  assert.equal(summary.resume.status, 'approved');
});
