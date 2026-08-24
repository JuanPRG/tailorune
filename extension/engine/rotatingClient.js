// rotatingClient.js — multi-provider failover with per-provider cooldowns.
//
// Ported in spirit from hirepilot_v4/llm.py's `RotatingClient` (llm.py:1161,
// main loop :1463-1763). Not a line-for-line port: v4 explodes each
// provider's model pool into one chain entry per model and interleaves them
// round-robin by model index (:2098-2102), tracks cooldowns in process-global
// dicts keyed by (provider, model, api_key), and distinguishes six failure
// types with four different cooldown durations. That machinery exists to
// squeeze a large multi-model config; here each provider has one configured
// model, so the chain is per-provider and the taxonomy collapses to the
// distinction that actually changes behaviour:
//
//   - quota_exhausted   -> long cooldown, this provider is done for a while
//   - rate_limited      -> short cooldown, try again soon
//   - transient/timeout -> short cooldown, likely recoverable
//   - config error      -> long cooldown, a bad key won't fix itself
//   - non-retryable     -> fail immediately, don't burn the whole chain
//
// Cooldowns live in module state, so they persist for the life of the
// offscreen document (which is unlimited) and are shared across every call
// made from it — the same practical lifetime v4's process-global dicts had.

import { chat, LlmError } from './llm.js';
import { getProvider } from './providers.js';

// Durations ported from llm.py:261-264.
export const COOLDOWN_MS = {
  quota_exhausted: 900_000, // 15 min
  rate_limited: 60_000,
  transient: 60_000,
  config_error: 900_000,
};

const cooldowns = new Map(); // providerId -> epoch ms when it becomes usable again

/** Test seam: cooldowns are module state, so tests need a way to reset them. */
export function resetCooldowns() {
  cooldowns.clear();
}

export function cooldownState(now = Date.now()) {
  const state = {};
  for (const [providerId, until] of cooldowns) {
    if (until > now) state[providerId] = Math.round((until - now) / 1000);
  }
  return state;
}

function isAvailable(providerId, now) {
  const until = cooldowns.get(providerId);
  return !until || until <= now;
}

/**
 * Classify a failure into the cooldown bucket it deserves. Provider error
 * text is inspected for quota-vs-rate-limit because both arrive as HTTP 429
 * and they warrant very different cooldowns — the same distinction
 * llm.py:386-412 draws by substring-matching the body.
 */
export function classifyFailure(err) {
  if (!(err instanceof LlmError)) return { kind: 'transient', retryable: true };

  if (err.kind === 'timeout' || err.kind === 'network_error') {
    return { kind: 'transient', retryable: true };
  }
  if (err.kind === 'http_error') {
    const status = err.detail && err.detail.status;
    const body = String((err.detail && err.detail.preview) || '').toLowerCase();
    if (status === 429) {
      const looksLikeQuota = /quota|billing|exceeded your current|insufficient_quota|credit/.test(body);
      return { kind: looksLikeQuota ? 'quota_exhausted' : 'rate_limited', retryable: true };
    }
    if (status === 401 || status === 403) return { kind: 'config_error', retryable: true };
    if (status >= 500) return { kind: 'transient', retryable: true };
    // 400 and friends: the request itself is wrong. Rotating to another
    // provider would just reproduce it, so fail out immediately.
    return { kind: 'request_error', retryable: false };
  }
  // malformed_response / empty_response: the provider answered, badly.
  // Worth trying a different one, but not worth a long cooldown.
  return { kind: 'transient', retryable: true };
}

/**
 * Try each configured provider in order until one succeeds.
 *
 * @param {object} opts
 * @param {Array<{providerId: string, apiKey: string, model?: string}>} opts.chain
 * @param {Array} opts.messages
 * @param {string} [opts.baseUrlOverride] - applies to every provider (debug/testing)
 * @returns {Promise<{content: string, usage: object, providerId: string, attempts: Array}>}
 */
export async function chatWithRotation({
  chain, messages, jsonMode, maxTokens, timeoutMs,
  fetchImpl, nowFn = Date.now, baseUrlOverride,
}) {
  if (!chain || !chain.length) {
    throw new LlmError('provider_configuration_error', 'No providers configured.');
  }

  const now = nowFn();
  const available = chain.filter((entry) => isAvailable(entry.providerId, now));
  // If everything is cooling down, still try the whole chain rather than
  // failing without making a single request -- a stale cooldown should not
  // be able to hard-block the user.
  const order = available.length ? available : chain;

  const attempts = [];
  let lastError = null;

  for (const entry of order) {
    const base = getProvider(entry.providerId);
    const provider = baseUrlOverride ? { ...base, baseUrl: baseUrlOverride } : base;
    const model = entry.model || base.defaultModel;

    try {
      const response = await chat({
        provider, apiKey: entry.apiKey, model, messages,
        jsonMode, maxTokens, timeoutMs, fetchImpl,
      });
      attempts.push({ providerId: entry.providerId, model, ok: true });
      return { ...response, providerId: entry.providerId, model, attempts };
    } catch (err) {
      const { kind, retryable } = classifyFailure(err);
      attempts.push({ providerId: entry.providerId, model, ok: false, kind, error: err.message });
      lastError = err;

      if (!retryable) throw err;

      const cooldownMs = COOLDOWN_MS[kind];
      if (cooldownMs) cooldowns.set(entry.providerId, nowFn() + cooldownMs);
    }
  }

  // Every provider failed. Surface the last real error, annotated with the
  // full attempt trail so the UI can say *which* providers were tried and
  // why each one failed, rather than a bare "it didn't work".
  const summary = attempts.map((a) => `${a.providerId}: ${a.kind}`).join('; ');
  const err = new LlmError(
    lastError && lastError.kind === 'http_error' && attempts.every((a) => a.kind === 'quota_exhausted')
      ? 'quota_exhausted'
      : 'providers_unavailable',
    `All ${attempts.length} configured provider(s) failed — ${summary}`,
    { attempts },
  );
  throw err;
}
