import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatWithRotation, classifyFailure, resetCooldowns, cooldownState, COOLDOWN_MS,
  buildChainEntries,
} from '../../extension/engine/rotatingClient.js';
import { LlmError } from '../../extension/engine/llm.js';
import { getProvider } from '../../extension/engine/providers.js';

const CHAIN = [
  { providerId: 'gemini', apiKey: 'k1' },
  { providerId: 'groq', apiKey: 'k2' },
  { providerId: 'cerebras', apiKey: 'k3' },
];

/**
 * Total chain entries for a set of providers: one per model in each pool.
 *
 * Derived rather than hardcoded, because the model pools track the
 * battle-tested rotation in the user's own .env and move whenever that does.
 * A literal here needed chasing the moment Cerebras dropped from two models
 * to one.
 */
function expectedChainLength(providerIds) {
  return providerIds.reduce((n, id) => n + getProvider(id).models.length, 0);
}

function ok(content = 'ok') {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

/** Route by hostname so a test can fail specific providers deterministically. */
function routedFetch(handlers) {
  return async (url) => {
    for (const [needle, handler] of Object.entries(handlers)) {
      if (url.includes(needle)) return handler();
    }
    return ok();
  };
}

// --- classifyFailure ---

test('classifyFailure distinguishes a quota 429 from a plain rate-limit 429', () => {
  const quota = new LlmError('http_error', 'x', { status: 429, preview: 'You exceeded your current quota' });
  assert.equal(classifyFailure(quota).kind, 'quota_exhausted');
  const rate = new LlmError('http_error', 'x', { status: 429, preview: 'Too many requests, slow down' });
  assert.equal(classifyFailure(rate).kind, 'rate_limited');
});

test('classifyFailure treats 401/403 as a config error worth a long cooldown', () => {
  assert.equal(classifyFailure(new LlmError('http_error', 'x', { status: 401 })).kind, 'config_error');
  assert.equal(classifyFailure(new LlmError('http_error', 'x', { status: 403 })).kind, 'config_error');
});

test('classifyFailure marks a 400 non-retryable -- rotating would reproduce it', () => {
  const c = classifyFailure(new LlmError('http_error', 'x', { status: 400 }));
  assert.equal(c.retryable, false);
  assert.equal(c.kind, 'request_error');
});

test('classifyFailure treats timeouts, network errors, and 5xx as transient', () => {
  assert.equal(classifyFailure(new LlmError('timeout', 'x')).kind, 'transient');
  assert.equal(classifyFailure(new LlmError('network_error', 'x')).kind, 'transient');
  assert.equal(classifyFailure(new LlmError('http_error', 'x', { status: 503 })).kind, 'transient');
});

// --- rotation ---

test('chatWithRotation uses the first provider when it works, and does not touch the rest', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return ok('first'); };
  const result = await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.equal(result.content, 'first');
  assert.equal(result.providerId, 'gemini');
  assert.equal(seen.length, 1, 'must not call other providers once one succeeds');
});

test('chatWithRotation fails over to the next provider on a rate limit', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const fetchImpl = routedFetch({
    'generativelanguage.googleapis.com': () => new Response('Too many requests', { status: 429 }),
    'api.groq.com': () => ok('from groq'),
  });
  const result = await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.equal(result.content, 'from groq');
  assert.equal(result.providerId, 'groq');
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].kind, 'rate_limited');
});

test('chatWithRotation walks the whole chain and succeeds on the last provider', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const fetchImpl = routedFetch({
    'generativelanguage.googleapis.com': () => new Response('down', { status: 503 }),
    'api.groq.com': () => new Response('down', { status: 500 }),
    'api.cerebras.ai': () => ok('from cerebras'),
  });
  const result = await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.equal(result.providerId, 'cerebras');
  assert.equal(result.attempts.length, 3);
});

test('chatWithRotation stops immediately on a non-retryable 400 instead of burning the chain', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('bad request', { status: 400 }); };
  await assert.rejects(
    chatWithRotation({ chain: CHAIN, messages: [], fetchImpl }),
    (err) => err instanceof LlmError && err.detail.status === 400,
  );
  assert.equal(calls, 1, 'a malformed request must not be retried against every provider');
});

test('chatWithRotation throws a providers_unavailable error listing every attempt when all fail', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const fetchImpl = async () => new Response('down', { status: 503 });
  await assert.rejects(
    chatWithRotation({ chain: CHAIN, messages: [], fetchImpl }),
    (err) => {
      assert.equal(err.kind, 'providers_unavailable');
      // 3 providers expanded across their model pools, whatever those currently are.
      assert.equal(err.detail.attempts.length, expectedChainLength(['gemini', 'groq', 'cerebras']));
      assert.match(err.message, /gemini\/gemini-2\.5-flash: transient/);
      assert.match(err.message, /cerebras\/gpt-oss-120b: transient/);
      return true;
    },
  );
});

