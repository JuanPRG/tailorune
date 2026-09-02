// llm.js — single-provider LLM chat client.
//
// One provider, one model, one call. Chain rotation lives in
// rotatingClient.js; this file is the per-request layer, ported from
// hirepilot_v4/llm.py's LLMClient (llm.py:846-1147) plus the request-shaping
// helpers at llm.py:814-844.
//
// httpx's timeout is inactivity-based, which llm.py wraps in a wall-clock
// thread (llm.py:149-178) only when a caller passes a deadline -- and no v4
// caller ever does, so in practice v4's only limit is httpx's 45s inactivity
// timeout. fetch()'s AbortController is a hard deadline instead. Same number,
// slightly stricter semantics; a documented, accepted difference.
//
// `fetchImpl` is an injection seam for tests, the same role llm.py's
// `_INJECTED_TRANSPORT` (an httpx MockTransport) plays for the Python client.

export class LlmError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // 'timeout' | 'http_error' | 'network_error' | 'malformed_response' | 'empty_response' | ...
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 45_000;

// llm.py:226-231. Internal backoff, used only when the chain has nowhere else
// to go -- see `allowInternalRetry`.
const MAX_INTERNAL_ATTEMPTS = 5;
const RATE_LIMIT_BASE_WAIT_MS = 10_000;
const RATE_LIMIT_MAX_WAIT_MS = 60_000;

const GROQ_BASE = 'https://api.groq.com';

// --- strict-JSON fallback --------------------------------------------------

// llm.py:465. (baseUrl::model::key) triples that rejected server-side
// structured output. Once learned, later JSON calls to that model ask for JSON
// in the PROMPT instead and parse defensively, rather than rediscovering the
// same rejection on every call. Session-scoped, matching v4's process scope.
const strictJsonUnsupported = new Set();
const tripleKey = (baseUrl, model, apiKey) => `${String(baseUrl).toLowerCase()}::${String(model).toLowerCase()}::${apiKey ?? ''}`;

export function strictJsonDisabled(baseUrl, model, apiKey) {
  return strictJsonUnsupported.has(tripleKey(baseUrl, model, apiKey));
}

export function markStrictJsonUnsupported(baseUrl, model, apiKey) {
  strictJsonUnsupported.add(tripleKey(baseUrl, model, apiKey));
}

/** llm.py:487. Did the provider explicitly reject `response_format`? */
export function isStrictJsonRejection(detail) {
  const normalized = String(detail || '').toLowerCase().replace(/['"`]/g, '').replace(/-/g, '_');
  return [
    'response_format is not supported',
    'response_format not supported',
    'unsupported response_format',
    'unsupported parameter: response_format',
    'unknown parameter: response_format',
    'does not support response_format',
    'json_object is not supported',
    'json schema is not supported',
  ].some((marker) => normalized.includes(marker));
}

// --- reasoning parameters --------------------------------------------------

// (baseUrl::model) pairs that answered a reasoning parameter with a 400. A
// safety net beneath the gating below, not a substitute for it: the gate stops
// us sending the parameter where v4 would not, and this stops a 400 from
// killing a call if a gated provider still refuses it.
const reasoningRejected = new Set();

/** Test seam: forget what was learned about provider support. */
export function resetReasoningEffortSupport() {
  reasoningRejected.clear();
  strictJsonUnsupported.clear();
}

/**
 * llm.py:814-833. Reasoning parameters are GATED BY PROVIDER AND MODEL, not
 * sent globally.
 *
 * This is narrower than it looks and the narrowness is the point:
 *
 *   reasoning_format: 'hidden'  Groq, and only qwen3 / gpt-oss models. Keeps
 *                               chain-of-thought out of `content`, so JSON
 *                               parsing is not handed a reasoning preamble.
 *   reasoning_effort: 'none'    Groq, and only qwen3 -- Qwen's non-thinking
 *                               mode for bounded structured generation.
 *
 * Gemini gets NEITHER. An earlier version of this file sent reasoning_effort
 * to every provider, because a live run measured 13-25s resume calls that
 * truncated mid-JSON. But the model doing that was `gemini-2.5-flash`, a
 * thinking model that led the chain by mistake -- v4's chain leads with
 * `gemini-3.1-flash-lite`, which does not think and does not need the
 * parameter. Fixing the chain removed the reason for the workaround, so the
 * workaround goes too rather than being carried forever as a guess.
 */
export function reasoningParamsFor(baseUrl, model, requestedEffort) {
  const url = String(baseUrl || '').replace(/\/+$/, '').toLowerCase();
  if (!url.startsWith(GROQ_BASE)) return {};
  if (reasoningRejected.has(`${baseUrl}::${model}`)) return {};

  const key = String(model || '').toLowerCase();
  const params = {};
  if (key.includes('qwen3') || key.includes('gpt-oss')) params.reasoning_format = 'hidden';
  if (key.includes('qwen3')) params.reasoning_effort = requestedEffort || 'none';
  return params;
}

// --- retry-after -----------------------------------------------------------

/**
 * llm.py:343. Providers disagree about how to say "wait": a relative number of
 * seconds, an absolute epoch, or a duration string like "1m30s". All three
 * appear in the wild, and the value overrides our cooldown constants, so
 * misreading one is worse than not reading it.
 *
 * @returns {number|null} milliseconds
 */
export function parseRetryAfterMs(headers, nowMs = Date.now()) {
  const get = (name) => (headers && typeof headers.get === 'function'
    ? headers.get(name)
    : headers && (headers[name] ?? headers[name.toLowerCase()]));
  const raw = get('Retry-After')
    ?? get('X-RateLimit-Reset-Requests')
    ?? get('X-RateLimit-Reset');
  if (raw == null || String(raw).trim() === '') return null;

  const value = String(raw).trim().toLowerCase();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const nowSeconds = nowMs / 1000;
    const seconds = numeric > nowSeconds + 1 ? numeric - nowSeconds : numeric;
    return Math.max(1000, seconds * 1000);
  }

  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const matches = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)];
  if (!matches.length) return null;
  const total = matches.reduce((sum, [, amount, unit]) => sum + Number(amount) * multipliers[unit], 0);
  return Math.max(1000, total);
}

