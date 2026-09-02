// reasoningEffort.test.mjs — reasoning parameters are GATED, not global.
//
// This file was rewritten during the v4 parity port, because it previously
// asserted the opposite of what v4 does, and the difference is instructive.
//
// The old behaviour: send `reasoning_effort: 'none'` to every provider, with a
// 400-retry as a safety net. It was added for a real measurement -- resume
// calls taking 13-25 SECONDS and truncating mid-JSON, while the skills and
// cover-letter calls on the same key took about one second. On a reasoning
// model `max_tokens` caps thinking AND output together, so the budget went on
// reasoning the pass does not need.
//
// v4's behaviour (llm.py:814-833) is far narrower:
//
//   reasoning_format: 'hidden'  Groq only, and only qwen3 / gpt-oss models
//   reasoning_effort: 'none'    Groq only, and only qwen3
//
// Gemini gets neither. Which raises the obvious question -- how did v4 avoid
// the 13-25s problem without the parameter? It never had it: v4's resume chain
// leads with `gemini-3.1-flash-lite`, which does not think. The model burning
// 25 seconds was `gemini-2.5-flash`, which led Tailorune's chain only because
// the chain was synthesised from a pool rather than curated.
//
// So the parity fix to the CHAIN removed the reason for the workaround. The
// workaround goes with it, rather than being carried forever as a guess about
// a provider v4 deliberately does not send this to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, reasoningParamsFor, resetReasoningEffortSupport } from '../../extension/engine/llm.js';
import { RESUME_MAX_TOKENS, RESUME_REASONING_EFFORT } from '../../extension/engine/tailor.js';
import { getProvider } from '../../extension/engine/providers.js';

const GROQ = getProvider('groq');
const GEMINI = getProvider('gemini');
const CEREBRAS = getProvider('cerebras');

const OK = { choices: [{ message: { content: '{"summary":"x"}' }, finish_reason: 'stop' }] };

function recordingFetch(handler) {
  const seen = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    return handler(body, seen.length);
  };
  return { impl, seen };
}

const alwaysOk = () => new Response(JSON.stringify(OK), { status: 200 });

// --- the gate --------------------------------------------------------------

test('Groq qwen3 gets both parameters', () => {
  resetReasoningEffortSupport();
  assert.deepEqual(
    reasoningParamsFor(GROQ.baseUrl, 'qwen/qwen3.6-27b', 'none'),
    { reasoning_format: 'hidden', reasoning_effort: 'none' },
  );
});

test('Groq gpt-oss gets the format but NOT the effort', () => {
  // llm.py:825 gates reasoning_effort on "qwen3" specifically -- it is Qwen's
  // non-thinking mode, not a general switch.
  resetReasoningEffortSupport();
  assert.deepEqual(
    reasoningParamsFor(GROQ.baseUrl, 'openai/gpt-oss-120b', 'none'),
    { reasoning_format: 'hidden' },
  );
});

test('no other provider gets either parameter, however hard the caller asks', () => {
  resetReasoningEffortSupport();
  for (const [label, provider] of [['gemini', GEMINI], ['cerebras', CEREBRAS]]) {
    assert.deepEqual(
      reasoningParamsFor(provider.baseUrl, 'gemini-3.1-flash-lite', 'none'), {},
      `${label} should receive no reasoning parameters`,
    );
  }
});

test('a non-reasoning Groq model gets nothing either', () => {
  resetReasoningEffortSupport();
  assert.deepEqual(reasoningParamsFor(GROQ.baseUrl, 'llama-3-70b', 'none'), {});
});

// --- what actually goes over the wire -------------------------------------

test('the gate is applied to the real request body', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(alwaysOk);

  await chat({
    provider: GROQ, apiKey: 'k', model: 'qwen/qwen3.6-27b', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  });
  assert.equal(seen[0].reasoning_effort, 'none');
  assert.equal(seen[0].reasoning_format, 'hidden');

  await chat({
    provider: GEMINI, apiKey: 'k', model: 'gemini-3.1-flash-lite', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  });
  assert.ok(!('reasoning_effort' in seen[1]), 'Gemini must not be sent reasoning_effort');
  assert.ok(!('reasoning_format' in seen[1]));
});

test('nothing is sent when the caller does not ask', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(alwaysOk);
  await chat({ provider: GEMINI, apiKey: 'k', model: 'm', messages: [], fetchImpl: impl });
  assert.ok(!('reasoning_effort' in seen[0]));
  assert.ok(!('reasoning_format' in seen[0]));
});

// --- the safety net beneath the gate --------------------------------------

test('a gated provider that still rejects the parameter is retried without it', async () => {
  // The gate means we rarely get here, but Groq changing its mind about a
  // model must degrade the request, not fail the call -- rotation would
  // otherwise treat it as request_incompatible and burn a chain slot.
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch((body) => (
    body.reasoning_effort
      ? new Response('Unknown parameter: reasoning_effort', { status: 400 })
      : new Response(JSON.stringify(OK), { status: 200 })
  ));

  const response = await chat({
    provider: GROQ, apiKey: 'k', model: 'qwen/qwen3-legacy', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  });

  assert.equal(response.content, '{"summary":"x"}', 'the call should still succeed');
  assert.equal(seen.length, 2, 'exactly one retry');
  assert.equal(seen[0].reasoning_effort, 'none');
  assert.ok(!('reasoning_effort' in seen[1]), 'the retry must drop the parameter');
});

test('the rejection is remembered, costing one extra request per session not per call', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch((body) => (
    body.reasoning_effort
      ? new Response('unsupported parameter reasoning_effort', { status: 400 })
      : new Response(JSON.stringify(OK), { status: 200 })
  ));
  const opts = {
    provider: GROQ, apiKey: 'k', model: 'qwen/qwen3-legacy', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  };

  await chat(opts);
  await chat(opts);

  assert.equal(seen.length, 3, 'first call probes and retries; the second does not probe again');
  assert.ok(!('reasoning_effort' in seen[2]));
});

test('an unrelated 400 still fails, rather than being swallowed as a parameter problem', async () => {
  // A bad API key must not be misread as unsupported reasoning and silently
  // retried into the same failure.
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(() => new Response('API key not valid', { status: 400 }));
  await assert.rejects(
    chat({
      provider: GROQ, apiKey: 'bad', model: 'qwen/qwen3.6-27b', messages: [],
      reasoningEffort: 'none', fetchImpl: impl,
    }),
    (err) => err.kind === 'http_error',
  );
  assert.equal(seen.length, 1, 'no pointless retry on an unrelated failure');
});

// --- the token ceiling ----------------------------------------------------

test('the resume ceiling is sized from measured usage, generous but not wasteful', () => {
  // Measured live: 1680 prompt tokens, 431 completion tokens. Bigger is not
  // free -- max_tokens counts toward a provider's per-minute budget, and an
  // 8192 ceiling made the request unservable on Groq (HTTP 413, "Limit 8000,
  // Requested 9855") for an answer that was going to be 431 tokens. That same
  // budget is now also enforced client-side; see rateWindow.js.
  assert.equal(RESUME_REASONING_EFFORT, 'none');
  assert.ok(RESUME_MAX_TOKENS >= 2048, `too tight for a longer resume: ${RESUME_MAX_TOKENS}`);
  assert.ok(RESUME_MAX_TOKENS <= 4096, `oversized ceilings trip per-minute limits: ${RESUME_MAX_TOKENS}`);
});
