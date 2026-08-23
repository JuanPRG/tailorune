// providers.js — LLM provider registry.
//
// Ported from hirepilot_v4/config.py + llm.py's hardcoded specs. Only the base
// URLs and request/response shape matter here; the rotation/cooldown/rate-limit
// machinery those files also carry is Phase 4 in the migration plan, not needed
// for the vertical slice. Every provider here uses the same OpenAI-compatible
// `{base}/chat/completions` shape, confirmed at hirepilot_v4/llm.py:234-247 —
// simplifies this registry to one shared request builder instead of one per
// provider.

export const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
  },
  cerebras: {
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'gpt-oss-120b',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-oss-20b:free',
  },
};

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, defaultModel: p.defaultModel }));
}

export function getProvider(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
