// rotatingClient.test.mjs — failover behaviour, ported from HirePilot v4.
//
// This file was rewritten when the rotation was brought to v4 parity. Two of
// its previous tests asserted behaviour that turned out to be BACKWARDS
// against v4, and are now inverted here with the reasoning recorded:
//
//   - "a 400 fails fast, rotating would reproduce it" — v4 classifies 400/409/
//     422 as `request_incompatible`, holds that model for 30s on the TASK
//     scope, and tries the next entry. A 400 is very often a property of the
//     model (a parameter it does not accept, a schema it cannot express), not
//     of the request, and throwing killed whole runs over it.
//   - "when everything is cooling, try the chain anyway" — v4 raises
//     immediately with the wait time. A cooldown is a measurement, not noise;
//     ignoring it converts one rate limit into a chain-length burst of them.
//
// Chain SHAPE is pinned in chainParity.test.mjs against v4's own reported
// chains. This file tests what happens when calls fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatWithRotation, classifyFailure, cooldownPolicy, resetCooldowns, cooldownState,
  buildChainEntries, demoteModel, describeChain,
  COOLDOWN_MS, TASK_FAILURE_COOLDOWN_MS, SHARED_SCOPE_FAILURES,
} from '../../extension/engine/rotatingClient.js';
import { LlmError, resetReasoningEffortSupport, strictJsonDisabled } from '../../extension/engine/llm.js';
import { resetRateWindows } from '../../extension/engine/rateWindow.js';

/** All four keys — the configuration v4's chains were measured under. */
const CHAIN = [
  { providerId: 'gemini', apiKey: 'k1' },
  { providerId: 'groq', apiKey: 'k2' },
  { providerId: 'cerebras', apiKey: 'k3' },
  { providerId: 'openrouter', apiKey: 'k4' },
];

// The resume chain, in v4's order. Kept here as a local expectation so a
// failure in this file points at failover, not at chain construction (which
// chainParity.test.mjs owns). Seven entries: the resume tasks take v4's
// default chain filtered by the resume policy.
const RESUME_ORDER = [
  'gemini-3.1-flash-lite', 'qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'gpt-oss-120b',
  'gemini-2.5-flash', 'openai/gpt-oss-20b', 'zai-glm-4.7',
];

function fresh() {
  resetCooldowns();
  resetRateWindows();
  resetReasoningEffortSupport();
}

/**
 * Every call goes through here so no test ever waits on a real backoff.
 *
 * A one-entry chain enables v4's internal retry (10s, 20s, 40s...), which is
 * correct behaviour and takes a minute of wall clock to observe. The sleep
 * seam is the same injection point llm.js exposes for exactly this.
 */
const run = (opts) => chatWithRotation({ sleepImpl: async () => {}, ...opts });

