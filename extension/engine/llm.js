// llm.js — single-provider LLM chat client.
//
// This is deliberately NOT a port of hirepilot_v4/llm.py's RotatingClient —
// chain rotation, per-model cooldowns, and rate-limit reservation are Phase 4
// in the migration plan. This is the minimum real client the Phase 2 vertical
// slice needs: one provider, one model, one call, honest error reporting.
//
// httpx's timeout is inactivity-based (a wall-clock thread in llm.py, since
// httpx itself has no such concept — see llm.py:149-178). fetch()'s
// AbortController is a hard deadline instead. Documented as an accepted
// difference in MIGRATION_PLAN.md — not reproduced here.
//
// `fetchImpl` is an injection seam for tests, the same role llm.py's
// `_INJECTED_TRANSPORT` (an httpx MockTransport) plays for the Python client.

export class LlmError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // 'timeout' | 'http_error' | 'network_error' | 'malformed_response' | 'empty_response'
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * @param {object} opts
 * @param {{baseUrl: string}} opts.provider
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {boolean} [opts.jsonMode]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function chat({
  provider,
  apiKey,
  model,
  messages,
  jsonMode = false,
  maxTokens = 2048,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: 0.4,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let resp;
  try {
    resp = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new LlmError('timeout', `LLM request timed out after ${timeoutMs}ms`);
    }
    throw new LlmError('network_error', String(err && err.message || err));
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    let preview = '';
    try { preview = (await resp.text()).slice(0, 300); } catch { /* best-effort */ }
    throw new LlmError('http_error', `LLM provider returned HTTP ${resp.status}`, { status: resp.status, preview });
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
    throw new LlmError('malformed_response', 'LLM response was not valid JSON');
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new LlmError('empty_response', 'LLM response had no message content');
  }

  const usage = data.usage || {};
  return {
    content,
    usage: {
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      totalTokens: usage.total_tokens ?? null,
    },
  };
}

// A real-world reliability gap the single-shot chat() above leaves open on
// purpose (it needs to stay simple and directly testable): a rate limit or
// a transient network blip fails the whole tailoring run. hirepilot_v4
// handles this via per-model cooldowns across a whole provider chain
// (llm.py:1216-1439) — full rotation is Phase 4, out of scope here. This is
// the right-sized equivalent for a single-provider client: retry only what
// is actually transient, with backoff, and fail fast on everything else.
const RETRYABLE_KINDS = new Set(['timeout', 'network_error']);

function isRetryableHttpStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}

function isRetryable(err) {
  if (!(err instanceof LlmError)) return false;
  if (RETRYABLE_KINDS.has(err.kind)) return true;
  return err.kind === 'http_error' && isRetryableHttpStatus(err.detail && err.detail.status);
}

/**
 * @param {object} chatOpts - same shape as chat()'s single argument
 * @param {object} [retryOpts]
 * @param {number} [retryOpts.maxRetries]
 * @param {number} [retryOpts.baseDelayMs]
 * @param {(ms: number) => Promise<void>} [retryOpts.sleepImpl] - injection seam for tests, same role as fetchImpl
 */
export async function chatWithRetry(chatOpts, { maxRetries = 2, baseDelayMs = 500, sleepImpl } = {}) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await chat(chatOpts);
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError; // unreachable, but keeps this function's return type honest
}
