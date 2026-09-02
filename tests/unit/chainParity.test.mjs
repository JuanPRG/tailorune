// chainParity.test.mjs — the resolved chains must equal HirePilot v4's.
//
// These are not chosen numbers. They were MEASURED by loading the user's
// ~/.hirepilot/.env into os.environ and calling v4's own reporting function,
// `describe_provider_chain(task=...)` (hirepilot_v4/llm.py:2313), then
// dropping the terminal `local` entry that Tailorune deliberately does not
// ship:
//
//   resume_json   gemini-3.1-flash-lite, qwen/qwen3.6-27b,
//                 openai/gpt-oss-120b, gpt-oss-120b, [local]
//   cover_letter  gemma-4-31b, qwen/qwen3.6-27b, gemini-3.1-flash-lite, [local]
//   judge         qwen/qwen3.6-27b, gemma-4-31b, gemini-3.1-flash-lite, [local]
//
// This file exists because a previous "alignment" of the rotation drifted from
// 4 entries to 11 without any test noticing. Every extra entry was a real
// route from the .env, which is exactly why it looked correct -- but no v4
// task chain contains them, so they had never been exercised for the task they
// were being handed. A count assertion alone would not have caught it either;
// the ORDER is the battle-tested part, so the order is what gets pinned.
//
// If a chain legitimately changes, re-measure against v4 and update the
// constant. Do not relax the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChainEntries } from '../../extension/engine/rotatingClient.js';
import {
  PROVIDERS, ROUTES, TASK_CHAINS, DEPRECATED_MODEL_IDS, TASK_MODEL_POLICY,
} from '../../extension/engine/providers.js';

/** Every provider keyed, which is the configuration v4 was measured under. */
const ALL_KEYS = Object.keys(PROVIDERS).map((providerId) => ({ providerId, apiKey: `key-${providerId}` }));

const V4_CHAINS = {
  resume: ['gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b'],
  skills: ['gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b'],
  coverLetter: ['gemma-4-31b', 'qwen/qwen3.6-27b', 'gemini-3.1-flash-lite'],
  judge: ['qwen/qwen3.6-27b', 'gemma-4-31b', 'gemini-3.1-flash-lite'],
};

const modelsOf = (entries) => entries.map((e) => e.model);

for (const [task, expected] of Object.entries(V4_CHAINS)) {
  test(`${task} resolves to v4's chain, exactly and in order`, () => {
    assert.deepEqual(modelsOf(buildChainEntries(ALL_KEYS, { task })), expected);
  });
}

test('no task chain reaches a model that task excludes', () => {
  // The gap that let a cover letter land on gpt-oss-120b: the preferred list
  // was ported and the excluded list was left as [].
  for (const [task, policy] of Object.entries(TASK_MODEL_POLICY)) {
    const reached = modelsOf(buildChainEntries(ALL_KEYS, { task }));
    const violations = reached.filter((m) => policy.excluded.includes(m));
    assert.deepEqual(violations, [], `${task} reached excluded model(s): ${violations.join(', ')}`);
  }
});

test('no chain reaches a retired model', () => {
  for (const task of Object.keys(TASK_CHAINS)) {
    const retired = modelsOf(buildChainEntries(ALL_KEYS, { task }))
      .filter((m) => DEPRECATED_MODEL_IDS.has(m));
    assert.deepEqual(retired, [], `${task} reached retired model(s): ${retired.join(', ')}`);
  }
});

test('a route whose provider has no key is skipped, not an error', () => {
  // llm.py:2088 logs and continues. A user with one key is a normal case, not
  // a misconfiguration, so it must not raise.
  const geminiOnly = [{ providerId: 'gemini', apiKey: 'k' }];
  assert.deepEqual(modelsOf(buildChainEntries(geminiOnly, { task: 'resume' })), ['gemini-3.1-flash-lite']);
});

test('OpenRouter alone cannot do resumes, and says so — the cliff created by dropping local', () => {
  // Recorded rather than worked around. All three models on the .env's
  // LLM_PROVIDER_OPENROUTER_MODELS are either retired (ling) or on the JSON
  // exclusion list, so v4 reports ZERO openrouter entries for every task. v4
  // never hit this wall because `local` always terminated the chain; without
  // it, an OpenRouter-only user has nothing to run.
  //
  // If this ever needs fixing, the .env already holds the answer:
  // LLM_PROVIDER_OPENROUTER_QWEN_CODER_MODEL=qwen/qwen3-coder:free is a live
  // alias that no task chain references. Adding it to the openrouter route
  // would be a deliberate step BEYOND v4, so it is not taken here.
  //
  // v4's asymmetry does the right thing here: because resume is a strict task,
  // the user gets a specific configuration error instead of a silent empty
  // chain or a mysterious "all providers failed" at the end of a long run.
  const orOnly = [{ providerId: 'openrouter', apiKey: 'k' }];
  assert.throws(
    () => buildChainEntries(orOnly, { task: 'resume' }),
    (err) => err.kind === 'provider_configuration_error' && /excluded for resume/.test(err.message),
  );
});

test('OpenRouter alone CAN write a cover letter — prose keeps the unfiltered chain', () => {
  // The other half of llm.py:2280's asymmetry. The letter chain does not name
  // an openrouter route at all, so there is nothing to retain and the caller
  // gets the empty-chain error from chatWithRotation rather than a raise here.
  const orOnly = [{ providerId: 'openrouter', apiKey: 'k' }];
  assert.deepEqual(modelsOf(buildChainEntries(orOnly, { task: 'coverLetter' })), []);
});

test('the prose chains never include OpenRouter at all', () => {
  // Distinct from the above: the resume chain names the openrouter route and
  // it contributes nothing; the letter and judge chains do not name it.
  for (const task of ['coverLetter', 'judge']) {
    const named = TASK_CHAINS[task].filter((name) => ROUTES[name].providerId === 'openrouter');
    assert.deepEqual(named, [], `${task} should not name an openrouter route`);
  }
});

test('an explicitly pinned model wins, and is exempt from task policy', () => {
  // llm.py's `preferred_provider` hoists one entry to the front of the order.
  // A user who names a model has made a choice; honour it rather than
  // silently substituting one the policy table prefers.
  const pinned = buildChainEntries(
    [{ providerId: 'cerebras', apiKey: 'k', model: 'gemma-4-31b' }],
    { task: 'resume' },
  );
  // gemma-4-31b is on the JSON exclusion list, yet it was asked for by name.
  assert.deepEqual(modelsOf(pinned), ['gemma-4-31b']);
});

test('every route names a provider that exists', () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.ok(PROVIDERS[route.providerId], `route "${name}" names unknown provider "${route.providerId}"`);
    assert.ok(route.models.length > 0, `route "${name}" has no models`);
  }
});

test('every chain names a route that exists', () => {
  for (const [task, chain] of Object.entries(TASK_CHAINS)) {
    for (const name of chain) {
      assert.ok(ROUTES[name], `${task} chain names unknown route "${name}"`);
    }
  }
});

test('no route points at a local endpoint', () => {
  // The product decision, asserted so it cannot creep back in via a route
  // addition: shipping one would require a localhost host permission.
  for (const [name, route] of Object.entries(ROUTES)) {
    const { baseUrl } = PROVIDERS[route.providerId];
    assert.doesNotMatch(
      baseUrl, /localhost|127\.0\.0\.1|host\.docker\.internal/,
      `route "${name}" points at a local endpoint`,
    );
  }
});