const okBody = (content = 'ok') => JSON.stringify({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

const ok = (content) => new Response(okBody(content), { status: 200 });

const fail = (status, preview = '', headers = {}) => new Response(preview || `HTTP ${status}`, { status, headers });

/**
 * Route by the MODEL in the request body, not by hostname — the resume chain
 * has two Groq entries, so hostname alone cannot distinguish them.
 *
 * @param {Object<string, () => Response>} handlers model -> response
 */
function modelRoutedFetch(handlers, { onCall } = {}) {
  const seen = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (onCall) onCall(body);
    const handler = handlers[body.model];
    return handler ? handler() : ok();
  };
  return { impl, seen };
}

// --- classifyFailure -------------------------------------------------------
//
// Returns a v4 failure-type STRING. There is deliberately no `retryable`
// flag: in v4 everything rotates, and severity is carried by the cooldown
// scope and duration instead.

test('a 429 that names a per-minute limit is a rate limit, not exhausted quota', () => {
  assert.equal(
    classifyFailure(new LlmError('http_error', 'x', { status: 429, preview: 'Rate limit reached for requests per minute' })),
    'rate_limited',
  );
});

test('a 429 that names quota or billing is quota exhaustion', () => {
  for (const preview of ['You exceeded your current quota', 'insufficient_quota', 'check your billing details']) {
    assert.equal(
      classifyFailure(new LlmError('http_error', 'x', { status: 429, preview })),
      'quota_exhausted', `misread: ${preview}`,
    );
  }
});

test('an unrecognised 429 reads as the MILD case', () => {
  // Deliberate, and it matters: guessing "quota" costs a 15-minute hold on a
  // model that was throttled for three seconds.
  assert.equal(
    classifyFailure(new LlmError('http_error', 'x', { status: 429, preview: 'Too many requests, slow down' })),
    'rate_limited',
  );
});

test('a 400 naming a bad key is a config error, checked before the generic 400', () => {
  assert.equal(
    classifyFailure(new LlmError('http_error', 'x', { status: 400, preview: 'API key not valid. Please pass a valid API key.' })),
    'provider_configuration_error',
  );
});

test('a plain 400, 409 or 422 is request_incompatible — and rotates', () => {
  // The inversion. Previously this asserted a non-retryable failure.
  for (const status of [400, 409, 422]) {
    assert.equal(classifyFailure(new LlmError('http_error', 'x', { status })), 'request_incompatible');
  }
  assert.ok(!SHARED_SCOPE_FAILURES.has('request_incompatible'), 'should be a task-scoped hold, not shared');
  assert.equal(cooldownPolicy('request_incompatible').ms, TASK_FAILURE_COOLDOWN_MS);
});

test('401, 403 and 404 are all configuration errors worth a long hold', () => {
  for (const status of [401, 403, 404]) {
    assert.equal(classifyFailure(new LlmError('http_error', 'x', { status })), 'provider_configuration_error');
  }
  assert.equal(cooldownPolicy('provider_configuration_error').ms, COOLDOWN_MS.provider_configuration_error);
});

test('408 and 425 are rate limits; 5xx is provider unavailability', () => {
  for (const status of [408, 425]) {
    assert.equal(classifyFailure(new LlmError('http_error', 'x', { status })), 'rate_limited');
  }
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyFailure(new LlmError('http_error', 'x', { status })), 'provider_unavailable');
  }
});

test('413 falls through to provider_error, exactly as in v4', () => {
  // Not in v4's status table, so it lands on the default branch with a
  // task-scoped 30s hold. It rotates, which is the part that matters -- a live
  // run once died on the spot to a 413.
  assert.equal(classifyFailure(new LlmError('http_error', 'x', { status: 413 })), 'provider_error');
  assert.equal(cooldownPolicy('provider_error').scope, 'task');
});

test('402 is quota exhaustion, a DELIBERATE deviation from v4', () => {
  // v4 does not enumerate 402; it falls through to provider_error and a
  // 30-second task hold. Measured against a real Cerebras key with no credit,
  // that means every run burns a wasted call on a credential that cannot
  // succeed today -- the 402 is persistent and says so:
  //   {"message":"Payment required...","type":"payment_required_error",
  //    "param":"quota","code":"payment_required"}
  //
  // Filling the gap the way v4's own scope principle implies: infrastructure
  // faults are shared, and "no money" is a fact about the credential for every
  // task, for a long time.
  assert.equal(classifyFailure(new LlmError('http_error', 'x', { status: 402 })), 'quota_exhausted');
  assert.equal(cooldownPolicy('quota_exhausted').scope, 'shared');
  assert.equal(cooldownPolicy('quota_exhausted').ms, COOLDOWN_MS.quota_exhausted);
});

test('a payment-required body is caught even behind a different status', () => {
  // Providers are inconsistent about the status they attach to an empty
  // wallet; the body is the reliable signal.
  assert.equal(
    classifyFailure(new LlmError('http_error', 'x', { status: 400, preview: 'Payment required to access this resource.' })),
    'quota_exhausted',
  );
});

