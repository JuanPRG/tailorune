// rotatingClient.js — provider/model failover, ported from
// hirepilot_v4/llm.py's RotatingClient (llm.py:1161-1763).
//
// The chain is built from curated per-task route lists, not from a union of
// provider pools -- see providers.js for why that distinction cost a rewrite.
//
// THE TWO IDEAS WORTH UNDERSTANDING BEFORE EDITING THIS FILE:
//
// 1. EVERYTHING ROTATES. v4 has no non-retryable bucket. Every classified
//    failure sets a cooldown and moves to the next entry; severity is
//    expressed as cooldown SCOPE and DURATION, not as fail-vs-continue. An
//    earlier version of this file threw on 400/409/422, which killed whole
//    runs on a class of error v4 routes around in 30 seconds.
//
// 2. COOLDOWNS HAVE TWO SCOPES. Infrastructure faults (quota, rate, bad key,
//    transport) hold a model for EVERY task -- they are facts about the model.
//    Quality faults (unparseable output, validation failure, timeout) hold it
//    only for that task AND that JSON mode -- a model that cannot hold a
//    schema for resumes is not thereby bad at prose. Collapsing these into
//    one flat map, as this file used to, either over-punishes a model or
//    keeps handing a task the model that just failed it.
//
// Cooldowns live in module state, so they persist for the life of the
// offscreen document (unlimited) and are shared across every call made from
// it -- the same practical lifetime v4's process-global dicts had.

import { chat, LlmError, strictJsonDisabled, markStrictJsonUnsupported, isStrictJsonRejection } from './llm.js';
import {
  getProvider, taskPolicy, taskChain, ROUTES, TASK_CHAINS, DEFAULT_CHAIN,
  DEPRECATED_MODEL_IDS, STRICT_EXCLUSION_TASKS,
} from './providers.js';
import {
  reserveRateBudget, reconcileReservation, observeRateMetadata,
} from './rateWindow.js';
import { credentialFingerprint } from './fingerprint.js';

// --- cooldown policy -------------------------------------------------------

// llm.py:427 `_failure_cooldown_policy`. Durations from llm.py:261-264, which
// read LLM_PROVIDER_COOLDOWN_SECS=900, LLM_RATE_LIMIT_COOLDOWN_SECS=60,
// LLM_TRANSIENT_COOLDOWN_SECS=60 and LLM_TASK_FAILURE_COOLDOWN_SECS=30 from
// the user's .env.
export const SHARED_SCOPE_FAILURES = new Set([
  'quota_exhausted',
  'rate_limited',
  'provider_configuration_error',
  'provider_unavailable',
  'transport_error',
]);

export const COOLDOWN_MS = {
  quota_exhausted: 900_000,
  rate_limited: 60_000,
  provider_configuration_error: 900_000,
  provider_unavailable: 60_000,
  transport_error: 60_000,
};

/** Everything not in SHARED_SCOPE_FAILURES lands here: task scope, 30s. */
export const TASK_FAILURE_COOLDOWN_MS = 30_000;

/**
 * @param {string} failureType
 * @param {number|null} retryAfterMs - from a Retry-After header. When the
 *   provider tells us how long to wait, that OVERRIDES the constant; guessing
 *   15 minutes when it said 3 seconds is its own kind of outage.
 */
export function cooldownPolicy(failureType, retryAfterMs = null) {
  if (SHARED_SCOPE_FAILURES.has(failureType)) {
    return { scope: 'shared', ms: retryAfterMs ?? COOLDOWN_MS[failureType] ?? 60_000 };
  }
  return { scope: 'task', ms: retryAfterMs ?? TASK_FAILURE_COOLDOWN_MS };
}

// --- cooldown state --------------------------------------------------------

const sharedCooldowns = new Map(); // sharedKey -> { until, failureType, reason }
const taskCooldowns = new Map();   // sharedKey||task||mode -> same

// The credential is part of the key, matching llm.py:1216. Two keys for the
// same model have independent budgets, so one exhausted credential must not
// sideline a model the user has another key for -- and rotating a key should
// clear its holds rather than inheriting them.
//
// A FINGERPRINT, never the key itself: these identifiers reach the popup, the
// run result and the live harness's output, and the first live run with a raw
// key in them printed two real credentials to a terminal. See fingerprint.js.
const sharedKeyFor = (baseUrl, model, apiKey) => `${String(baseUrl).toLowerCase()}::${String(model).toLowerCase()}::${credentialFingerprint(apiKey)}`;
const taskKeyFor = (sharedKey, task, mode) => `${sharedKey}||${task || 'default'}||${mode}`;

