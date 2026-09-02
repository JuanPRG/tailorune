// providers.js — LLM provider registry, routes, and per-task chains.
//
// Ported from hirepilot_v4/llm.py. The shape here mirrors v4's, because the
// mechanism is the thing that was battle-tested, not just the model names:
//
//   PROVIDERS  -> one entry per HTTP endpoint (llm.py's base_url + api_key)
//   ROUTES     -> llm.py's LLM_PROVIDER_<NAME>_* registry aliases. One route
//                 names one provider and the model(s) that alias resolves to.
//   TASK_CHAINS-> llm.py's LLM_<TASK>_PROVIDER_CHAIN. An ORDERED list of route
//                 names, curated per task.
//
// WHY ROUTES AND CHAINS RATHER THAN POOLS. An earlier version of this file
// held a `models` array per provider, unioned every model into it, interleaved
// the pools and re-ranked by preference. That produced chains of 11-12 entries
// where v4 walks 4. The extra entries were real routes from the .env, but no
// v4 task chain contains them -- so they had never been exercised for the task
// they were being handed. `zai-glm-4.7` writing resume JSON and
// `qwen/qwen3-coder:free` writing a cover letter are not battle-tested
// behaviours; they are inventions that looked like fidelity.
//
// A curated chain is the whole point: the ordering encodes which model was
// measured to be good at which task, and depth past the curated list is
// depth nobody validated. v4's own answer for a thin chain is not "reach for
// an unproven model" -- it is to retry the proven one with backoff, which is
// what llm.py's `_single_attempt = len(clients) > 1` expresses.
//
// Verified against v4's own `describe_provider_chain(task=...)` with the
// user's ~/.hirepilot/.env loaded. See tests/unit/chainParity.test.mjs, which
// pins the resolved chains so this file cannot drift back into a pool union.
//
// NO LOCAL ROUTE. Every v4 chain ends with `local` (Ollama on :11434). It is
// deliberately absent here: reaching it needs a `http://localhost:11434/*`
// host permission, and the product decision was to not ship that. The
// consequence is that a chain which exhausts its hosted routes fails, where
// v4 would have fallen through to a local model. That is a known, accepted
// difference -- not an oversight.

export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
};

// llm.py:252. Models the provider has removed are filtered even when they are
// still named in a user's config, so a fresh session does not spend one
// guaranteed 404 discovering it. Note this beats the .env: the file still
// lists ling-3.0-flash:free in LLM_RESUME_JSON_PREFERRED_MODELS, and v4 drops
// it at load anyway. Ranking a retired model is harmless -- it simply never
// produces an entry to rank.
export const DEPRECATED_MODEL_IDS = new Set([
  'inclusionai/ling-3.0-flash',
  'inclusionai/ling-3.0-flash:free',
  // Groq deprecated this 2026-09-02 and decommissions it 2026-09-14, routing
  // it to qwen3.8-27b afterwards. Retired here rather than left to 404,
  // because it sat SECOND in the resume chain and FIRST in the judge chain --
  // and because benchmarking found the replacement strictly better: 1.1s
  // against 25-39s, at equal or better concreteness.
  'qwen/qwen3.6-27b',
]);

/**
 * Registry aliases, mirroring the .env's LLM_PROVIDER_<NAME>_MODEL(S).
 *
 * A route with ONE model is the common case and is what makes a chain
 * curated: the chain says "this model, from this provider, at this position".
 * `models` (plural) mirrors an alias that defines the _MODELS csv instead of
 * a single _MODEL -- only `openrouter` does, and llm.py:2003 reads _MODELS in
 * preference to _MODEL when both exist.
 */
