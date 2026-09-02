// chainParity.test.mjs — the resolved chains must equal HirePilot v4's.
//
// These are not chosen numbers. They were MEASURED by loading the user's
// ~/.hirepilot/.env into os.environ and calling v4's own reporting function,
// `describe_provider_chain(task=...)` (hirepilot_v4/llm.py:2313), then
// dropping the terminal `local` entry Tailorune deliberately does not ship.
//
// v4 HAS TWO CHAIN PATHS, and Tailorune uses one for each kind of task,
// because measurement showed each is better where it is used:
//
//   THE CURATED PATH — the task names its own LLM_<TASK>_PROVIDER_CHAIN, and
//   v4 resolves it and applies that task's policy. Used here for coverLetter
//   and judge.
//
//   THE DEFAULT PATH — the task names no chain, so v4 falls back to
//   LLM_PROVIDER_CHAIN (whose plain provider names expand to whole *_MODELS
//   lists) and then applies the task's policy. Used here for resume and
//   skills, giving 7 eligible entries instead of 4.
//
// Why not the default path for prose too: `_task_specs` (llm.py:2299) returns
// None for any NON-resume task with no chain, so the caller falls back to the
// plain default client with NO POLICY APPLIED. Measured, the letter and judge
// chains then come back with twelve UNFILTERED entries reaching
// openai/gpt-oss-120b, gpt-oss-20b and nemotron -- precisely the models
// LLM_COVER_LETTER_EXCLUDED_MODELS rules out. Not deeper; just unfiltered.
//
// This file exists because a previous "alignment" drifted from 4 entries to
// 11 with no test noticing. The ORDER is the battle-tested part, so the order
// is what gets pinned. If a chain legitimately changes, re-measure against v4
// and update the constant -- do not relax the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChainEntries } from '../../extension/engine/rotatingClient.js';
import {
  PROVIDERS, ROUTES, TASK_CHAINS, DEPRECATED_MODEL_IDS, TASK_MODEL_POLICY,
} from '../../extension/engine/providers.js';

/** Every provider keyed, which is the configuration v4 was measured under. */
const ALL_KEYS = Object.keys(PROVIDERS).map((providerId) => ({ providerId, apiKey: `key-${providerId}` }));

const V4_CHAINS = {
  // v4, default path + resume_json policy. Its 8th entry was `local`.
  resume: [
    'gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b',
    'gemini-2.5-flash', 'openai/gpt-oss-20b', 'zai-glm-4.7',
  ],
  skills: [
    'gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b',
    'gemini-2.5-flash', 'openai/gpt-oss-20b', 'zai-glm-4.7',
  ],
  // v4, curated path. Its 4th entry was `local`.
  coverLetter: ['gemma-4-31b', 'qwen/qwen3.6-27b', 'gemini-3.1-flash-lite'],
  judge: ['qwen/qwen3.6-27b', 'gemma-4-31b', 'gemini-3.1-flash-lite'],
};

// The four models the curated resume chain names, which must stay at the FRONT
// of the deepened chain -- depth is added behind measured quality, never in
// place of it.
const MEASURED_RESUME_FOUR = [
  'gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b',
];

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
  //
  // And this is what the deepened chain buys: a Gemini-only user gets TWO
  // models rather than one, so a single throttled model no longer ends the
  // run. gemini-3.5-flash is absent because it is on the JSON exclusion list.
  const geminiOnly = [{ providerId: 'gemini', apiKey: 'k' }];
  assert.deepEqual(
    modelsOf(buildChainEntries(geminiOnly, { task: 'resume' })),
    ['gemini-3.1-flash-lite', 'gemini-2.5-flash'],
  );
});

test('the deepened resume chain still LEADS with the measured four, in order', () => {
  // The guarantee that makes the extra depth safe: the added models are
  // ranked strictly behind the curated ones by
  // LLM_RESUME_JSON_PREFERRED_MODELS, so they are reached only after the
  // measured models have actually failed.
  const models = modelsOf(buildChainEntries(ALL_KEYS, { task: 'resume' }));
  assert.deepEqual(models.slice(0, 4), MEASURED_RESUME_FOUR);
});

test('the prose chains are NOT deepened, because the default path drops their policy', () => {
  // Guards the asymmetry described in this file's header. If someone points
  // coverLetter or judge at DEFAULT_CHAIN, the exclusions silently stop
  // applying and prose starts landing on gpt-oss models.
  for (const task of ['coverLetter', 'judge']) {
    assert.equal(
      buildChainEntries(ALL_KEYS, { task }).length, 3,
      `${task} should stay curated at 3 entries`,
    );
  }
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
