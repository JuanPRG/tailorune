import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, chatWithRetry, LlmError } from '../../extension/engine/llm.js';
import { getProvider } from '../../extension/engine/providers.js';

const provider = getProvider('gemini');

function mockFetchOk(content, usage = {}) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
}

test('chat returns message content and usage on a normal 200 response', async () => {
  const result = await chat({
    provider,
    apiKey: 'x',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: mockFetchOk('hello', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
  });
  assert.equal(result.content, 'hello');
  assert.equal(result.usage.totalTokens, 7);
});

test('chat throws LlmError(http_error) with the status code on a non-2xx response', async () => {
  const fetchImpl = async () => new Response('rate limited', { status: 429 });
  await assert.rejects(
    chat({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }),
    (err) => err instanceof LlmError && err.kind === 'http_error' && err.detail.status === 429,
  );
});

test('chat throws LlmError(malformed_response) when the body is not JSON', async () => {
  const fetchImpl = async () => new Response('not json at all', { status: 200 });
  await assert.rejects(
    chat({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }),
    (err) => err instanceof LlmError && err.kind === 'malformed_response',
  );
});

test('chat throws LlmError(empty_response) when message content is blank', async () => {
  const fetchImpl = mockFetchOk('   ');
  await assert.rejects(
    chat({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }),
    (err) => err instanceof LlmError && err.kind === 'empty_response',
  );
});

test('chat throws LlmError(timeout) when the request exceeds timeoutMs', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(
    chat({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl, timeoutMs: 20 }),
    (err) => err instanceof LlmError && err.kind === 'timeout',
  );
});

// --- chatWithRetry ---

function fakeSleep() {
  const calls = [];
  const sleepImpl = async (ms) => { calls.push(ms); };
  return { sleepImpl, calls };
}

test('chatWithRetry succeeds on the first attempt with no delay at all', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount += 1; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); };
  const { sleepImpl, calls } = fakeSleep();
  const result = await chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl });
  assert.equal(result.content, 'ok');
  assert.equal(callCount, 1);
  assert.deepEqual(calls, []);
});

test('chatWithRetry retries a transient network_error and succeeds on the second attempt, with backoff', async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) throw new TypeError('network down');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }), { status: 200 });
  };
  const { sleepImpl, calls } = fakeSleep();
  const result = await chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl, baseDelayMs: 100 });
  assert.equal(result.content, 'recovered');
  assert.equal(callCount, 2);
  assert.deepEqual(calls, [100]); // baseDelayMs * 2^0 on the first retry
});

test('chatWithRetry retries on HTTP 429 and 503 (rate limit / transient server error)', async () => {
  const statuses = [429, 503, 200];
  let callCount = 0;
  const fetchImpl = async () => {
    const status = statuses[callCount];
    callCount += 1;
    if (status === 200) return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    return new Response('unavailable', { status });
  };
  const { sleepImpl } = fakeSleep();
  const result = await chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl, maxRetries: 2 });
  assert.equal(result.content, 'ok');
  assert.equal(callCount, 3);
});

test('chatWithRetry does NOT retry a 400 (bad request) -- retrying a client error is pointless', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount += 1; return new Response('bad request', { status: 400 }); };
  const { sleepImpl } = fakeSleep();
  await assert.rejects(
    chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl }),
    (err) => err instanceof LlmError && err.kind === 'http_error' && err.detail.status === 400,
  );
  assert.equal(callCount, 1, 'a 400 must fail fast, not retry');
});

test('chatWithRetry does NOT retry malformed_response or empty_response -- a retry would get the same answer', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount += 1; return new Response('not json', { status: 200 }); };
  const { sleepImpl } = fakeSleep();
  await assert.rejects(chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl }));
  assert.equal(callCount, 1);
});

test('chatWithRetry gives up after maxRetries and surfaces the last error', async () => {
  let callCount = 0;
  const fetchImpl = async () => { callCount += 1; return new Response('down', { status: 503 }); };
  const { sleepImpl, calls } = fakeSleep();
  await assert.rejects(
    chatWithRetry({ provider, apiKey: 'x', model: 'm', messages: [], fetchImpl }, { sleepImpl, maxRetries: 2, baseDelayMs: 10 }),
    (err) => err instanceof LlmError && err.detail.status === 503,
  );
  assert.equal(callCount, 3); // initial attempt + 2 retries
  assert.deepEqual(calls, [10, 20]); // exponential backoff: baseDelayMs * 2^attempt
});

test('chat sends the API key as a Bearer token and the model/messages in the body', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  await chat({ provider, apiKey: 'secret-key', model: 'test-model', messages: [{ role: 'user', content: 'hi' }], fetchImpl });
  assert.equal(captured.url, `${provider.baseUrl}/chat/completions`);
  assert.equal(captured.headers.Authorization, 'Bearer secret-key');
  assert.equal(captured.body.model, 'test-model');
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'hi' }]);
});
