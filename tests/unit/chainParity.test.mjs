// chainParity.test.mjs — the resolved chains, pinned so they cannot drift.
//
// TWO SOURCES OF TRUTH, and it matters which is which.
//
// The STRUCTURE is HirePilot v4's, measured by loading ~/.hirepilot/.env into
// os.environ and calling v4's own `describe_provider_chain(task=...)`
// (hirepilot_v4/llm.py:2313), minus the terminal `local` entry Tailorune does
// not ship. v4 has two chain paths and Tailorune uses one for each kind of
// task:
//
//   THE CURATED PATH — the task names its own LLM_<TASK>_PROVIDER_CHAIN, and
//   v4 resolves it and applies that task's policy. Used for coverLetter and
//   judge.
//
//   THE DEFAULT PATH — the task names none, so v4 falls back to
//   LLM_PROVIDER_CHAIN (whose plain provider names expand to whole *_MODELS
//   lists) and applies the policy to that. Used for resume and skills.
//
// Why not the default path for prose too: `_task_specs` (llm.py:2299) returns
// None for any NON-resume task with no chain, so the caller falls back to the
// plain default client with NO POLICY APPLIED. Measured, the letter and judge
// chains then come back with twelve UNFILTERED entries reaching
// openai/gpt-oss-120b, gpt-oss-20b and nemotron -- precisely the models
// LLM_COVER_LETTER_EXCLUDED_MODELS rules out. Not deeper; just unfiltered.
//
// The MODEL LIST is no longer v4's. Models churn -- Groq deprecated
// qwen/qwen3.6-27b with twelve days' notice, OpenRouter withdrew ling-3.0 from
// its free tier -- so the list is re-measured with tests/live/modelBench.mjs
// and pinned here. Same kind of claim, newer evidence.
//
// This file exists because a previous "alignment" drifted from 4 entries to 11
// with no test noticing. The ORDER is the load-bearing part, so the order is
// what gets pinned. If a chain legitimately changes, re-run the benchmark and
// update the constant -- do not relax the assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChainEntries } from '../../extension/engine/rotatingClient.js';
import {
  PROVIDERS, ROUTES, TASK_CHAINS, DEPRECATED_MODEL_IDS, TASK_MODEL_POLICY,
} from '../../extension/engine/providers.js';

/** Every provider keyed, which is the configuration v4 was measured under. */
const ALL_KEYS = Object.keys(PROVIDERS).map((providerId) => ({ providerId, apiKey: `key-${providerId}` }));

// The STRUCTURE below is still v4's -- the default-chain path for the JSON
// passes, the curated path for prose, each with its own policy. The MODEL LIST
// is not, and stopped being so on 2026-09-02:
//
//   - Groq deprecated qwen/qwen3.6-27b (decommission 2026-09-14), which sat
//     second in the resume chain and first in the judge chain. Replaced by
//     qwen/qwen3.8-27b, which benchmarked strictly better: 1.1s against
//     25-39s, at equal or higher concreteness.
//   - gemini-3.5-flash-lite and minimax/minimax-m2.7:free were added on
//     measured evidence (tests/live/modelBench.mjs, three passes each).
//
// So this file no longer asserts "identical to v4". It asserts the ordering
// the benchmark produced, which is the same KIND of claim -- a measured chain,
// pinned so it cannot drift unnoticed -- against a newer measurement. Re-run
// `npm run bench:models` before changing any of it.
const EXPECTED_CHAINS = {
  resume: [
    'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b', 'minimax/minimax-m2.7:free',
    'gemini-2.5-flash', 'openai/gpt-oss-20b',
  ],
  skills: [
    'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b', 'minimax/minimax-m2.7:free',
    'gemini-2.5-flash', 'openai/gpt-oss-20b',
  ],
  // Curated, and rebuilt from a PROSE benchmark when Cerebras was dropped.
  // qwen is the fastest of the three and goes last anyway: it ran over the
  // 275-word ceiling on 3 of 3 attempts (292, 300, 302 words).
  coverLetter: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'qwen/qwen3.8-27b'],
  // The judge emits JSON, so it is ordered on schema reliability instead:
  // 3.1-flash-lite held the schema 3/3, 3.5-flash-lite returned one
  // unparseable answer.
  judge: ['gemini-3.1-flash-lite', 'qwen/qwen3.8-27b', 'gemini-3.5-flash-lite'],
};

