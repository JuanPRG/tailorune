// rateWindow.js — client-side rate reservation, so we never SEND a request
// that is already over a provider's per-minute budget.
//
// Ported from v4/llm.py:669-812 (`_reserve_rate_budget`,
// `_reconcile_rate_reservation`, `_observe_rate_metadata`).
//
// WHY THIS EXISTS. A live run died on HTTP 413 from Groq: "Limit 8000,
// Requested 9855". `max_tokens` counts toward a provider's tokens-per-minute
// budget, so an oversized ceiling makes a request unservable for an answer
// that was going to be 431 tokens. Reacting to the 413 works -- rotation
// moves on -- but it costs a full round trip plus a cooldown on a model that
// was never actually unhealthy. v4 declines to send it in the first place.
//
// The window is keyed per (baseUrl, model, apiKey), matching v4. Two keys for
// the same model have independent budgets, because the limit is enforced per
// credential.
//
// A refusal here is NOT a failure. v4 records it as `local_rate_limited` and
// `continue`s to the next chain entry without setting any cooldown -- the
// model is fine, we just declined to ask it right now.

import { credentialFingerprint } from './fingerprint.js';

const WINDOW_MS = 60_000;

// LLM_RATE_LIMIT_SAFETY_FACTOR=0.90. Provider accounting and ours will never
// agree exactly (they tokenize, we estimate), so aim under the line.
const SAFETY_FACTOR = 0.90;

// LLM_RATE_LIMIT_GROQ_TPM=8000, the one limit the user's .env configures.
// Resolution order mirrors llm.py:590 -- model first, then family, then
// default -- so a per-model limit can be added later without restructuring.
const CONFIGURED_LIMITS = {
  model: {},
  family: { groq: { tpm: 8000 } },
  default: {},
};

/** llm.py:514. Which rate-limit family a base URL belongs to. */
export function rateLimitFamily(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('api.groq.com')) return 'groq';
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('cerebras.ai')) return 'cerebras';
  return 'custom';
}

/** windows: key -> { requests: number[], reservations: [...], observed, blockedUntil } */
const windows = new Map();

// Fingerprinted, not raw: rateWindowState() is a diagnostic and diagnostics
// get printed. See fingerprint.js.
export const rateKey = (baseUrl, model, apiKey) => `${String(baseUrl).toLowerCase()}::${String(model).toLowerCase()}::${credentialFingerprint(apiKey)}`;

/** Test seam: the window is module state shared across a whole session. */
export function resetRateWindows() {
  windows.clear();
}

function windowFor(key) {
  let state = windows.get(key);
  if (!state) {
    state = {
      requests: [], reservations: [], nextId: 1,
      observedRpm: null, observedTpm: null,
      blockedUntil: 0, blockedReason: '',
    };
    windows.set(key, state);
  }
  return state;
}

function prune(state, now) {
  const cutoff = now - WINDOW_MS;
  while (state.requests.length && state.requests[0] <= cutoff) state.requests.shift();
  while (state.reservations.length && state.reservations[0].at <= cutoff) state.reservations.shift();
  if (state.blockedUntil && state.blockedUntil <= now) {
    state.blockedUntil = 0;
    state.blockedReason = '';
  }
}