test('transport, timeout and empty responses map to their own types', () => {
  assert.equal(classifyFailure(new LlmError('timeout', 'x')), 'provider_timeout');
  assert.equal(classifyFailure(new LlmError('network_error', 'x')), 'transport_error');
  assert.equal(classifyFailure(new LlmError('empty_response', 'x')), 'empty_response');
  assert.equal(classifyFailure(new LlmError('malformed_response', 'x')), 'provider_response_error');
  assert.equal(classifyFailure(new Error('not an LlmError')), 'provider_response_error');
});

// --- cooldownPolicy: the two scopes ---------------------------------------

test('infrastructure faults are shared; quality faults are task-scoped', () => {
  // The load-bearing distinction. A quota is a fact about the model
  // everywhere. Unparseable output is a fact about the model on THIS task.
  for (const type of ['quota_exhausted', 'rate_limited', 'provider_configuration_error', 'provider_unavailable', 'transport_error']) {
    assert.equal(cooldownPolicy(type).scope, 'shared', `${type} should be shared`);
  }
  for (const type of ['request_incompatible', 'empty_response', 'provider_timeout', 'provider_response_error', 'task_validation_failed', 'provider_error']) {
    assert.equal(cooldownPolicy(type).scope, 'task', `${type} should be task-scoped`);
  }
});

test("a provider's own Retry-After overrides our constant", () => {
  // Guessing 15 minutes when the provider said 3 seconds is its own outage.
  assert.equal(cooldownPolicy('quota_exhausted').ms, 900_000);
  assert.equal(cooldownPolicy('quota_exhausted', 3_000).ms, 3_000);
});

// --- failover --------------------------------------------------------------

test('the first entry answers, and nothing else is touched', async () => {
  fresh();
  const { impl, seen } = modelRoutedFetch({});
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });
  assert.equal(res.model, RESUME_ORDER[0]);
  assert.deepEqual(seen, [RESUME_ORDER[0]]);
});

test('a rate limit fails over to the next entry in the curated order', async () => {
  fresh();
  const { impl, seen } = modelRoutedFetch({
    [RESUME_ORDER[0]]: () => fail(429, 'rate limit reached for requests per minute'),
  });
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });
  assert.equal(res.model, RESUME_ORDER[1]);
  assert.deepEqual(seen, [RESUME_ORDER[0], RESUME_ORDER[1]]);
});

test('a 400 now ROTATES rather than killing the run', async () => {
  fresh();
  const { impl, seen } = modelRoutedFetch({
    [RESUME_ORDER[0]]: () => fail(400, 'Unsupported value for parameter'),
  });
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });
  assert.equal(res.model, RESUME_ORDER[1], 'the run should survive a 400 on one model');
  assert.equal(seen.length, 2);
});

test('the whole chain is walked, and the last entry can still save the run', async () => {
  fresh();
  const { impl, seen } = modelRoutedFetch({
    [RESUME_ORDER[0]]: () => fail(500),
    [RESUME_ORDER[1]]: () => fail(429, 'requests per minute'),
    [RESUME_ORDER[2]]: () => fail(400, 'nope'),
  });
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });
  assert.equal(res.model, RESUME_ORDER[3]);
  assert.deepEqual(seen, RESUME_ORDER.slice(0, 4), 'it should stop at the first success');
});

test('when everything fails, the error names every attempt and its reason', async () => {
  fresh();
  const { impl } = modelRoutedFetch(Object.fromEntries(
    RESUME_ORDER.map((m) => [m, () => fail(500)]),
  ));
  await assert.rejects(
    run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl }),
    (err) => {
      assert.equal(err.kind, 'provider_unavailable' in COOLDOWN_MS ? 'providers_temporarily_unavailable' : err.kind);
      assert.equal(err.detail.attempts.length, RESUME_ORDER.length);
      for (const model of RESUME_ORDER) {
        assert.ok(err.message.includes(model), `error should mention ${model}`);
      }
      return true;
    },
  );
});

