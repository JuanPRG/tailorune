// providerChain.test.mjs — the number shown and the chain run must agree.
//
// Reported as "why does my extension say only one key when I have three".
//
// The header pill counted NON-EMPTY TEXT BOXES. The offscreen document built
// the chain from PROVIDERS, skipping any fallback key belonging to the
// provider already selected above:
//
//   if (id !== providerId && key) chain.push(...)
//
// Two different questions, two different answers, one number on screen. A
// fallback key for the selected provider inflated the count without adding any
// reach; a key for a provider that no longer exists -- Cerebras, still sitting
// in settings saved before it was dropped -- was counted by neither but looked
// present to the user.
//
// The fix is structural rather than arithmetic: one resolver, both callers.
// These tests pin the behaviour that made the two disagree, so a future change
// to either side has to keep them honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderChain, chainLabels, PROVIDERS } from '../../extension/engine/providers.js';

const labels = (args) => chainLabels(resolveProviderChain(args));

test('three distinct providers reach three providers', () => {
  assert.deepEqual(
    labels({ providerId: 'gemini', apiKey: 'a', providerKeys: { groq: 'b', openrouter: 'c' } }),
    ['Gemini', 'Groq', 'OpenRouter'],
  );
});

test('the selected provider always leads', () => {
  // Rotation order matters, and the user picked that provider deliberately.
  assert.deepEqual(
    labels({ providerId: 'openrouter', apiKey: 'a', providerKeys: { gemini: 'b', groq: 'c' } })[0],
    'OpenRouter',
  );
});

test('a fallback duplicating the selected provider adds nothing', () => {
  // THE OVERCOUNT. Same credential slot, not extra reach -- and the run has
  // always skipped it, so counting it was showing a number no run would honour.
  assert.deepEqual(
    labels({ providerId: 'gemini', apiKey: 'a', providerKeys: { gemini: 'a', groq: 'b' } }),
    ['Gemini', 'Groq'],
  );
});

test('a key for a provider that no longer exists is dropped', () => {
  // THE STALE-SETTINGS CASE. Cerebras was removed when it ended its no-card
  // free tier; a key for it can still be sitting in saved settings. It must
  // not be counted, because nothing can use it.
  assert.deepEqual(
    labels({ providerId: 'gemini', apiKey: 'a', providerKeys: { cerebras: 'stale', groq: 'b' } }),
    ['Gemini', 'Groq'],
  );
});

test('no primary key means the fallbacks are the whole chain', () => {
  // A user who fills only the fallback list still gets a working run, and the
  // pill should say so rather than claiming nothing is configured.
  assert.deepEqual(
    labels({ providerId: 'gemini', apiKey: '', providerKeys: { groq: 'b', openrouter: 'c' } }),
    ['Groq', 'OpenRouter'],
  );
});

test('whitespace is not a key', () => {
  assert.deepEqual(labels({ providerId: 'gemini', apiKey: '   ', providerKeys: { groq: '\t' } }), []);
});

test('nothing configured resolves to nothing, without throwing', () => {
  assert.deepEqual(resolveProviderChain({}), []);
  assert.deepEqual(resolveProviderChain(), []);
  assert.deepEqual(chainLabels(undefined), []);
});

test('an explicit model pins the first entry only', () => {
  // A pinned model is a statement about the provider the user chose, not
  // about whatever the run falls back to.
  const chain = resolveProviderChain({
    providerId: 'gemini', apiKey: 'a', model: 'gemini-2.5-flash',
    providerKeys: { groq: 'b' },
  });
  assert.equal(chain[0].model, 'gemini-2.5-flash');
  assert.equal(chain[1].model, undefined);
});

test('an empty model string does not become a pin', () => {
  // The popup's model field is empty by default, and an empty pin would
  // resolve to a chain of one nonexistent model.
  const [first] = resolveProviderChain({ providerId: 'gemini', apiKey: 'a', model: '   ' });
  assert.equal(first.model, undefined);
});

test('keys are trimmed, because a pasted key often carries whitespace', () => {
  const [first] = resolveProviderChain({ providerId: 'gemini', apiKey: '  abc \n' });
  assert.equal(first.apiKey, 'abc');
});

test('every provider in the registry can lead a chain', () => {
  // Guards the case that started this: a provider removed from PROVIDERS but
  // left selectable, or vice versa.
  for (const id of Object.keys(PROVIDERS)) {
    assert.deepEqual(
      resolveProviderChain({ providerId: id, apiKey: 'k' }).map((e) => e.providerId),
      [id],
      `${id} should be able to run on its own`,
    );
  }
});
