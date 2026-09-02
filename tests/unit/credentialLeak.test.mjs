// credentialLeak.test.mjs — no diagnostic may ever contain an API key.
//
// This is a regression test for a real leak, written the same day it happened.
//
// Bringing the rotation to v4 parity meant keying cooldowns per CREDENTIAL as
// well as per model, because two keys for the same model have independent
// quotas. v4 puts the api_key straight into its dict key (llm.py:1216), which
// is safe in a backend process whose dicts never leave it.
//
// Ours leave. `cooldownState()` is returned in the run result, surfaced to the
// popup, and printed by the live harness -- so the first live run after that
// change wrote two real API keys to a terminal. The harness is careful never
// to print a key it reads; the leak came in through an identifier nobody
// thought of as containing one.
//
// Hence this test, which checks the OUTPUTS rather than the implementation:
// whatever the keys are built from, no user-visible surface may echo a secret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatWithRotation, cooldownState, resetCooldowns, demoteModel,
} from '../../extension/engine/rotatingClient.js';
import { rateWindowState, resetRateWindows, reserveRateBudget } from '../../extension/engine/rateWindow.js';
import { credentialFingerprint } from '../../extension/engine/fingerprint.js';

// Shaped like the real thing -- the leaked values were a `gsk_` and a `csk-`.
const SECRETS = {
  gemini: 'AIzaSyD-not-a-real-key-0123456789abcdef',
  groq: 'gsk_notARealKeyButShapedLikeOne0123456789abcdef',
  openrouter: 'sk-or-v1-notarealkey0001112223334445556667778889',
};

const CHAIN = Object.entries(SECRETS).map(([providerId, apiKey]) => ({ providerId, apiKey }));

const fail = (status, preview) => new Response(preview || `HTTP ${status}`, { status });

/** Assert no secret, or any substantial slice of one, appears in `text`. */
function assertNoSecret(text, label) {
  const haystack = String(text);
  for (const [providerId, secret] of Object.entries(SECRETS)) {
    assert.ok(!haystack.includes(secret), `${label} contains the full ${providerId} key`);
    // A truncated key is still a leak, and "first 12 characters" is the shape
    // a well-meaning redaction usually takes.
    assert.ok(
      !haystack.includes(secret.slice(0, 16)),
      `${label} contains a recognisable prefix of the ${providerId} key`,
    );
  }
}

test('cooldownState never contains a credential, in keys or values', async () => {
  resetCooldowns();
  resetRateWindows();
  const impl = async () => fail(429, 'You exceeded your current quota');
  await chatWithRotation({
    chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl, sleepImpl: async () => {},
  }).catch(() => {});

  const state = cooldownState();
  assert.ok(Object.keys(state).length > 0, 'the test needs at least one cooldown to inspect');
  assertNoSecret(JSON.stringify(state), 'cooldownState()');
});

test('a task-scoped demotion does not leak either', () => {
  resetCooldowns();
  demoteModel({
    providerId: 'groq', model: 'qwen/qwen3.6-27b', apiKey: SECRETS.groq,
    task: 'coverLetter', reason: 'validation failed', chainLength: 3,
  });
  assertNoSecret(JSON.stringify(cooldownState()), 'a demotion cooldown');
});

test('rateWindowState never contains a credential', () => {
  resetRateWindows();
  reserveRateBudget({
    baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3.6-27b',
    apiKey: SECRETS.groq, messages: [{ role: 'user', content: 'hi' }], maxTokens: 512,
  });
  const state = rateWindowState();
  assert.ok(Object.keys(state).length > 0, 'the test needs a live window to inspect');
  assertNoSecret(JSON.stringify(state), 'rateWindowState()');
});

test('the error thrown when every provider fails does not leak', async () => {
  resetCooldowns();
  resetRateWindows();
  const impl = async () => fail(500, 'upstream exploded');
  const err = await chatWithRotation({
    chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl, sleepImpl: async () => {},
  }).then(() => null, (e) => e);

  assert.ok(err, 'the call should have failed');
  assertNoSecret(err.message, 'the aggregated error message');
  assertNoSecret(JSON.stringify(err.detail), "the error's attempt trail");
});

// --- the fingerprint itself ------------------------------------------------

test('a fingerprint is stable, short, and distinguishes different keys', () => {
  // Stability is what makes it usable as an identity; distinctness is what
  // makes per-credential cooldowns correct.
  assert.equal(credentialFingerprint(SECRETS.groq), credentialFingerprint(SECRETS.groq));
  assert.notEqual(credentialFingerprint(SECRETS.groq), credentialFingerprint(SECRETS.openrouter));
  assert.match(credentialFingerprint(SECRETS.groq), /^[0-9a-f]{8}$/);
});

test('two keys differing in one character fingerprint differently', () => {
  // The failure mode that would silently merge two users' quotas.
  const a = 'gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const b = 'gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab';
  assert.notEqual(credentialFingerprint(a), credentialFingerprint(b));
});

test('an absent key is represented, not crashed on', () => {
  assert.equal(credentialFingerprint(''), 'none');
  assert.equal(credentialFingerprint(undefined), 'none');
  assert.equal(credentialFingerprint(null), 'none');
});