test('unanimous quota exhaustion is reported as quota_exhausted, not a generic failure', async () => {
  fresh();
  const { impl } = modelRoutedFetch(Object.fromEntries(
    RESUME_ORDER.map((m) => [m, () => fail(429, 'You exceeded your current quota')]),
  ));
  await assert.rejects(
    run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl }),
    (err) => err.kind === 'quota_exhausted',
  );
});

test('a mixed set of failures reports the generic code, not a misleading specific one', async () => {
  fresh();
  const { impl } = modelRoutedFetch({
    [RESUME_ORDER[0]]: () => fail(429, 'You exceeded your current quota'),
    ...Object.fromEntries(RESUME_ORDER.slice(1).map((m) => [m, () => fail(500)])),
  });
  await assert.rejects(
    run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl }),
    (err) => err.kind === 'providers_temporarily_unavailable',
  );
});

test('an empty chain is a clear configuration error, not a crash', async () => {
  fresh();
  await assert.rejects(
    run({ chain: [], messages: [], task: 'resume', fetchImpl: async () => ok() }),
    (err) => err.kind === 'provider_configuration_error',
  );
});

// --- cooldowns across calls ------------------------------------------------

test('a rate-limited model is skipped on the next call while its hold stands', async () => {
  fresh();
  const first = modelRoutedFetch({
    [RESUME_ORDER[0]]: () => fail(429, 'requests per minute'),
  });
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: first.impl });

  const second = modelRoutedFetch({});
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: second.impl });
  assert.equal(res.model, RESUME_ORDER[1], 'the cooling model should not be retried');
  assert.deepEqual(second.seen, [RESUME_ORDER[1]]);
});

test('a hold expires, and the model comes back', async () => {
  fresh();
  let now = 1_000_000;
  const nowFn = () => now;
  const first = modelRoutedFetch({ [RESUME_ORDER[0]]: () => fail(429, 'requests per minute') });
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: first.impl, nowFn });

  now += COOLDOWN_MS.rate_limited + 1;
  const second = modelRoutedFetch({});
  const res = await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: second.impl, nowFn });
  assert.equal(res.model, RESUME_ORDER[0]);
});

test('a quota failure holds far longer than a plain rate limit', async () => {
  fresh();
  const { impl } = modelRoutedFetch({ [RESUME_ORDER[0]]: () => fail(429, 'You exceeded your current quota') });
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });
  const [entry] = Object.values(cooldownState());
  assert.equal(entry.failureType, 'quota_exhausted');
  assert.ok(entry.seconds > 600, `expected a long hold, got ${entry.seconds}s`);
});

test('when every entry is cooling, the call fails NOW with the wait time', async () => {
  // The second inversion. Previously this asserted the chain was tried anyway.
  fresh();
  const { impl } = modelRoutedFetch(Object.fromEntries(
    RESUME_ORDER.map((m) => [m, () => fail(429, 'requests per minute')]),
  ));
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl }).catch(() => {});

  const second = modelRoutedFetch({});
  await assert.rejects(
    run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: second.impl }),
    (err) => {
      assert.equal(err.kind, 'rate_limited');
      assert.ok(err.detail.retryAfterSeconds > 0, 'the caller needs to know how long to wait');
      return true;
    },
  );
  assert.deepEqual(second.seen, [], 'not one request should have been sent');
});

// --- the two scopes, observably ------------------------------------------

test('a QUALITY failure on one task leaves the same model usable for another', async () => {
  // The whole reason task scope exists. gpt-oss-120b failing to hold a JSON
  // schema says nothing about its prose -- and vice versa.
  fresh();
  const { impl } = modelRoutedFetch({ [RESUME_ORDER[0]]: () => fail(422, 'schema not supported') });
  await run({ chain: CHAIN, messages: [], task: 'resume', jsonMode: true, fetchImpl: impl });

  // gemini-3.1-flash-lite is 3rd in the letter chain; confirm it is not held.
  const letter = modelRoutedFetch({
    'gemma-4-31b': () => fail(500),
    'qwen/qwen3.6-27b': () => fail(500),
  });
  const res = await run({
    chain: CHAIN, messages: [], task: 'coverLetter', jsonMode: true, fetchImpl: letter.impl,
  });
  assert.equal(res.model, 'gemini-3.1-flash-lite', 'a resume-scoped hold must not block the letter');
});