/** Test seam: cooldowns are module state, so tests need a way to reset them. */
export function resetCooldowns() {
  sharedCooldowns.clear();
  taskCooldowns.clear();
}

function activeCooldown(map, key, now) {
  const state = map.get(key);
  if (!state) return null;
  if (state.until <= now) { map.delete(key); return null; }
  return state;
}

/** llm.py:1244. The effective hold is the LONGEST of those that apply. */
function cooldownFor(entry, { task, mode, now }) {
  const sharedKey = sharedKeyFor(entry.baseUrl, entry.model, entry.apiKey);
  const states = [
    activeCooldown(sharedCooldowns, sharedKey, now),
    activeCooldown(taskCooldowns, taskKeyFor(sharedKey, task, mode), now),
  ].filter(Boolean);
  if (!states.length) return null;
  return states.reduce((a, b) => (a.until >= b.until ? a : b));
}

function applyCooldown(entry, { failureType, reason, task, mode, retryAfterMs, now }) {
  const { scope, ms } = cooldownPolicy(failureType, retryAfterMs);
  const sharedKey = sharedKeyFor(entry.baseUrl, entry.model, entry.apiKey);
  const state = { until: now + Math.max(0, ms), failureType, reason: String(reason ?? ''), scope };
  if (scope === 'shared') sharedCooldowns.set(sharedKey, state);
  else taskCooldowns.set(taskKeyFor(sharedKey, task, mode), state);
  return state;
}

/** @returns {Object<string, {seconds: number, failureType: string, scope: string}>} */
export function cooldownState(now = Date.now()) {
  const out = {};
  const add = (key, state) => {
    if (state.until <= now) return;
    out[key] = {
      seconds: Math.round((state.until - now) / 1000),
      failureType: state.failureType,
      scope: state.scope,
    };
  };
  for (const [key, state] of sharedCooldowns) add(key, state);
  for (const [key, state] of taskCooldowns) add(key, state);
  return out;
}

/**
 * llm.py:1441 `cooldown_last_provider`. A model can answer perfectly well and
 * still produce output this task cannot use. Rotate away from it for the next
 * attempt instead of asking it again for another invalid answer.
 *
 * No-ops below two entries: demoting your only model helps nobody, it just
 * guarantees the retry has nowhere to go.
 */
export function demoteModel({
  providerId, model, apiKey, task, mode = 'json', reason, chainLength = 0, now = Date.now(),
}) {
  if (chainLength < 2) return false;
  const { baseUrl } = getProvider(providerId);
  applyCooldown({ baseUrl, model, apiKey }, {
    failureType: 'task_validation_failed', reason, task, mode, retryAfterMs: null, now,
  });
  return true;
}

// --- chain construction ----------------------------------------------------

const modeFor = (entry, jsonMode) => {
  if (!jsonMode) return 'text';
  return strictJsonDisabled(entry.baseUrl, entry.model, entry.apiKey) ? 'text' : 'json';
};

/**
 * Resolve a task's curated route chain into concrete chain entries.
 *
 * @param {Array<{providerId: string, apiKey: string, model?: string}>} chain
 *   The user's configured credentials. Order is irrelevant except for pins:
 *   the ORDER OF ATTEMPTS comes from TASK_CHAINS, not from this array. That is
 *   deliberate -- the curated order is the battle-tested part, and letting a
 *   UI provider-picker reshuffle it would quietly discard that.
 * @param {object} [opts]
 * @param {string} [opts.task] - 'resume' | 'skills' | 'coverLetter' | 'judge'
 */