test('chatWithRotation reports quota_exhausted when every provider is specifically out of quota', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const fetchImpl = async () => new Response('You exceeded your current quota', { status: 429 });
  await assert.rejects(
    chatWithRotation({ chain: CHAIN, messages: [], fetchImpl }),
    (err) => err.kind === 'quota_exhausted',
  );
});

// --- cooldowns ---

test('a rate-limited (provider, model) pair is skipped on the next call while its cooldown holds', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body).model);
    if (url.includes('googleapis')) return new Response('Too many requests', { status: 429 });
    return ok();
  };

  await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.deepEqual(bodies, ['gemini-3.1-flash-lite', 'qwen/qwen3.6-27b'],
    'should try the best gemini model, then fail over to the next provider');

  bodies.length = 0;
  await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.ok(!bodies.includes('gemini-3.1-flash-lite'),
    'the cooling-down model must be skipped on the next call');
});

test('a cooldown expires, and the provider is used again afterwards', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  let clock = 1_000_000;
  const nowFn = () => clock;
  let geminiShouldFail = true;
  const fetchImpl = async (url) => {
    if (url.includes('googleapis') && geminiShouldFail) return new Response('Too many requests', { status: 429 });
    return ok(url.includes('googleapis') ? 'gemini recovered' : 'fallback');
  };

  await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl, nowFn });
  assert.ok(cooldownState(clock)['gemini::gemini-3.1-flash-lite'] > 0, 'the throttled model should be cooling down');

  clock += COOLDOWN_MS.rate_limited + 1;
  geminiShouldFail = false;
  const result = await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl, nowFn });
  assert.equal(result.providerId, 'gemini', 'gemini should be back in rotation after the cooldown');
});

test('a quota failure earns a much longer cooldown than a plain rate limit', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const clock = 5_000_000;
  const fetchImpl = routedFetch({
    'generativelanguage.googleapis.com': () => new Response('insufficient_quota', { status: 429 }),
  });
  await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl, nowFn: () => clock });
  const remainingSecs = cooldownState(clock)['gemini::gemini-3.1-flash-lite'];
  assert.ok(remainingSecs > COOLDOWN_MS.rate_limited / 1000, `expected a long cooldown, got ${remainingSecs}s`);
});

test('when every provider is cooling down, the chain is still tried rather than hard-failing', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const clock = 9_000_000;
  // Put all three into cooldown first.
  await assert.rejects(chatWithRotation({
    chain: CHAIN, messages: [], fetchImpl: async () => new Response('down', { status: 503 }), nowFn: () => clock,
  }));
  // One cooldown per (provider, model) pair, not per provider.
  assert.equal(Object.keys(cooldownState(clock)).length, expectedChainLength(['gemini', 'groq', 'cerebras']));

  // A stale cooldown must not be able to block the user entirely.
  const result = await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl: async () => ok('recovered'), nowFn: () => clock });
  assert.equal(result.content, 'recovered');
});

test('chatWithRotation rejects an empty chain with a clear configuration error', async () => {
  resetCooldowns();
  await assert.rejects(
    chatWithRotation({ chain: [], messages: [] }),
    (err) => err.kind === 'provider_configuration_error',
  );
});

// --- per-model expansion and interleaving ---

test('buildChainEntries expands each provider into one entry per model', () => {
  // Asserted against the registry rather than a literal list: the pools carry
  // the .env's fallback depth and grow whenever that does.
  const entries = buildChainEntries([{ providerId: 'gemini', apiKey: 'k' }]);
  assert.deepEqual(entries.map((e) => e.model), getProvider('gemini').models);
  assert.ok(entries.every((e) => e.providerId === 'gemini' && e.apiKey === 'k'));
});

test('buildChainEntries interleaves round-robin by model index, not provider by provider', () => {
  // Every provider's BEST model before any provider's second: three keys give
  // three strong attempts before falling back, rather than draining one
  // provider's pool while two untouched providers wait.
  const entries = buildChainEntries([
    { providerId: 'gemini', apiKey: 'a' },
    { providerId: 'groq', apiKey: 'b' },
  ]);
  const gemini = getProvider('gemini').models;
  const groq = getProvider('groq').models;
  assert.deepEqual(entries.slice(0, 4).map((e) => `${e.providerId}/${e.model}`), [
    `gemini/${gemini[0]}`,
    `groq/${groq[0]}`,
    `gemini/${gemini[1]}`,
    `groq/${groq[1]}`,
  ]);
});