test('an INFRASTRUCTURE failure on one task holds the model for every task', async () => {
  fresh();
  const { impl } = modelRoutedFetch({
    // gemini leads the resume chain, so it has to fail for Groq to be reached
    // at all. Transport error -> shared, but on a DIFFERENT model, so it does
    // not confound what this test is checking.
    [RESUME_ORDER[0]]: () => fail(503),
    'qwen/qwen3.6-27b': () => fail(429, 'You exceeded your current quota'),
  });
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl });

  // qwen3.6-27b leads the judge chain. A quota is a fact about the model, so
  // the judge must skip it too.
  const judge = modelRoutedFetch({});
  const res = await run({ chain: CHAIN, messages: [], task: 'judge', fetchImpl: judge.impl });
  assert.equal(res.model, 'gemma-4-31b', 'a shared hold should apply across tasks');
});

test('two keys for the same model cool down independently', async () => {
  fresh();
  const chainA = [{ providerId: 'gemini', apiKey: 'key-A' }];
  const chainB = [{ providerId: 'gemini', apiKey: 'key-B' }];
  const { impl } = modelRoutedFetch({ [RESUME_ORDER[0]]: () => fail(429, 'You exceeded your current quota') });
  await run({ chain: chainA, messages: [], task: 'resume', fetchImpl: impl }).catch(() => {});

  const second = modelRoutedFetch({});
  const res = await run({ chain: chainB, messages: [], task: 'resume', fetchImpl: second.impl });
  assert.equal(res.model, RESUME_ORDER[0], "key B's budget is its own");
});

test('an entry skipped for an existing hold still appears in the failure report', async () => {
  // llm.py:1366. Otherwise the error claims "everything is exhausted" when one
  // model merely has a 30-second task-local hold.
  fresh();
  const warmup = modelRoutedFetch({ [RESUME_ORDER[0]]: () => fail(429, 'You exceeded your current quota') });
  await run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: warmup.impl });

  const { impl } = modelRoutedFetch(Object.fromEntries(
    RESUME_ORDER.slice(1).map((m) => [m, () => fail(500)]),
  ));
  await assert.rejects(
    run({ chain: CHAIN, messages: [], task: 'resume', fetchImpl: impl }),
    (err) => {
      const reported = err.detail.attempts.map((a) => a.model);
      assert.ok(reported.includes(RESUME_ORDER[0]), 'the cooling model should be listed');
      assert.equal(err.detail.attempts.length, RESUME_ORDER.length);
      return true;
    },
  );
});

// --- quality demotion -----------------------------------------------------

test('demoteModel holds a model for one task, and no-ops when it is the only one', () => {
  fresh();
  assert.equal(
    demoteModel({ providerId: 'gemini', model: RESUME_ORDER[0], apiKey: 'k1', task: 'resume', reason: 'bad output', chainLength: 1 }),
    false, 'demoting your only model just leaves the retry nowhere to go',
  );
  assert.deepEqual(cooldownState(), {});

  assert.equal(
    demoteModel({ providerId: 'gemini', model: RESUME_ORDER[0], apiKey: 'k1', task: 'resume', reason: 'bad output', chainLength: 4 }),
    true,
  );
  const [state] = Object.values(cooldownState());
  assert.equal(state.failureType, 'task_validation_failed');
  assert.equal(state.scope, 'task');
});

