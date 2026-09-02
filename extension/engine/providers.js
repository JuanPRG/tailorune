// providers.js — LLM provider registry.
//
// Ported from hirepilot_v4/config.py + llm.py's hardcoded specs. Only the base
// URLs and request/response shape matter here; the rotation/cooldown/rate-limit
// machinery those files also carry is Phase 4 in the migration plan, not needed
// for the vertical slice. Every provider here uses the same OpenAI-compatible
// `{base}/chat/completions` shape, confirmed at hirepilot_v4/llm.py:234-247 —
// simplifies this registry to one shared request builder instead of one per
// provider.

// `models` is ordered best-first. Rotation walks a provider's models as
// separate chain entries, because on free tiers rate limits are commonly
// applied PER MODEL -- when one model is throttled, a sibling often is not.
//
// THE ORDER AND MEMBERSHIP HERE ARE NOT A GUESS. They mirror the rotation in
// the user's own ~/.hirepilot/.env, which is the battle-tested list -- earned
// from real usage, and the authority when the two disagree. Specifically its
// LLM_RESUME_JSON_PREFERRED_MODELS ordering, and its
// LLM_RESUME_JSON_EXCLUDED_MODELS, since the resume pass is the strictest
// consumer and a model unfit for it must not sit in a shared pool.
//
// An earlier version of this file WAS a guess, and it cost real time:
//
//   - `gemini-2.5-flash` was listed FIRST. It is a thinking model; live runs
//     spent 13-25 seconds per resume call on it and truncated mid-JSON. The
//     .env has it LAST, behind gemini-3.1-flash-lite. A whole debugging
//     session went into rediscovering what that ordering already encoded.
//   - `openai/gpt-oss-20b:free` was the only OpenRouter route here, and it is
//     on the .env's EXCLUDED list. A live run used it.
//   - `qwen/qwen3.6-27b` was missing entirely, though the .env ranks it second
//     for resumes and first for the judge.
//
// When the .env's rotation changes, this list is what needs updating to match.
// A Chrome extension cannot read a file from disk, so the values are baked in;
// that makes this the one place to edit, not a place to improvise.
export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // flash-lite first: measured faster and it does not truncate.
    // gemini-3.5-flash is defined in the .env but sits on its EXCLUDED list,
    // so it is absent here rather than pooled and filtered.
    models: ['gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-flash-lite-latest'],
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    // gemma-4-31b is pooled but EXCLUDED for the JSON passes -- see
    // TASK_MODEL_POLICY. The .env prefers it for cover letters and rules it
    // out for resume JSON, which is exactly why per-task policy exists.
    models: ['gpt-oss-120b', 'gemma-4-31b', 'zai-glm-4.7'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Only the routes the .env still considers live: its nemotron and
    // gpt-oss-20b:free entries are on the EXCLUDED list, and its qwen-next
    // route is commented "Retired unavailable".
    models: [
      'inclusionai/ling-3.0-flash:free',
      'openai/gpt-oss-120b:free',
      'qwen/qwen3-coder:free',
    ],
  },
};

// LLM_RESUME_JSON_EXCLUDED_MODELS. Models real usage has ruled out for strict
// JSON work -- kept verbatim so a future edit can be checked against what was
// already learned the hard way.
const JSON_EXCLUDED_MODELS = [
  'gemini-3.5-flash',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'gemma-4-31b',
];

// LLM_RESUME_JSON_PREFERRED_MODELS.
const JSON_PREFERRED_MODELS = [
  'gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b',
  'gpt-oss-120b', 'inclusionai/ling-3.0-flash:free', 'gemini-2.5-flash',
];

/**
 * Which model suits which TASK — the knowledge a single shared pool cannot
 * hold, mirrored from the .env's per-task chains.
 *
 * `gemma-4-31b` is why this exists: the .env EXCLUDES it for resume JSON and
 * PREFERS it for cover letters. One ordering cannot say both, so a shared
 * chain either denies the letter its best model or hands the resume pass a
 * model already found unfit for structured output.
 *
 * `preferred` reorders; `excluded` removes. A model absent from `preferred` is
 * still usable, just last — being unranked is not a veto, only `excluded` is.
 */
export const TASK_MODEL_POLICY = {
  // Both JSON passes share the resume policy: same shape of work, same
  // failure mode when a model cannot hold a schema.
  resume: { preferred: JSON_PREFERRED_MODELS, excluded: JSON_EXCLUDED_MODELS },
  skills: { preferred: JSON_PREFERRED_MODELS, excluded: JSON_EXCLUDED_MODELS },
  // LLM_COVER_LETTER_PREFERRED_MODELS — prose, so gemma leads.
  coverLetter: { preferred: ['gemma-4-31b', 'qwen/qwen3.6-27b', 'gemini-3.1-flash-lite'], excluded: [] },
  // LLM_JUDGE_PREFERRED_MODELS
  judge: { preferred: ['qwen/qwen3.6-27b', 'gemma-4-31b', 'gemini-3.1-flash-lite'], excluded: [] },
};

/** @returns {{preferred: string[], excluded: string[]}|null} */
export function taskPolicy(task) {
  return (task && TASK_MODEL_POLICY[task]) || null;
}

/** The model used when the user hasn't named one. */
export function defaultModelFor(providerId) {
  return getProvider(providerId).models[0];
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, models: [...p.models] }));
}

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