test('buildChainEntries respects an explicitly pinned model instead of widening to the pool', () => {
  const entries = buildChainEntries([{ providerId: 'gemini', apiKey: 'k', model: 'my-custom-model' }]);
  assert.deepEqual(entries.map((e) => e.model), ['my-custom-model']);
});

test('buildChainEntries handles providers with unequal pool sizes without leaving gaps', () => {
  // A pinned entry is a pool of one, so it drops out of the round-robin after
  // its single turn without stalling the providers behind it.
  const entries = buildChainEntries([
    { providerId: 'gemini', apiKey: 'a' },
    { providerId: 'groq', apiKey: 'b', model: 'only-one' },
  ]);
  const expected = getProvider('gemini').models.length + 1;
  assert.equal(entries.length, expected);
  assert.equal(entries.filter((e) => e.providerId === 'groq').length, 1);
});

test('a throttled model falls over to the next model on the same provider when no other key exists', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const tried = [];
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    tried.push(model);
    if (model === 'gemini-3.1-flash-lite') return new Response('Too many requests', { status: 429 });
    return ok('from the lighter model');
  };
  const result = await chatWithRotation({ chain: [{ providerId: 'gemini', apiKey: 'k' }], messages: [], fetchImpl });
  assert.deepEqual(tried, ['gemini-3.1-flash-lite', 'gemini-2.5-flash']);
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(result.content, 'from the lighter model');
});

test('cooling down one model leaves its sibling on the same provider usable', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const clock = 3_000_000;
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === 'gemini-3.1-flash-lite') return new Response('Too many requests', { status: 429 });
    return ok();
  };
  await chatWithRotation({ chain: [{ providerId: 'gemini', apiKey: 'k' }], messages: [], fetchImpl, nowFn: () => clock });
  const state = cooldownState(clock);
  assert.ok(state['gemini::gemini-3.1-flash-lite'] > 0, 'throttled model should be cooling');
  assert.equal(state['gemini::gemini-2.5-flash'], undefined, 'its sibling must NOT be cooling');
});

// --- statuses that killed real runs ----------------------------------------
//
// Each of these aborted a live run before it was classified. The principle
// they share: a status is non-retryable only if it is a property of the
// REQUEST. Anything that is a property of the provider or the model -- quota,
// credit, rate, size limit, availability -- must rotate, because the next
// entry in the chain does not share it.

test('a 413 "request too large for this model" rotates instead of killing the run', async () => {
  // Live: Groq answered 413 "Limit 8000, Requested 9855" and the whole resume
  // was lost, because 413 fell through to a non-retryable request_error.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"message":"Request too large for model X on tokens per minute (TPM): Limit 8000, Requested 9855"}}', { status: 413 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };

  const response = await chatWithRotation({
    chain: [{ providerId: 'groq', apiKey: 'a' }, { providerId: 'gemini', apiKey: 'b' }],
    messages: [], fetchImpl, nowFn: () => 0,
  });
  assert.equal(response.content, 'ok');
  assert.equal(calls, 2, 'it should have rotated rather than failed');
});

test('a 402 payment-required rotates, and is treated as exhausted quota', async () => {
  // Live: OpenRouter answered 402 "Payment required to access this resource"
  // and the run died mid cover letter.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"message":"Payment required to access this resource.","code":"payment_required"}', { status: 402 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };

  const response = await chatWithRotation({
    chain: [{ providerId: 'openrouter', apiKey: 'a' }, { providerId: 'gemini', apiKey: 'b' }],
    messages: [], fetchImpl, nowFn: () => 0,
  });
  assert.equal(response.content, 'ok');
  assert.equal(calls, 2);
});

test('a retired model rotates to the next in the pool', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return calls === 1
      ? new Response('{"error":{"message":"The model `old-model` does not exist"}}', { status: 404 })
      : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };

  const response = await chatWithRotation({
    chain: [{ providerId: 'gemini', apiKey: 'a' }],
    messages: [], fetchImpl, nowFn: () => 0,
  });
  assert.equal(response.content, 'ok');
  assert.equal(calls, 2, 'the sibling model should have been tried');
});

