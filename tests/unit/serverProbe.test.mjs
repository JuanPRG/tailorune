// serverProbe.test.mjs — the M0 probe that tells us how Muse connects.
//
// The probe answers four questions from docs/AGENT_API_PLAN.md (Bearer or
// OAuth, REST or MCP, how long a tool call may take, whether a file link can
// be downloaded). Each test pins one surface the agent will touch, plus the
// rule this project already learned the hard way: the token never comes back
// out in a response.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleProbe } from '../../server/http/probe.js';

const TOKEN = 'test-token-0123456789abcdef';
const BASE = 'https://probe.example';

const call = (path, { token = TOKEN, method = 'GET', body, env = { TAILORUNE_API_TOKEN: TOKEN }, sleep } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleProbe(request, { env, sleep: sleep || (async () => {}), log: () => {} });
};

const rpc = (method, params, id = 1) => call('/mcp', {
  method: 'POST', body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
});

test('the OpenAPI document is public, so Muse can read it before it has a token', async () => {
  const res = await call('/openapi.json', { token: null });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.match(doc.openapi, /^3\./);
  assert.equal(doc.servers[0].url, BASE);
  assert.ok(doc.components.securitySchemes.bearer);
  assert.ok(doc.paths['/v1/ping'].get);
});

test('ping answers with a valid Bearer token', async () => {
  const res = await call('/v1/ping');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.data.pong, true);
});

test('a missing or wrong token is refused with a Bearer challenge', async () => {
  for (const token of [null, 'wrong-token-0123456789abcdef', `${TOKEN}x`]) {
    const res = await call('/v1/ping', { token });
    assert.equal(res.status, 401, `token ${token === null ? 'missing' : 'wrong'}`);
    assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
  }
});

test('with no token configured the probe fails closed, never open', async () => {
  const res = await call('/v1/ping', { env: {} });
  assert.equal(res.status, 503);
});

test('the slow probe waits the requested seconds, capped, then reports them', async () => {
  const waited = [];
  const res = await call('/v1/slow?seconds=45', { sleep: async (ms) => { waited.push(ms); } });
  assert.equal(res.status, 200);
  assert.deepEqual(waited, [45_000]);
  assert.equal((await res.json()).data.slept_seconds, 45);

  const capped = [];
  await call('/v1/slow?seconds=9999', { sleep: async (ms) => { capped.push(ms); } });
  assert.deepEqual(capped, [280_000]);
});

test('the sample file downloads as an attachment', async () => {
  const res = await call('/v1/files/sample.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="tailorune-probe\.txt"/);
  assert.match(await res.text(), /Tailorune/);
});

test('a Vercel rewrite passes the real path as ?path=, and that wins', async () => {
  const res = await call('/api/index?path=v1/ping');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.pong, true);
});

test('unknown paths are 404, not a crash', async () => {
  const res = await call('/v1/nope');
  assert.equal(res.status, 404);
});

test('MCP: initialize, list the tools, call one', async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' },
  });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.id, 1);
  assert.equal(initBody.result.protocolVersion, '2025-06-18');
  assert.ok(initBody.result.capabilities.tools);

  const list = await (await rpc('tools/list', undefined, 2)).json();
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['ping', 'slow_probe']);

  const ping = await (await rpc('tools/call', { name: 'ping', arguments: {} }, 3)).json();
  assert.equal(ping.result.isError, false);
  assert.match(ping.result.content[0].text, /pong/);
});

test('MCP: notifications get 202 with no body, unknown methods a JSON-RPC error', async () => {
  const note = await call('/mcp', {
    method: 'POST', body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(note.status, 202);

  const bad = await (await rpc('does/not/exist', undefined, 9)).json();
  assert.equal(bad.error.code, -32601);
});

test('MCP needs the token too', async () => {
  const res = await call('/mcp', {
    token: null, method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(res.status, 401);
});

test('no response and no log line ever contains the token', async () => {
  const lines = [];
  const log = (entry) => lines.push(JSON.stringify(entry));
  const paths = ['/v1/ping', '/openapi.json', '/v1/files/sample.txt', '/v1/nope'];
  for (const path of paths) {
    const request = new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const res = await handleProbe(request, { env: { TAILORUNE_API_TOKEN: TOKEN }, sleep: async () => {}, log });
    assert.doesNotMatch(await res.text(), new RegExp(TOKEN), path);
  }
  assert.ok(lines.length >= paths.length, 'every request is logged');
  for (const line of lines) assert.doesNotMatch(line, new RegExp(TOKEN));
});
