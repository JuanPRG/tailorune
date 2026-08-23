import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat, LlmError } from '../../extension/engine/llm.js';
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
