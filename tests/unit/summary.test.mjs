// summary.test.mjs — redact(), the last stop before an error message is shown or stored.
//
// Found in production (M5): a provider key truncated to the single letter "g"
// by a broken deploy script made redact() replace every "g" in the error, so
// the one message that would have explained the problem came out unreadable.
// A real provider key is tens of characters; anything short is not one, and
// must never be used as a search string.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../../server/summary.mjs';

const KEY = 'gsk_RealLookingKey0123456789abcdefghijklmnop';

test('a real key is redacted wherever it appears', () => {
  assert.equal(redact(`bad key ${KEY} for groq`, { groq: KEY }), 'bad key [redacted] for groq');
});

test('a value too short to be a key is never used to redact', () => {
  const message = 'gemini/gemini-3.1-flash-lite: request_incompatible; groq: provider_configuration_error';
  assert.equal(redact(message, { groq: 'g', gemini: '', openrouter: 'short' }), message);
});
