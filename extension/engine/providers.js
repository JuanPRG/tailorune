// providers.js — LLM provider registry.
//
// Ported from hirepilot_v4/config.py + llm.py's hardcoded specs. Only the base
// URLs and request/response shape matter here; the rotation/cooldown/rate-limit
// machinery those files also carry is Phase 4 in the migration plan, not needed
// for the vertical slice. Every provider here uses the same OpenAI-compatible
// `{base}/chat/completions` shape, confirmed at hirepilot_v4/llm.py:234-247 —
// simplifies this registry to one shared request builder instead of one per
// provider.

// `models` is ordered most-capable-first. Rotation walks a provider's models
// as separate chain entries, because on free tiers rate limits are commonly
// applied PER MODEL -- when gemini-2.5-flash is throttled, a lighter sibling
// often is not. Model pools mirror hirepilot_v4/config.py:64-73.
export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-3.1-flash-lite'],
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    models: ['gpt-oss-120b', 'zai-glm-4.7'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-oss-20b:free'],
  },
};

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