export const ROUTES = {
  // LLM_PROVIDER_GEMINI31_FLASH_LITE_* — ".env: passed the real resume JSON
  // probe quickly and is pinned."
  gemini31_flash_lite: { providerId: 'gemini', models: ['gemini-3.1-flash-lite'] },
  // LLM_PROVIDER_GROQ_QWEN36_*, now pointing at the successor model.
  groq_qwen: { providerId: 'groq', models: ['qwen/qwen3.8-27b'] },
  // LLM_PROVIDER_GROQ_OSS120_*
  groq_oss120: { providerId: 'groq', models: ['openai/gpt-oss-120b'] },
  // Replaces the retired cerebras_gemma as the prose leader. Benchmarked as
  // the best letter writer available: 3/3 usable at 1.7s, and the only
  // candidate that reliably stays under the word ceiling.
  gemini35_flash_lite: { providerId: 'gemini', models: ['gemini-3.5-flash-lite'] },
  // --- pool routes -------------------------------------------------------
  //
  // The plain provider names from LLM_PROVIDER_CHAIN. Unlike the pinned
  // aliases above, each resolves to that provider's whole *_MODELS list, which
  // is what gives the default chain its depth. llm.py:2003 reads _MODELS in
  // preference to a single _MODEL when both exist.

  // GEMINI_MODELS, plus gemini-3.5-flash-lite which the benchmark added: it
  // kept 90% of the original concreteness against the incumbent leader's 63%,
  // over three runs. It is NOT the leader, because one of those three came
  // back as unparseable JSON -- so it is ranked second, where a malformed
  // answer costs a rotation rather than the run.
  gemini: {
    providerId: 'gemini',
    models: [
      'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
      'gemini-3.5-flash', 'gemini-2.5-flash',
    ],
  },
  // GROQ_MODELS
  groq: {
    providerId: 'groq',
    models: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  // LLM_PROVIDER_OPENROUTER_MODELS. Kept verbatim, and worth reading closely:
  // ling is RETIRED and the other two are on the JSON exclusion list, so this
  // route contributes ZERO eligible entries to the resume tasks -- confirmed
  // against v4, which reports 0 openrouter entries for them. It stays because
  // the chain does, and because deleting it would hide that rather than
  // record it.
  openrouter: {
    providerId: 'openrouter',
    models: [
      // The one live free route, and the reason OpenRouter is no longer dead
      // weight. Every previously configured OpenRouter model is retired,
      // excluded or 404 -- an OpenRouter-only user could not tailor at all.
      // Benchmarked at the HIGHEST concreteness of any candidate (92% over
      // three runs) but also the slowest (10-19s), so it earns a place as
      // depth rather than as anyone's leader.
      'minimax/minimax-m2.7:free',
      'inclusionai/ling-3.0-flash:free',
      'openai/gpt-oss-20b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
    ],
  },
};

/**
 * LLM_PROVIDER_CHAIN, minus its terminal `local`.
 *
 * Each name is a POOL route, so this expands to eleven entries interleaved by
 * model index -- every provider's best model first, then every provider's
 * second, and so on. That interleave is the point: a key-level limit on one
 * provider does not burn all three of its models before another provider is
 * tried.
 */
export const DEFAULT_CHAIN = ['gemini', 'groq', 'openrouter'];

/**
 * LLM_<TASK>_PROVIDER_CHAIN, in order, with the terminal `local` route
 * dropped per the product decision above.
 *
 * `skills` has no v4 counterpart -- it is Tailorune's second JSON pass, so it
 * takes the resume chain and the resume policy: same shape of work, same
 * failure mode when a model cannot hold a schema.
 */
export const TASK_CHAINS = {
  // The JSON passes take the DEFAULT chain, filtered and ranked by their own
  // policy -- llm.py:2299's `_task_specs` branch for when a task names no
  // chain of its own. Seven eligible entries instead of the four the curated
  // LLM_RESUME_JSON_PROVIDER_CHAIN gives, because failover depth is worth
  // more here than curation: every added model is still filtered by
  // LLM_RESUME_JSON_EXCLUDED_MODELS and ranked behind the measured four.
  //
  // Verified to equal v4's own output for this path -- see chainParity.
  resume: DEFAULT_CHAIN,
  skills: DEFAULT_CHAIN,

  // Prose and judging keep their CURATED chains, and the reason is a real
  // asymmetry in v4 rather than a preference.
  //
  // `_task_specs` returns None for any non-resume task that names no chain,
  // so the caller falls back to the plain default client with NO TASK POLICY
  // APPLIED AT ALL. Measured: the letter and judge chains then come back with
  // twelve unfiltered entries, reaching openai/gpt-oss-120b, gpt-oss-20b and
  // nemotron -- the exact models LLM_COVER_LETTER_EXCLUDED_MODELS rules out
  // for prose. For these two tasks the broad chain is not deeper, it is
  // simply unfiltered, which is why the .env configures them explicitly.
  //
  // Rebuilt when Cerebras was dropped, from a prose benchmark rather than by
  // shuffling whatever was left. Three real letters per model:
  //
  //   gemini-3.5-flash-lite  3/3 approved  1.7s  226-246 words
  //   gemini-3.1-flash-lite  3/3 approved  3.1s  245-261 words
  //   qwen/qwen3.8-27b       0/3           0.9s  292-302 words  <- always over
  //
  // qwen is the fastest and still goes last, because it ran over the 275-word
  // ceiling on every attempt. That was the "cover letter above maximum"
  // finding recurring in live runs: the chain led with a dead Cerebras model
  // and fell through to one that writes long.
  coverLetter: ['gemini35_flash_lite', 'gemini31_flash_lite', 'groq_qwen'],
  // The judge returns JSON, not prose, so it is ordered on schema reliability
  // instead: 3.1-flash-lite held the schema on all three runs, while
  // 3.5-flash-lite returned one unparseable answer.
  judge: ['gemini31_flash_lite', 'groq_qwen', 'gemini35_flash_lite'],
};

/** LLM_RESUME_JSON_EXCLUDED_MODELS — ruled out for strict JSON work. */
const JSON_EXCLUDED_MODELS = [
  'gemini-3.5-flash',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

/** LLM_RESUME_JSON_PREFERRED_MODELS. */
const JSON_PREFERRED_MODELS = [
  // Order re-measured 2026-09-02 with tests/live/modelBench.mjs: three real
  // tailoring passes per model, ranked by concreteness kept.
  //
  //   gemini-3.1-flash-lite   63%  2.8s   3/3 approved  <- most reliable
  //   gemini-3.5-flash-lite   90%  6.1s   2/3           <- best quality
  //   qwen/qwen3.8-27b        75%  1.1s   2/3           <- fastest by far
  //   openai/gpt-oss-20b      75%  6.6s   1/3
  //   minimax-m2.7:free       92%  9.9s   1/3           <- best, and slowest
  //
  // flash-lite keeps the lead on reliability rather than score: it is the only
  // candidate that returned a usable resume every time, and the leader is the
  // position where a malformed answer costs a retry the user waits through.
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-120b',
  'minimax/minimax-m2.7:free',
  'gemini-2.5-flash',
];

// LLM_COVER_LETTER_EXCLUDED_MODELS and LLM_JUDGE_EXCLUDED_MODELS are the same
// list in the .env, under the comment "Task-specific chains exclude models
// that failed isolated prose/judge probes." It is one model longer than v4's
// code default (_PROSE_JUDGE_EXCLUDED_MODELS, llm.py:2211) because the .env
// adds ling -- and the .env wins, since v4 reads the env over the default.
//
// Most of these are unreachable given the curated prose chains above, which
// name only three routes. They are kept because an exclusion documents a
// measurement: if someone later adds gpt-oss to the letter chain, this list
// is what says the probe already rejected it.
const PROSE_JUDGE_EXCLUDED_MODELS = [
  'inclusionai/ling-3.0-flash:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
];

/**
 * Which model suits which TASK — llm.py:2226's `_apply_task_model_policy`.
 *
 * Per-task policy exists because one ordering cannot describe two jobs. The
 * sharpest case used to be gemma-4-31b -- excluded for resume JSON, preferred
 * for letters -- and it outlived gemma's removal: qwen/qwen3.8-27b now ranks
 * high for resumes on speed and LAST for letters, because it runs over the
 * word ceiling every time.
 *
 * `preferred` reorders; `excluded` removes. A model absent from `preferred` is
 * still usable, just last — being unranked is not a veto, only `excluded` is.
 */
export const TASK_MODEL_POLICY = {
  resume: { preferred: JSON_PREFERRED_MODELS, excluded: JSON_EXCLUDED_MODELS },
  skills: { preferred: JSON_PREFERRED_MODELS, excluded: JSON_EXCLUDED_MODELS },
  // LLM_COVER_LETTER_PREFERRED_MODELS — prose, so gemma leads.
  coverLetter: {
    preferred: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'qwen/qwen3.8-27b'],
    excluded: PROSE_JUDGE_EXCLUDED_MODELS,
  },
  // LLM_JUDGE_PREFERRED_MODELS
  judge: {
    preferred: ['gemini-3.1-flash-lite', 'qwen/qwen3.8-27b', 'gemini-3.5-flash-lite'],
    excluded: PROSE_JUDGE_EXCLUDED_MODELS,
  },
};

/**
 * llm.py:2226 raises for the resume tasks when exclusions match every
 * configured model, but only warns and keeps the unfiltered chain for prose
 * and judge. The asymmetry is deliberate: a resume built by a model known to
 * break structured output is worse than no resume, while a slightly-off cover
 * letter still beats nothing.
 */
export const STRICT_EXCLUSION_TASKS = new Set(['resume', 'skills']);

/** @returns {{preferred: string[], excluded: string[]}|null} */
export function taskPolicy(task) {
  return (task && TASK_MODEL_POLICY[task]) || null;
}

/** @returns {string[]} route names for a task, or [] when the task is unknown. */
export function taskChain(task) {
  return (task && TASK_CHAINS[task]) ? [...TASK_CHAINS[task]] : [];
}

/**
 * Every model a provider can be asked for, derived from ROUTES so there is
 * one source of truth. Used by the UI's model picker and by release checks --
 * NOT by chain construction, which walks TASK_CHAINS.
 */
export function modelsForProvider(providerId) {
  const models = [];
  for (const route of Object.values(ROUTES)) {
    if (route.providerId !== providerId) continue;
    for (const model of route.models) {
      if (!DEPRECATED_MODEL_IDS.has(model) && !models.includes(model)) models.push(model);
    }
  }
  return models;
}

/** The model used when the user hasn't named one. */
export function defaultModelFor(providerId) {
  const models = modelsForProvider(providerId);
  if (!models.length) throw new Error(`Provider has no usable models: ${providerId}`);
  return models[0];
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, models: modelsForProvider(id),
  }));
}

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