const headersToObject = (headers) => {
  const out = {};
  try {
    if (headers && typeof headers.forEach === 'function') {
      headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
    }
  } catch { /* best-effort: headers are diagnostics, never load-bearing */ }
  return out;
};

// --- the call --------------------------------------------------------------

async function chatOnce({
  provider, apiKey, model, messages, jsonMode, maxTokens, timeoutMs, reasoningEffort, fetchImpl,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.4,
    ...reasoningParamsFor(provider.baseUrl, model, reasoningEffort),
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let resp;
  try {
    resp = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new LlmError('timeout', `LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError('network_error', String((err && err.message) || err));
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let preview = '';
    try { preview = (await resp.text()).slice(0, 300); } catch { /* best-effort */ }

    // A provider that does not understand a reasoning parameter rejects the
    // WHOLE request. The gating above means we rarely get here, but a gated
    // provider changing its mind must not take the call down: remember it,
    // drop the parameters, try once more.
    const sentReasoning = 'reasoning_effort' in body || 'reasoning_format' in body;
    if (resp.status === 400 && sentReasoning && /reason|think|unknown|unsupported|invalid/i.test(preview)) {
      reasoningRejected.add(`${provider.baseUrl}::${model}`);
      return chatOnce({
        provider, apiKey, model, messages, jsonMode, maxTokens, timeoutMs,
        reasoningEffort: undefined, fetchImpl,
      });
    }

    throw new LlmError('http_error', `LLM provider returned HTTP ${resp.status}`, {
      status: resp.status,
      preview,
      headers: headersToObject(resp.headers),
      retryAfterMs: parseRetryAfterMs(resp.headers),
    });
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new LlmError('malformed_response', 'LLM response was not valid JSON');
  }

  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  // Truncation is silent otherwise: the content is a non-empty but INCOMPLETE
  // string, which downstream JSON parsing then fails on with no indication of
  // why. Reasoning models make this common -- max_tokens caps thinking plus
  // output together, so a hard prompt can spend the whole budget before
  // emitting anything usable.
  const finishReason = (choice && (choice.finish_reason ?? choice.finishReason)) || null;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError(
      'empty_response',
      finishReason === 'length'
        ? 'LLM hit its token limit before producing any content'
        : 'LLM response had no message content',
      { finishReason },
    );
  }

  const usage = data.usage || {};
  return {
    content,
    finishReason,
    headers: headersToObject(resp.headers),
    usage: {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
  };
}

const isInternallyRetryable = (err) => {
  if (!(err instanceof LlmError)) return false;
  if (err.kind === 'timeout') return true;
  if (err.kind !== 'http_error') return false;
  const status = err.detail && err.detail.status;
  return status === 429 || status === 503;
};

/**
 * @param {object} opts
 * @param {{baseUrl: string}} opts.provider
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {boolean} [opts.jsonMode]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.reasoningEffort] - honoured only where gated in, see
 *   reasoningParamsFor().
 * @param {boolean} [opts.allowInternalRetry] - llm.py's `_single_attempt`,
 *   inverted. v4 sets `_single_attempt = len(clients) > 1`: when the chain has
 *   somewhere to go, the POOL is the retry mechanism, and backing off in place
 *   first only makes the run look hung. When the chain has exactly one entry
 *   there is nothing to fail over to, so exponential backoff is all that is
 *   left -- and v4 gives it five attempts.
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number) => Promise<void>} [opts.sleepImpl]
 */
export async function chat({
  provider,
  apiKey,
  model,
  messages,
  jsonMode = false,
  maxTokens = 2048,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reasoningEffort,
  allowInternalRetry = false,
  fetchImpl = fetch,
  sleepImpl,
}) {
  const once = () => chatOnce({
    provider, apiKey, model, messages, jsonMode, maxTokens, timeoutMs, reasoningEffort, fetchImpl,
  });
  if (!allowInternalRetry) return once();

  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt < MAX_INTERNAL_ATTEMPTS; attempt++) {
    try {
      return await once();
    } catch (err) {
      lastError = err;
      if (!isInternallyRetryable(err) || attempt === MAX_INTERNAL_ATTEMPTS - 1) throw err;
      // The provider's own Retry-After wins over our backoff curve.
      const advised = err.detail && err.detail.retryAfterMs;
      const wait = advised || Math.min(RATE_LIMIT_BASE_WAIT_MS * 2 ** attempt, RATE_LIMIT_MAX_WAIT_MS);
      await sleep(wait);
    }
  }
  throw lastError; // unreachable, but keeps the return type honest
}

/**
 * Retry wrapper for callers outside the rotating client (job extraction, and
 * anything else with a single provider and no chain to fall back on).
 *
 * @param {object} chatOpts - same shape as chat()'s single argument
 * @param {object} [retryOpts]
 */
export async function chatWithRetry(chatOpts, { maxRetries = 2, baseDelayMs = 500, sleepImpl } = {}) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chat(chatOpts);
    } catch (err) {
      lastError = err;
      const retryable = isInternallyRetryable(err)
        || (err instanceof LlmError && err.kind === 'network_error');
      if (!retryable || attempt === maxRetries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
