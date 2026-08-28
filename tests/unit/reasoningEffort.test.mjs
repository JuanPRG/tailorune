// reasoningEffort.test.mjs — capping the thinking budget, and surviving
// providers that have never heard of it.
//
// Measured on real runs: the resume call took 13-25 SECONDS while the skills
// and cover-letter calls — same provider, same key, 1024 tokens — took about
// one. It also still truncated at 4096 tokens. Both symptoms point the same
// way: on a reasoning model `max_tokens` caps thinking AND output together, so
// the budget went on reasoning the pass does not need. It rewrites text it is
// handed; it does not have to think its way to an answer.
//
// The risk this file guards is the optimisation itself. A provider that does
// not understand `reasoning_effort` rejects the WHOLE request with a 400, and
// rotation treats 400 as fatal — so a speed-up would take the run down with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, resetReasoningEffortSupport } from '../../extension/engine/llm.js';
import { RESUME_MAX_TOKENS, RESUME_REASONING_EFFORT } from '../../extension/engine/tailor.js';
import { getProvider } from '../../extension/engine/providers.js';

const provider = getProvider('gemini');
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

test('reasoning_effort is sent when asked for', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(() => new Response(JSON.stringify(OK), { status: 200 }));
  await chat({
    provider, apiKey: 'k', model: 'gemini-2.5-flash', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  });
  assert.equal(seen[0].reasoning_effort, 'none');
});

test('it is omitted entirely when not requested', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(() => new Response(JSON.stringify(OK), { status: 200 }));
  await chat({ provider, apiKey: 'k', model: 'm', messages: [], fetchImpl: impl });
  assert.ok(!('reasoning_effort' in seen[0]));
});

test('a provider that rejects the parameter is retried without it, not failed', async () => {
  // The whole point. Rotation treats 400 as fatal, so without this the
  // optimisation would break every provider that does not support it.
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch((body) => (
    body.reasoning_effort
      ? new Response('Unknown parameter: reasoning_effort', { status: 400 })
      : new Response(JSON.stringify(OK), { status: 200 })
  ));

  const response = await chat({
    provider, apiKey: 'k', model: 'legacy-model', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  });

  assert.equal(response.content, '{"summary":"x"}', 'the call should still succeed');
  assert.equal(seen.length, 2, 'exactly one retry');
  assert.equal(seen[0].reasoning_effort, 'none');
  assert.ok(!('reasoning_effort' in seen[1]), 'the retry must drop the parameter');
});

test('the rejection is remembered, so it costs one extra request per session and not one per call', async () => {
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch((body) => (
    body.reasoning_effort
      ? new Response('unsupported parameter reasoning_effort', { status: 400 })
      : new Response(JSON.stringify(OK), { status: 200 })
  ));
  const opts = {
    provider, apiKey: 'k', model: 'legacy-model', messages: [],
    reasoningEffort: 'none', fetchImpl: impl,
  };

  await chat(opts);
  await chat(opts);

  assert.equal(seen.length, 3, 'first call probes and retries; the second does not probe again');
  assert.ok(!('reasoning_effort' in seen[2]));
});

test('an unrelated 400 still fails, rather than being swallowed as a parameter problem', async () => {
  // A bad API key or malformed request must not be misread as unsupported
  // reasoning and silently retried into the same failure.
  resetReasoningEffortSupport();
  const { impl, seen } = recordingFetch(() => new Response('API key not valid', { status: 400 }));
  await assert.rejects(
    chat({
      provider, apiKey: 'bad', model: 'm', messages: [],
      reasoningEffort: 'none', fetchImpl: impl,
    }),
    (err) => err.kind === 'http_error',
  );
  assert.equal(seen.length, 1, 'no pointless retry on an unrelated failure');
});

test('the resume ceiling is sized from measured usage, generous but not wasteful', () => {
  // Measured live: 1680 prompt tokens, 431 completion tokens. Bigger is not
  // free -- max_tokens counts toward a provider's per-minute budget, and an
  // 8192 ceiling made the request unservable on Groq (HTTP 413, "Limit 8000,
  // Requested 9855") for an answer that was going to be 431 tokens.
  assert.equal(RESUME_REASONING_EFFORT, 'none');
  assert.ok(RESUME_MAX_TOKENS >= 2048, `too tight for a longer resume: ${RESUME_MAX_TOKENS}`);
  assert.ok(RESUME_MAX_TOKENS <= 4096, `oversized ceilings trip per-minute limits: ${RESUME_MAX_TOKENS}`);
});
