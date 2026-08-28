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

// (baseUrl::model) pairs that answered a reasoning_effort request with a 400.
// Session-scoped: a provider's support does not change mid-run, and this
// keeps the cost of discovering it to exactly one extra request.
const reasoningEffortRejected = new Set();
const reasoningKey = (baseUrl, model) => `${baseUrl}::${model}`;

function sendsReasoningEffort(baseUrl, model) {
  return !reasoningEffortRejected.has(reasoningKey(baseUrl, model));
}

function markReasoningEffortUnsupported(baseUrl, model) {
  reasoningEffortRejected.add(reasoningKey(baseUrl, model));
}

/** Test seam: forget what was learned about provider support. */
export function resetReasoningEffortSupport() {
  reasoningEffortRejected.clear();
}

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
  reasoningEffort,
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
  // Thinking budget. On a reasoning model max_tokens caps thinking AND output
  // together, so a long prompt can spend the allowance before emitting usable
  // JSON -- measured at 13-25s per resume call against ~1s for the smaller
  // passes, and still truncating at 4096. Sent only where it has not already
  // been rejected; see sendsReasoningEffort().
  if (reasoningEffort && sendsReasoningEffort(provider.baseUrl, model)) {
    body.reasoning_effort = reasoningEffort;
  }

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

    // A provider that does not understand reasoning_effort rejects the whole
    // request with a 400, which rotation treats as fatal -- so an optimisation
    // would take the run down with it. Remember the rejection, drop the
    // parameter, and try once more. Every provider then works, and the ones
    // that support it still get the benefit.
    if (resp.status === 400 && body.reasoning_effort && /reason|think|unknown|unsupported|invalid/i.test(preview)) {
      markReasoningEffortUnsupported(provider.baseUrl, model);
      return chat({
        provider, apiKey, model, messages, jsonMode, maxTokens, timeoutMs, fetchImpl,
      });
    }

    throw new LlmError('http_error', `LLM provider returned HTTP ${resp.status}`, { status: resp.status, preview });
  }

  let data;
  try {
    data = await resp.json();
  } catch (err) {
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