export function buildChainEntries(chain, { task } = {}) {
  const keys = new Map();
  const pins = [];
  for (const entry of chain || []) {
    if (!entry || !entry.providerId || !entry.apiKey) continue;
    if (!keys.has(entry.providerId)) keys.set(entry.providerId, entry.apiKey);
    // An explicitly named model is a deliberate choice. It is honoured first
    // and exempted from task policy: the user asked for that model, so
    // substituting one this table prefers would be overriding them.
    if (entry.model) {
      pins.push({
        providerId: entry.providerId,
        apiKey: entry.apiKey,
        model: entry.model,
        baseUrl: getProvider(entry.providerId).baseUrl,
        route: 'pinned',
        pinned: true,
      });
    }
  }
  if (pins.length) return pins;

  // No task, or an unknown one, walks LLM_PROVIDER_CHAIN -- v4's behaviour for
  // a caller with no opinion. Not every route in ROUTES: the pinned aliases
  // and the pool routes overlap, so that would attempt some models twice.
  const routeNames = taskChain(task);
  const names = routeNames.length ? routeNames : DEFAULT_CHAIN;

  // Group per route, dropping retired models (llm.py:1804) and routes whose
  // provider the user has no key for (llm.py:2088 logs and skips; an
  // unconfigured provider is a normal state, not an error).
  const groups = [];
  for (const name of names) {
    const route = ROUTES[name];
    if (!route) continue;
    const apiKey = keys.get(route.providerId);
    if (!apiKey) continue;
    const { baseUrl } = getProvider(route.providerId);
    const models = route.models.filter((m) => !DEPRECATED_MODEL_IDS.has(m));
    if (!models.length) continue;
    groups.push(models.map((model) => ({
      providerId: route.providerId, apiKey, model, baseUrl, route: name, pinned: false,
    })));
  }

  // llm.py:2094. Interleave by model index across routes, so a route that
  // resolves to a pool does not spend every one of its models before the next
  // route gets a turn. With single-model routes -- the common case -- this is
  // the identity, and chain order is preserved exactly.
  const interleaved = [];
  const deepest = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < deepest; i++) {
    for (const group of groups) if (group[i]) interleaved.push(group[i]);
  }

  const policy = taskPolicy(task);
  if (!policy) return interleaved;

  const eligible = interleaved.filter((e) => !policy.excluded.includes(e.model));

  // llm.py:2280. The asymmetry is v4's: a resume from a model known to break
  // structured output is worse than no resume, but a slightly-off cover letter
  // still beats nothing.
  if (!eligible.length && interleaved.length) {
    if (STRICT_EXCLUSION_TASKS.has(task)) {
      throw new LlmError(
        'provider_configuration_error',
        `Every configured model is excluded for ${task}. Configure a provider with an eligible model.`,
      );
    }
    return interleaved;
  }

  // Rank by the task's preference; anything unranked keeps its interleaved
  // position behind the ranked ones. Array.prototype.sort is stable, so the
  // curated chain order survives intact. Unranked is not a veto -- only
  // `excluded` is.
  const rank = (model) => {
    const i = policy.preferred.indexOf(model);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...eligible].sort((a, b) => rank(a.model) - rank(b.model));
}

// --- failure classification ------------------------------------------------

/**
 * Map a failure onto one of v4's failure types (llm.py:368 `_http_failure_type`
 * plus the loop's exception handlers at llm.py:1704-1720).
 *
 * There is no `retryable` flag by design. See note 1 at the top of this file:
 * in v4 every classified failure rotates, and severity is carried by the
 * cooldown scope and duration instead.
 */
export function classifyFailure(err) {
  if (!(err instanceof LlmError)) return 'provider_response_error';

  switch (err.kind) {
    case 'timeout': return 'provider_timeout';
    case 'network_error': return 'transport_error';
    case 'empty_response': return 'empty_response';
    case 'malformed_response': return 'provider_response_error';
    default: break;
  }
  if (err.kind !== 'http_error') return 'provider_response_error';

  const status = (err.detail && err.detail.status) || 0;
  const body = String((err.detail && err.detail.preview) || '').toLowerCase().replace(/-/g, '_');

  // Checked before the generic 400 branch: a bad key is a configuration
  // problem worth a long hold, not a malformed request worth 30 seconds.
  if (status === 400 && /invalid api key|invalid_api_key|api key not valid|please pass a valid api key/.test(body)) {
    return 'provider_configuration_error';
  }
  if (status === 429) {
    const temporary = /requests? per minute|tokens? per minute|rate_limit_exceeded|rate limit reached|queue_exceeded|high traffic/.test(body);
    if (temporary) return 'rate_limited';
    const quota = /insufficient_quota|quota exceeded|quota_exceeded|exceeded your current quota|daily quota|free tier quota|billing quota|billing details/.test(body);
    // Note the default: an unrecognised 429 is read as the MILD case. Guessing
    // "quota" costs 15 minutes on a model that was throttled for 3 seconds.
    return quota ? 'quota_exhausted' : 'rate_limited';
  }
  if (status === 401 || status === 403) return 'provider_configuration_error';
  // 402, or any body that names payment or quota. v4 does NOT enumerate 402 --
  // it falls through to `provider_error` with a task-scoped 30-second hold --
  // and that is a gap rather than a decision, so this fills it rather than
  // contradicting it.
  //
  // Measured live: a Cerebras key with no credit answers every request with
  // 402 {"code":"payment_required","param":"quota"}, persistently. Under a
  // 30-second task hold, every run burns one wasted call on a credential that
  // cannot possibly succeed today. v4's own principle -- infrastructure faults
  // are shared-scope, quality faults are task-scoped -- puts this squarely in
  // the first group: no money is a fact about the credential everywhere, for
  // every task, for a long time.
  if (status === 402 || /payment required|payment_required|insufficient credit|insufficient_quota/.test(body)) {
    return 'quota_exhausted';
  }
  if (status === 400 || status === 409 || status === 422) return 'request_incompatible';
  if (status === 404) return 'provider_configuration_error';
  if (status === 408 || status === 425) return 'rate_limited';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'provider_unavailable';
  // 402 and 413 land here, exactly as they do in v4: unlisted, so
  // `provider_error` with a task-scoped 30-second hold. Both rotate.
  return 'provider_error';
}

