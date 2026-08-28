// rotatingClient.js — multi-provider failover with per-provider cooldowns.
//
// Ported from hirepilot_v4/llm.py's `RotatingClient` (llm.py:1161, main loop
// :1463-1763). Like v4, each provider's model pool is exploded into one chain
// entry per model and the entries are interleaved round-robin by model index
// (:2098-2102), with cooldowns keyed per (provider, model) -- free-tier rate
// limits are commonly per-model, so a throttled `gemini-2.5-flash` should not
// take `gemini-3.1-flash-lite` down with it.
//
// Round-robin by model index rather than provider-then-provider means the
// order is: every provider's best model first, then every provider's second
// model. A user with three keys gets three strong attempts before falling
// back to lighter models, rather than exhausting one provider's whole pool
// while two untouched providers wait.
//
// v4's six failure types collapse to the four buckets that actually change
// behaviour here:
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
import { getProvider, taskPolicy } from './providers.js';

// Durations ported from llm.py:261-264.
export const COOLDOWN_MS = {
  quota_exhausted: 900_000, // 15 min
  rate_limited: 60_000,
  transient: 60_000,
  config_error: 900_000,
};

const cooldowns = new Map(); // "providerId::model" -> epoch ms when usable again

function cooldownKey(providerId, model) {
  return `${providerId}::${model}`;
}

/** Test seam: cooldowns are module state, so tests need a way to reset them. */
export function resetCooldowns() {
  cooldowns.clear();
}

/** @returns {Object<string, number>} "provider::model" -> seconds remaining */
export function cooldownState(now = Date.now()) {
  const state = {};
  for (const [key, until] of cooldowns) {
    if (until > now) state[key] = Math.round((until - now) / 1000);
  }
  return state;
}

function isAvailable(providerId, model, now) {
  const until = cooldowns.get(cooldownKey(providerId, model));
  return !until || until <= now;
}

/**
 * Expand {providerId, apiKey, model?} entries into one entry per model, then
 * interleave round-robin by model index. An explicit `model` pins that entry
 * to just that model -- an explicit choice is never silently widened.
 *
 * @param {Array} chain
 * @param {object} [opts]
 * @param {string} [opts.task] - 'resume' | 'skills' | 'coverLetter' | 'judge'.
 *   Applies that task's model policy: excluded models are dropped, preferred
 *   ones are tried first. Omitted, every model is eligible in interleaved
 *   order, which is the right default for a caller with no opinion.
 */
export function buildChainEntries(chain, { task } = {}) {
  const perProvider = chain.map((entry) => {
    const provider = getProvider(entry.providerId);
    // A pinned model is a deliberate choice by the user and is exempt from
    // task policy: they asked for that model, so honour it rather than
    // silently substituting one this table prefers.
    const pinned = Boolean(entry.model);
    const models = pinned ? [entry.model] : provider.models;
    return models.map((model) => ({
      providerId: entry.providerId, apiKey: entry.apiKey, model, pinned,
    }));
  });

  const interleaved = [];
  const deepest = Math.max(0, ...perProvider.map((list) => list.length));
  for (let modelIndex = 0; modelIndex < deepest; modelIndex++) {
    for (const list of perProvider) {
      if (list[modelIndex]) interleaved.push(list[modelIndex]);
    }
  }

  const policy = taskPolicy(task);
  if (!policy) return interleaved;

  const eligible = interleaved.filter((e) => e.pinned || !policy.excluded.includes(e.model));

  // Rank by the task's preference; anything unranked keeps its interleaved
  // position behind the ranked ones. Array.prototype.sort is stable, so the
  // round-robin fallback order survives intact.
  const rank = (model) => {
    const i = policy.preferred.indexOf(model);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...eligible].sort((a, b) => rank(a.model) - rank(b.model));
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

    // 402: out of credit on THIS provider. Another provider's key is unaffected.
    if (status === 402 || /payment required|billing|insufficient|credit/.test(body)) {
      return { kind: 'quota_exhausted', retryable: true };
    }
    // 413, and the 400s that say it in words: too large for THIS model's
    // per-minute budget. A property of the model, not a defect in the request,
    // so the next model in the chain is exactly the right thing to try.
    if (status === 413 || /too large|reduce your message size|context length/.test(body)) {
      return { kind: 'rate_limited', retryable: true };
    }
    // 404 / 400-with-a-model-complaint: this model is gone or renamed. The
    // next one in the pool is the answer.
    if (status === 404 || /model.*(not found|not exist|unavailable|decommission|deprecat)/.test(body)) {
      return { kind: 'transient', retryable: true };
    }

    // Everything left is a genuinely malformed request, which every provider
    // would reject identically -- rotating would only reproduce it.
    //
    // The principle, learned the hard way: a status is non-retryable only if
    // it is a property of the REQUEST. Anything that is a property of the
    // provider or the model -- quota, credit, rate, size limit, availability,
    // a bad key for that one provider -- must rotate, because the next entry
    // in the chain does not share it. Two live runs died on the spot to a 413
    // and a 402 that both fell through to here.
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
  chain, messages, jsonMode, maxTokens, timeoutMs, reasoningEffort, task,
  fetchImpl, nowFn = Date.now, baseUrlOverride,
}) {
  if (!chain || !chain.length) {
    throw new LlmError('provider_configuration_error', 'No providers configured.');
  }

  const entries = buildChainEntries(chain, { task });
  const now = nowFn();
  const available = entries.filter((entry) => isAvailable(entry.providerId, entry.model, now));
  // If everything is cooling down, still try the whole chain rather than
  // failing without making a single request -- a stale cooldown should not
  // be able to hard-block the user.
  const order = available.length ? available : entries;

  const attempts = [];
  let lastError = null;

  for (const entry of order) {
    const base = getProvider(entry.providerId);
    const provider = baseUrlOverride ? { ...base, baseUrl: baseUrlOverride } : base;
    const { model } = entry;

    try {
      const response = await chat({
        provider, apiKey: entry.apiKey, model, messages,
        jsonMode, maxTokens, timeoutMs, reasoningEffort, fetchImpl,
      });
      attempts.push({ providerId: entry.providerId, model, ok: true });
      return { ...response, providerId: entry.providerId, model, attempts };
    } catch (err) {
      const { kind, retryable } = classifyFailure(err);
      attempts.push({ providerId: entry.providerId, model, ok: false, kind, error: err.message });
      lastError = err;

      if (!retryable) throw err;

      const cooldownMs = COOLDOWN_MS[kind];
      if (cooldownMs) cooldowns.set(cooldownKey(entry.providerId, model), nowFn() + cooldownMs);
    }
  }

  // Every provider failed. Surface the last real error, annotated with the
  // full attempt trail so the UI can say *which* providers were tried and
  // why each one failed, rather than a bare "it didn't work".
  const summary = attempts.map((a) => `${a.providerId}/${a.model}: ${a.kind}`).join('; ');
  const err = new LlmError(
    lastError && lastError.kind === 'http_error' && attempts.every((a) => a.kind === 'quota_exhausted')
      ? 'quota_exhausted'
      : 'providers_unavailable',
    `All ${attempts.length} configured provider(s) failed — ${summary}`,
    { attempts },
  );
  throw err;
}