// The models the benchmark ranked highest for JSON, which must stay at the
// FRONT of the resume chain. Depth is added behind measured quality, never in
// place of it.
//
// flash-lite leads on RELIABILITY rather than score -- 63% concreteness, but
// the only candidate that returned a usable resume on all three runs. The
// leader is the position where a malformed answer costs a retry the user sits
// through, so it is the one place to prefer the steady model over the strong
// one. gemini-3.5-flash-lite scores 90% and is second for exactly that reason:
// one of its three runs came back unparseable.
const BENCHMARK_TOP_THREE = [
  'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'qwen/qwen3.8-27b',
];

const modelsOf = (entries) => entries.map((e) => e.model);

for (const [task, expected] of Object.entries(EXPECTED_CHAINS)) {
  test(`${task} resolves to the benchmarked chain, exactly and in order`, () => {
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
  // And this is what the deepened chain buys: a Gemini-only user gets THREE
  // models rather than one, so a throttled model no longer ends the run.
  // gemini-3.5-flash is absent because it is on the JSON exclusion list --
  // note that is the FLASH, not the flash-LITE sitting at position two.
  const geminiOnly = [{ providerId: 'gemini', apiKey: 'k' }];
  assert.deepEqual(
    modelsOf(buildChainEntries(geminiOnly, { task: 'resume' })),
    ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'],
  );
});

test('the resume chain LEADS with the benchmark top three, in order', () => {
  // The guarantee that makes the extra depth safe: everything else is ranked
  // strictly behind these, so the slower or less reliable models are reached
  // only after the best ones have actually failed.
  const models = modelsOf(buildChainEntries(ALL_KEYS, { task: 'resume' }));
  assert.deepEqual(models.slice(0, 3), BENCHMARK_TOP_THREE);
});

test('no chain names the model Groq is decommissioning', () => {
  // Groq deprecated qwen/qwen3.6-27b on 2026-09-02 and decommissions it on
  // 2026-09-14. It was second in the resume chain and first in the judge
  // chain, so a miss here is a broken run for every user on that date.
  for (const task of Object.keys(TASK_CHAINS)) {
    const reached = modelsOf(buildChainEntries(ALL_KEYS, { task }));
    assert.ok(!reached.includes('qwen/qwen3.6-27b'), `${task} still reaches the decommissioned model`);
  }
});

test('OpenRouter can actually tailor a resume now', () => {
  // It could not, until minimax-m2.7:free was added: every previously
  // configured OpenRouter model is retired, excluded or 404, so an
  // OpenRouter-only user got a provider_configuration_error on every run.
  const orOnly = [{ providerId: 'openrouter', apiKey: 'k' }];
  assert.deepEqual(modelsOf(buildChainEntries(orOnly, { task: 'resume' })), ['minimax/minimax-m2.7:free']);
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
    [{ providerId: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash' }],
    { task: 'resume' },
  );
  // gemini-3.5-flash is on the JSON exclusion list, yet it was asked for by
  // name -- so it is honoured anyway. Note that is the FLASH, not the
  // flash-LITE that leads the prose chain.
  assert.deepEqual(modelsOf(pinned), ['gemini-3.5-flash']);
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

test('no route names a provider that was removed', () => {
  // Cerebras was dropped when it ended its no-card free tier on 2026-08-17.
  // A route left behind would name a provider that getProvider() throws on,
  // and a CHAIN left naming a dead route silently shortens instead -- which
  // happened during the removal and was caught only by reading the resolved
  // chain. The "every chain names a route that exists" test above is the
  // permanent guard; this one pins the provider list itself.
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['gemini', 'groq', 'openrouter']);
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.notEqual(route.providerId, 'cerebras', `route "${name}" still names Cerebras`);
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