function resolveLimit(baseUrl, model, metric) {
  const family = rateLimitFamily(baseUrl);
  const sources = [
    CONFIGURED_LIMITS.model[String(model).toLowerCase()],
    CONFIGURED_LIMITS.family[family],
    CONFIGURED_LIMITS.default,
  ];
  for (const source of sources) {
    const value = source && source[metric];
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * llm.py:634. Conservative estimate of what this request will cost the
 * rolling budget, BEFORE the provider tokenizes it.
 *
 * The output term matters as much as the prompt: `max_tokens` is what the
 * provider reserves, and it is what the 413 complained about.
 */
export function estimateRequestTokens(messages, maxTokens) {
  const chars = (messages || []).reduce((sum, m) => {
    const c = m && m.content;
    return sum + (typeof c === 'string' ? c.length : String(c ?? '').length);
  }, 0);
  const promptTokens = Math.max(1, Math.ceil(chars / 3.3) + 6 * (messages || []).length);
  const expectedOutput = Math.min(
    Math.max(0, Math.floor(maxTokens || 0)),
    Math.max(128, Math.ceil(promptTokens * 0.25)),
  );
  return promptTokens + expectedOutput;
}

/** llm.py:653. When would enough reservations age out to fit this request? */
function rollingRetryAfterMs(reservations, { now, capacity, requested }) {
  let running = reservations.reduce((sum, r) => sum + r.tokens, 0);
  for (const r of reservations) {
    running -= r.tokens;
    if (running + requested <= capacity) {
      return Math.max(1000, Math.ceil(r.at + WINDOW_MS - now));
    }
  }
  return WINDOW_MS;
}

/**
 * Decide whether to send, and reserve the budget if so.
 *
 * @returns {{allowed: boolean, estimatedTokens: number, reservationId?: number,
 *            retryAfterMs?: number, reason?: string, rpmLimit: number|null,
 *            tpmLimit: number|null}}
 */
export function reserveRateBudget({
  baseUrl, model, apiKey, messages, maxTokens, now = Date.now(),
}) {
  const estimatedTokens = estimateRequestTokens(messages, maxTokens);
  const key = rateKey(baseUrl, model, apiKey);
  const state = windowFor(key);
  prune(state, now);

  const rpmLimit = resolveLimit(baseUrl, model, 'rpm') || state.observedRpm;
  const tpmLimit = resolveLimit(baseUrl, model, 'tpm') || state.observedTpm;
  const limits = { rpmLimit: rpmLimit || null, tpmLimit: tpmLimit || null };

  // A provider that told us to wait (429 + Retry-After) is honoured here
  // rather than being rediscovered by sending another doomed request.
  if (state.blockedUntil > now) {
    return {
      allowed: false, estimatedTokens, ...limits,
      retryAfterMs: state.blockedUntil - now,
      reason: state.blockedReason || 'provider rate window is cooling down',
    };
  }

  const effectiveRpm = rpmLimit ? Math.max(1, Math.floor(rpmLimit * SAFETY_FACTOR)) : null;
  if (effectiveRpm && state.requests.length >= effectiveRpm) {
    return {
      allowed: false, estimatedTokens, ...limits,
      retryAfterMs: Math.max(1000, Math.ceil(state.requests[0] + WINDOW_MS - now)),
      reason: `local RPM budget reached (${state.requests.length}/${effectiveRpm})`,
    };
  }

  const effectiveTpm = tpmLimit ? Math.max(1, Math.floor(tpmLimit * SAFETY_FACTOR)) : null;
  const usedTokens = state.reservations.reduce((sum, r) => sum + r.tokens, 0);
  if (effectiveTpm && usedTokens + estimatedTokens > effectiveTpm) {
    return {
      allowed: false, estimatedTokens, ...limits,
      retryAfterMs: rollingRetryAfterMs(state.reservations, {
        now, capacity: effectiveTpm, requested: estimatedTokens,
      }),
      reason: `local TPM budget would be exceeded (${usedTokens}+${estimatedTokens}>${effectiveTpm})`,
    };
  }

  const reservationId = state.nextId++;
  state.requests.push(now);
  state.reservations.push({ id: reservationId, at: now, tokens: estimatedTokens });
  return { allowed: true, estimatedTokens, reservationId, ...limits };
}

/**
 * llm.py:748. Replace the estimate with what the request actually cost, so a
 * conservative guess does not throttle the next call for a full minute.
 */
export function reconcileReservation({ baseUrl, model, apiKey, reservationId, actualTokens }) {
  if (reservationId == null || !actualTokens) return;
  const state = windows.get(rateKey(baseUrl, model, apiKey));
  if (!state) return;
  const reservation = state.reservations.find((r) => r.id === reservationId);
  if (reservation) reservation.tokens = Math.max(1, Math.floor(actualTokens));
}

/**
 * llm.py:777. Learn the real limits from the provider rather than requiring
 * every one to be configured by hand: response headers when present, and
 * failing that the shape Groq puts in its 429 body ("TPM): Limit 8000").
 */
export function observeRateMetadata({
  baseUrl, model, apiKey, headers, detail = '', retryAfterMs = null, now = Date.now(),
}) {
  const state = windowFor(rateKey(baseUrl, model, apiKey));
  const headerInt = (...names) => {
    for (const name of names) {
      const raw = headers && typeof headers.get === 'function'
        ? headers.get(name)
        : headers && headers[name];
      const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  };

  const rpm = headerInt('x-ratelimit-limit-requests', 'x-ratelimit-limit-request');
  let tpm = headerInt('x-ratelimit-limit-tokens', 'x-ratelimit-limit-token');
  if (tpm === null && detail) {
    const match = /\bTPM\)?\s*:\s*Limit\s+(\d+)/i.exec(detail);
    if (match) tpm = Number.parseInt(match[1], 10);
  }

  if (rpm) state.observedRpm = rpm;
  if (tpm) state.observedTpm = tpm;
  if (retryAfterMs) {
    const until = now + Math.max(1000, retryAfterMs);
    if (until > state.blockedUntil) {
      state.blockedUntil = until;
      state.blockedReason = detail || 'provider requested a rate-limit wait';
    }
  }
}

/** Diagnostics for the UI, mirroring cooldownState()'s role. */
export function rateWindowState(now = Date.now()) {
  const out = {};
  for (const [key, state] of windows) {
    prune(state, now);
    if (!state.requests.length && !state.blockedUntil) continue;
    out[key] = {
      requests: state.requests.length,
      reservedTokens: state.reservations.reduce((sum, r) => sum + r.tokens, 0),
      observedTpm: state.observedTpm,
      blockedForSeconds: state.blockedUntil > now ? Math.round((state.blockedUntil - now) / 1000) : 0,
    };
  }
  return out;
}