test('a demoted model is skipped on the retry, so the next attempt is a different model', async () => {
  fresh();
  demoteModel({
    providerId: 'gemini', model: RESUME_ORDER[0], apiKey: 'k1',
    task: 'resume', mode: 'json', reason: 'dropped a quantity', chainLength: 4,
  });
  const { impl } = modelRoutedFetch({});
  const res = await run({
    chain: CHAIN, messages: [], task: 'resume', jsonMode: true, fetchImpl: impl,
  });
  assert.equal(res.model, RESUME_ORDER[1]);
});

// --- strict JSON fallback -------------------------------------------------

test('a rejected response_format is learned, and the model comes back in prose mode', async () => {
  // Two v4 mechanisms interlocking, which is why this is worth a test of its
  // own. The 422 marks the model strict-JSON-incapable AND sets a task hold
  // keyed on mode='json'. On the next call the mode is 'text', so the hold
  // does not match and the model is eligible again -- asked for JSON in the
  // prompt instead of the request. A model that cannot do `response_format`
  // is thereby degraded, not burned.
  fresh();
  const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
  const seen = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ model: body.model, strict: Boolean(body.response_format) });
    if (body.model === RESUME_ORDER[0] && body.response_format) {
      return fail(422, 'response_format is not supported by this model');
    }
    return ok();
  };

  const first = await run({ chain: CHAIN, messages: [], task: 'resume', jsonMode: true, fetchImpl: impl });
  assert.equal(first.model, RESUME_ORDER[1], 'the rejection should rotate, not fail');
  assert.ok(strictJsonDisabled(GEMINI_URL, RESUME_ORDER[0], 'k1'), 'the rejection must be remembered');

  const second = await run({ chain: CHAIN, messages: [], task: 'resume', jsonMode: true, fetchImpl: impl });
  assert.equal(second.model, RESUME_ORDER[0], 'the degraded model should be usable again');
  assert.equal(second.mode, 'text');
  const last = seen[seen.length - 1];
  assert.deepEqual(last, { model: RESUME_ORDER[0], strict: false }, 'and asked without response_format');
});

// --- rate reservation -----------------------------------------------------

test('a request over the local TPM budget is skipped without a cooldown', async () => {
  // Groq's configured limit is 8000 TPM. A prompt large enough to breach it
  // should cause the entry to be PASSED OVER, not punished -- the model is
  // healthy, we simply declined to ask.
  fresh();
  const huge = [{ role: 'user', content: 'x'.repeat(40_000) }];
  const { impl, seen } = modelRoutedFetch({});
  const res = await run({
    chain: CHAIN, messages: huge, maxTokens: 3072, task: 'resume', fetchImpl: impl,
  });
  assert.equal(res.model, RESUME_ORDER[0], 'gemini has no configured TPM cap, so it serves');
  assert.ok(!seen.includes('qwen/qwen3.6-27b'), 'the Groq entries should not have been reached');
  assert.deepEqual(cooldownState(), {}, 'declining to send is not a failure and must not set a hold');
});

// --- chain construction seams --------------------------------------------

test('a pinned model is honoured and exempt from task policy', () => {
  fresh();
  const entries = buildChainEntries(
    [{ providerId: 'cerebras', apiKey: 'k', model: 'gemma-4-31b' }],
    { task: 'resume' },
  );
  assert.deepEqual(entries.map((e) => e.model), ['gemma-4-31b']);
  assert.equal(entries[0].pinned, true);
});

test('no task walks every route, for a caller with no opinion', () => {
  fresh();
  const models = buildChainEntries(CHAIN, {}).map((e) => e.model);
  assert.ok(models.includes(RESUME_ORDER[0]));
  assert.ok(models.includes('gemma-4-31b'), 'without a policy, nothing is filtered out');
});

test('describeChain reports the resolved order without making a call', () => {
  fresh();
  assert.deepEqual(
    describeChain(CHAIN, 'judge').map((e) => e.model),
    ['qwen/qwen3.6-27b', 'gemma-4-31b', 'gemini-3.1-flash-lite'],
  );
});
