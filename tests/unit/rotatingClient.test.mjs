import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatWithRotation, classifyFailure, resetCooldowns, cooldownState, COOLDOWN_MS,
  buildChainEntries,
} from '../../extension/engine/rotatingClient.js';
import { LlmError } from '../../extension/engine/llm.js';

const CHAIN = [
  { providerId: 'gemini', apiKey: 'k1' },
  { providerId: 'groq', apiKey: 'k2' },
  { providerId: 'cerebras', apiKey: 'k3' },
];

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
      // 3 providers expanded across their model pools: 2 + 2 + 2.
      assert.equal(err.detail.attempts.length, 6);
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
  assert.deepEqual(bodies, ['gemini-2.5-flash', 'openai/gpt-oss-120b'],
    'should try the best gemini model, then fail over to the next provider');

  bodies.length = 0;
  await chatWithRotation({ chain: CHAIN, messages: [], fetchImpl });
  assert.ok(!bodies.includes('gemini-2.5-flash'),
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
  assert.ok(cooldownState(clock)['gemini::gemini-2.5-flash'] > 0, 'the throttled model should be cooling down');

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
  const remainingSecs = cooldownState(clock)['gemini::gemini-2.5-flash'];
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
  assert.equal(Object.keys(cooldownState(clock)).length, 6);

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
  const entries = buildChainEntries([{ providerId: 'gemini', apiKey: 'k' }]);
  assert.deepEqual(entries.map((e) => e.model), ['gemini-2.5-flash', 'gemini-3.1-flash-lite']);
  assert.ok(entries.every((e) => e.apiKey === 'k'));
});

test('buildChainEntries interleaves round-robin by model index, not provider by provider', () => {
  const entries = buildChainEntries([
    { providerId: 'gemini', apiKey: 'a' },
    { providerId: 'groq', apiKey: 'b' },
  ]);
  // Every provider's BEST model first, then every provider's second model --
  // so a user with two keys gets two strong attempts before any fallback.
  assert.deepEqual(entries.map((e) => `${e.providerId}/${e.model}`), [
    'gemini/gemini-2.5-flash',
    'groq/openai/gpt-oss-120b',
    'gemini/gemini-3.1-flash-lite',
    'groq/openai/gpt-oss-20b',
  ]);
});

test('buildChainEntries respects an explicitly pinned model instead of widening to the pool', () => {
  const entries = buildChainEntries([{ providerId: 'gemini', apiKey: 'k', model: 'my-custom-model' }]);
  assert.deepEqual(entries.map((e) => e.model), ['my-custom-model']);
});

test('buildChainEntries handles providers with unequal pool sizes without leaving gaps', () => {
  const entries = buildChainEntries([
    { providerId: 'gemini', apiKey: 'a' },      // 2 models
    { providerId: 'openrouter', apiKey: 'b' },  // 1 model
  ]);
  assert.deepEqual(entries.map((e) => `${e.providerId}/${e.model}`), [
    'gemini/gemini-2.5-flash',
    'openrouter/openai/gpt-oss-20b:free',
    'gemini/gemini-3.1-flash-lite',
  ]);
});

test('a throttled model falls over to the next model on the same provider when no other key exists', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const tried = [];
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    tried.push(model);
    if (model === 'gemini-2.5-flash') return new Response('Too many requests', { status: 429 });
    return ok('from the lighter model');
  };
  const result = await chatWithRotation({ chain: [{ providerId: 'gemini', apiKey: 'k' }], messages: [], fetchImpl });
  assert.deepEqual(tried, ['gemini-2.5-flash', 'gemini-3.1-flash-lite']);
  assert.equal(result.model, 'gemini-3.1-flash-lite');
  assert.equal(result.content, 'from the lighter model');
});

test('cooling down one model leaves its sibling on the same provider usable', async (t) => {
  resetCooldowns();
  t.after(resetCooldowns);
  const clock = 3_000_000;
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === 'gemini-2.5-flash') return new Response('Too many requests', { status: 429 });
    return ok();
  };
  await chatWithRotation({ chain: [{ providerId: 'gemini', apiKey: 'k' }], messages: [], fetchImpl, nowFn: () => clock });
  const state = cooldownState(clock);
  assert.ok(state['gemini::gemini-2.5-flash'] > 0, 'throttled model should be cooling');
  assert.equal(state['gemini::gemini-3.1-flash-lite'], undefined, 'its sibling must NOT be cooling');
});