// --- error aggregation -----------------------------------------------------

/** llm.py:1396. One specific code when every model agrees, else the generic. */
function unavailableError(statuses, lastError) {
  const types = statuses.map((s) => s.failureType || 'provider_error');
  const retries = statuses.map((s) => s.retryAfterSeconds).filter((n) => Number.isFinite(n));
  const retryAfterSeconds = retries.length ? Math.min(...retries) : null;
  const hint = retryAfterSeconds != null ? ` Retry in about ${retryAfterSeconds}s.` : '';
  const all = (type) => statuses.length > 0 && types.every((t) => t === type);

  let kind = 'providers_temporarily_unavailable';
  let message = `Configured LLM providers are temporarily unavailable for this task.${hint}`;
  if (all('quota_exhausted')) {
    kind = 'quota_exhausted';
    message = `All ${statuses.length} configured model(s) reported quota exhaustion.${hint} Add another provider key or wait for the reset.`;
  } else if (all('rate_limited')) {
    kind = 'rate_limited';
    message = `All configured models are temporarily rate-limited.${hint}`;
  } else if (all('provider_configuration_error')) {
    kind = 'provider_configuration_error';
    message = 'Providers rejected their credentials or model configuration. Check your API keys.';
  } else if (all('task_validation_failed')) {
    kind = 'task_validation_failed';
    message = 'Configured models returned output that did not pass validation. No quota exhaustion was detected.';
  }

  const summary = statuses.map((s) => `${s.providerId}/${s.model}: ${s.failureType}`).join('; ');
  return new LlmError(kind, `${message}${summary ? ` — ${summary}` : ''}`, {
    attempts: statuses, retryAfterSeconds, lastError: lastError && lastError.message,
  });
}

/**
 * llm.py:1366. Include entries SKIPPED for an existing cooldown, not just
 * those attempted on this call -- otherwise the error claims "all providers
 * exhausted" when one merely has a 30-second task-local hold.
 */
function skippedStatuses(entries, { task, jsonMode, now }) {
  const out = [];
  for (const entry of entries) {
    const state = cooldownFor(entry, { task, mode: modeFor(entry, jsonMode), now });
    if (!state) continue;
    out.push({
      providerId: entry.providerId, model: entry.model, status: 'cooling',
      failureType: state.failureType, cooldownScope: state.scope,
      retryAfterSeconds: Math.max(1, Math.round((state.until - now) / 1000)),
      detail: state.reason,
    });
  }
  return out;
}

// --- the loop --------------------------------------------------------------

/**
 * Try each entry in the task's curated chain until one succeeds.
 *
 * @returns {Promise<{content: string, usage: object, providerId: string, model: string, attempts: Array}>}
 */