test('a genuinely malformed request still fails fast, without walking the chain', async () => {
  // The other half of the principle: rotating on a bad request just reproduces
  // it on every provider and wastes the quota of all of them.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"error":{"message":"Invalid value for messages[0].role"}}', { status: 400 });
  };

  await assert.rejects(chatWithRotation({
    chain: [{ providerId: 'gemini', apiKey: 'a' }, { providerId: 'groq', apiKey: 'b' }],
    messages: [], fetchImpl, nowFn: () => 0,
  }));
  assert.equal(calls, 1, 'a bad request must not be retried across providers');
});

// --- per-task model policy --------------------------------------------------
//
// Mirrored from the battle-tested chains in ~/.hirepilot/.env. The point of
// per-task policy is that one shared ordering cannot express what that file
// knows: gemma-4-31b is EXCLUDED for resume JSON and PREFERRED for cover
// letters. A single chain either denies the letter its best model or hands the
// resume pass a model already found unfit for structured output.

const ALL_FOUR = [
  { providerId: 'gemini', apiKey: 'a' },
  { providerId: 'groq', apiKey: 'b' },
  { providerId: 'cerebras', apiKey: 'c' },
  { providerId: 'openrouter', apiKey: 'd' },
];
const orderFor = (task) => buildChainEntries(ALL_FOUR, { task }).map((e) => e.model);

test('the resume chain LEADS with LLM_RESUME_JSON_PREFERRED_MODELS, in order', () => {
  // Exactly the .env's preferred order at the head; everything after it is
  // fallback depth from the same file, unranked and therefore tried last.
  assert.deepEqual(orderFor('resume').slice(0, 6), [
    'gemini-3.1-flash-lite',
    'qwen/qwen3.6-27b',
    'openai/gpt-oss-120b',
    'gpt-oss-120b',
    'inclusionai/ling-3.0-flash:free',
    'gemini-2.5-flash',
  ]);
});

test('the resume chain EXCLUDES gemma-4-31b, which the .env rules out for JSON', () => {
  assert.ok(!orderFor('resume').includes('gemma-4-31b'));
  assert.ok(!orderFor('skills').includes('gemma-4-31b'), 'skills is the other JSON pass');
});

test('the cover letter chain LEADS with gemma-4-31b, the model resume excludes', () => {
  // The whole reason per-task policy exists.
  const order = orderFor('coverLetter');
  assert.equal(order[0], 'gemma-4-31b');
  assert.deepEqual(order.slice(0, 3), ['gemma-4-31b', 'qwen/qwen3.6-27b', 'gemini-3.1-flash-lite']);
});

test('the judge chain leads with qwen3.6, per LLM_JUDGE_PREFERRED_MODELS', () => {
  assert.deepEqual(orderFor('judge').slice(0, 3), [
    'qwen/qwen3.6-27b', 'gemma-4-31b', 'gemini-3.1-flash-lite',
  ]);
});

test('skills shares the resume policy, being the other strict-JSON pass', () => {
  assert.deepEqual(orderFor('skills'), orderFor('resume'));
});

test('an unranked model is still usable, just last -- only exclusion is a veto', () => {
  // Being absent from a preferred list is not a ban. The letter chain ranks
  // three models and still reaches the rest afterwards.
  const order = orderFor('coverLetter');
  assert.ok(order.length > 3, 'unranked models should remain in the chain');
  assert.ok(order.includes('openai/gpt-oss-120b'));
});

test('no task means every model stays eligible, in interleaved order', () => {
  const order = orderFor(undefined);
  assert.ok(order.includes('gemma-4-31b'), 'a caller with no opinion gets no filtering');
});

test('a pinned model is exempt from task policy, even an excluded one', () => {
  // The user chose it explicitly. Substituting something this table prefers
  // would be overriding a deliberate decision.
  const entries = buildChainEntries(
    [{ providerId: 'cerebras', apiKey: 'c', model: 'gemma-4-31b' }],
    { task: 'resume' },
  );
  assert.deepEqual(entries.map((e) => e.model), ['gemma-4-31b']);
});

test('chatWithRotation honours the task when picking which model to call first', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const tried = [];
  const fetchImpl = async (url, init) => {
    tried.push(JSON.parse(init.body).model);
    return ok();
  };

  await chatWithRotation({ chain: ALL_FOUR, messages: [], fetchImpl, task: 'coverLetter' });
  assert.deepEqual(tried, ['gemma-4-31b'], 'the letter should start on its preferred model');

  tried.length = 0;
  await chatWithRotation({ chain: ALL_FOUR, messages: [], fetchImpl, task: 'resume' });
  assert.deepEqual(tried, ['gemini-3.1-flash-lite'], 'the resume should start on its own');
});