export async function chatWithRotation({
  chain, messages, jsonMode, maxTokens, timeoutMs, reasoningEffort, task,
  fetchImpl, sleepImpl, nowFn = Date.now, baseUrlOverride,
}) {
  const entries = buildChainEntries(chain, { task });
  if (!entries.length) {
    throw new LlmError(
      'provider_configuration_error',
      'No eligible model for this task. Add an API key for a provider this task can use.',
    );
  }

  const now0 = nowFn();
  const order = entries.filter((e) => !cooldownFor(e, { task, mode: modeFor(e, jsonMode), now: now0 }));

  // llm.py:1483. If everything is cooling, FAIL NOW with the wait time rather
  // than sending requests we already know will be refused. An earlier version
  // tried the whole chain anyway, reasoning that a stale cooldown should not
  // hard-block the user -- but a cooldown is not stale, it is a measurement,
  // and ignoring it turns one rate limit into a chain-length burst of them.
  if (!order.length) {
    throw unavailableError(skippedStatuses(entries, { task, jsonMode, now: now0 }), null);
  }

  const attempts = [];
  let lastError = null;

  for (const entry of entries) {
    const now = nowFn();
    const mode = modeFor(entry, jsonMode);
    if (cooldownFor(entry, { task, mode, now })) continue;

    const effectiveJsonMode = mode === 'json';
    const baseUrl = baseUrlOverride || entry.baseUrl;
    const rateArgs = { baseUrl, model: entry.model, apiKey: entry.apiKey };

    // Pre-flight budget check. A refusal is NOT a failure: the model is
    // healthy, we simply declined to ask it right now, so no cooldown is set
    // and the next entry gets a turn (llm.py:1586).
    const reservation = reserveRateBudget({ ...rateArgs, messages, maxTokens, now });
    if (!reservation.allowed) {
      attempts.push({
        providerId: entry.providerId, model: entry.model, status: 'local_rate_limited',
        failureType: 'rate_limited', cooldownScope: 'local_budget',
        detail: reservation.reason,
        retryAfterSeconds: Math.max(1, Math.round((reservation.retryAfterMs || 0) / 1000)),
        estimatedTokens: reservation.estimatedTokens,
        tpmLimit: reservation.tpmLimit,
      });
      continue;
    }

    try {
      const response = await chat({
        provider: { ...getProvider(entry.providerId), baseUrl },
        apiKey: entry.apiKey,
        model: entry.model,
        messages,
        jsonMode: effectiveJsonMode,
        maxTokens,
        timeoutMs,
        reasoningEffort,
        // llm.py:1607. The pool IS the retry mechanism: internal backoff on a
        // chain with somewhere to go only makes the run look hung. With one
        // entry there is nowhere to go, so backoff is the only option left.
        allowInternalRetry: order.length === 1,
        fetchImpl,
        sleepImpl,
      });

      reconcileReservation({
        ...rateArgs,
        reservationId: reservation.reservationId,
        actualTokens: response.usage && response.usage.totalTokens,
      });
      observeRateMetadata({ ...rateArgs, headers: response.headers, now });

      attempts.push({
        providerId: entry.providerId, model: entry.model, status: 'success',
        jsonModeRequested: Boolean(jsonMode), jsonModeUsed: effectiveJsonMode,
        estimatedTokens: reservation.estimatedTokens,
        actualTokens: (response.usage && response.usage.totalTokens) ?? null,
      });
      return { ...response, providerId: entry.providerId, model: entry.model, mode, attempts };
    } catch (err) {
      lastError = err;
      const failureType = classifyFailure(err);
      const detail = String((err.detail && err.detail.preview) || err.message || '');
      const retryAfterMs = (err.detail && err.detail.retryAfterMs) || null;

      observeRateMetadata({
        ...rateArgs,
        headers: err.detail && err.detail.headers,
        detail: failureType === 'rate_limited' ? detail : '',
        retryAfterMs: failureType === 'rate_limited' ? retryAfterMs : null,
        now,
      });

      // llm.py:1657. A provider that rejects server-side structured output is
      // remembered, and every later JSON call to it uses prompt-only JSON
      // instead of rediscovering the same rejection.
      if (effectiveJsonMode && failureType === 'request_incompatible' && isStrictJsonRejection(detail)) {
        markStrictJsonUnsupported(baseUrl, entry.model, entry.apiKey);
      }

      const state = applyCooldown(entry, { failureType, reason: detail, task, mode, retryAfterMs, now });
      attempts.push({
        providerId: entry.providerId, model: entry.model,
        status: err.detail && err.detail.status ? `http_${err.detail.status}` : 'error',
        failureType, cooldownScope: state.scope, detail,
        retryAfterSeconds: Math.max(1, Math.round((state.until - nowFn()) / 1000)),
        jsonModeRequested: Boolean(jsonMode), jsonModeUsed: effectiveJsonMode,
      });
      // Note the absence of a rethrow. Everything rotates.
    }
  }

  const failed = attempts.filter((a) => a.status !== 'success');
  const skipped = skippedStatuses(entries, { task, jsonMode, now: nowFn() })
    .filter((s) => !attempts.some((a) => a.providerId === s.providerId && a.model === s.model));
  throw unavailableError([...failed, ...skipped], lastError);
}

/** Diagnostics: what the resolved chain looks like, without making a call. */
export function describeChain(chain, task) {
  return buildChainEntries(chain, { task })
    .map((e) => ({ providerId: e.providerId, model: e.model, route: e.route }));
}

export { TASK_CHAINS };
