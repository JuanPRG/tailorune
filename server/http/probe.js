// server/http/probe.js — M0 of docs/AGENT_API_PLAN.md: find out how Muse connects.
//
// Nothing here tailors anything. It exists to answer four questions with a
// real agent on the other end, before any real API is built on guesses:
//
//   1. Bearer or OAuth?  Every protected route takes a Bearer token and answers
//      401 + `WWW-Authenticate: Bearer` without one. An OAuth-only client
//      reveals itself in the logs by probing /.well-known/* after that 401.
//   2. REST or MCP?      The same two operations exist both ways: REST
//      described by /openapi.json, and a minimal MCP endpoint at /mcp.
//   3. How long may a call take?  /v1/slow?seconds=N (and the slow_probe tool)
//      sleeps N seconds. Raising N until the agent gives up finds its timeout.
//   4. Can it fetch a file from a link?  /v1/files/sample.txt is an attachment.
//
// A plain (Request) -> Response function, so the same code runs under Vercel,
// the local dev server and node:test with no adapter.
//
// THE TOKEN IS NEVER ECHOED. Not in a response, not in a log line -- this
// project has leaked real keys once already, through a value nobody thought
// of as output (see credentialLeak.test.mjs). Logs carry only whether a
// token was present and whether it matched.

import { timingSafeEqual } from 'node:crypto';

const MAX_SLEEP_SECONDS = 280; // under Vercel's 300s ceiling, so the probe answers instead of being killed
const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SAMPLE_FILE = 'Tailorune probe file. If your agent can read this, it can download run artifacts.\n';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
const ok = (data) => json(200, { ok: true, data, error: null });
const fail = (status, error, headers) => json(status, { ok: false, data: null, error }, headers);

/** Constant-time comparison, so response timing cannot be used to guess the token. */
function tokenMatches(presented, expected) {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns null when authorised, otherwise the Response to send. */
function checkAuth(request, env) {
  const expected = env.TAILORUNE_API_TOKEN;
  if (!expected) return fail(503, 'TAILORUNE_API_TOKEN is not configured on the server.');
  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (presented && tokenMatches(presented, expected)) return null;
  return fail(401, 'Missing or invalid Bearer token.', {
    'www-authenticate': 'Bearer realm="tailorune"',
  });
}

/** Vercel rewrites send every path to one function, carrying the original as ?path=. */
function routePath(url) {
  const rewritten = url.searchParams.get('path');
  const raw = rewritten !== null ? `/${rewritten}` : url.pathname;
  return raw.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

function clampSeconds(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_SLEEP_SECONDS);
}

function openApiDocument(origin) {
  const bearer = [{ bearer: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Tailorune probe',
      version: '0.0.1',
      description: 'Connectivity probe for an agent integration. No resume data is handled.',
    },
    servers: [{ url: origin }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/v1/ping': {
        get: {
          operationId: 'ping',
          summary: 'Check the connection and token.',
          security: bearer,
          responses: { 200: { description: 'Connected.' }, 401: { description: 'Bad token.' } },
        },
      },
      '/v1/slow': {
        get: {
          operationId: 'slowProbe',
          summary: `Wait the given seconds (max ${MAX_SLEEP_SECONDS}), then answer. Measures the caller's timeout.`,
          security: bearer,
          parameters: [{
            name: 'seconds', in: 'query', required: true,
            schema: { type: 'integer', minimum: 0, maximum: MAX_SLEEP_SECONDS },
          }],
          responses: { 200: { description: 'Waited.' } },
        },
      },
      '/v1/files/sample.txt': {
        get: {
          operationId: 'downloadSample',
          summary: 'Download a small text file. Tests whether file links can be fetched.',
          security: bearer,
          responses: { 200: { description: 'The file.', content: { 'text/plain': {} } } },
        },
      },
    },
  };
}

// --- MCP (streamable HTTP, stateless, JSON responses only) -----------------

const MCP_TOOLS = [
  {
    name: 'ping',
    description: 'Check the connection to Tailorune.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'slow_probe',
    description: `Wait the given seconds (max ${MAX_SLEEP_SECONDS}), then answer. Measures the caller's timeout.`,
    inputSchema: {
      type: 'object',
      properties: { seconds: { type: 'integer', minimum: 0, maximum: MAX_SLEEP_SECONDS } },
      required: ['seconds'],
      additionalProperties: false,
    },
  },
];

const rpcResult = (id, result) => json(200, { jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (text) => ({ content: [{ type: 'text', text }], isError: false });

async function handleMcp(request, { sleep }) {
  if (request.method !== 'POST') {
    return fail(405, 'This MCP endpoint is stateless: POST JSON-RPC only, no SSE stream.', { allow: 'POST' });
  }
  let message;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }
  const { id, method, params = {} } = message;

  // A notification carries no id and gets no JSON-RPC answer.
  if (id === undefined) return new Response(null, { status: 202 });

  if (method === 'initialize') {
    const requested = params.protocolVersion;
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'tailorune-probe', version: '0.0.1' },
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: MCP_TOOLS });
  if (method === 'tools/call') {
    if (params.name === 'ping') return rpcResult(id, toolText('pong — connected to Tailorune.'));
    if (params.name === 'slow_probe') {
      const seconds = clampSeconds((params.arguments || {}).seconds);
      await sleep(seconds * 1000);
      return rpcResult(id, toolText(`Waited ${seconds} seconds.`));
    }
    return rpcError(id, -32602, `Unknown tool: ${params.name}`);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// --- entry -------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const defaultLog = (entry) => { console.info(JSON.stringify(entry)); };

/**
 * @param {Request} request
 * @param {{ env?: Record<string,string|undefined>, sleep?: (ms:number)=>Promise<void>, log?: (entry:object)=>void }} [deps]
 * @returns {Promise<Response>}
 */
export async function handleProbe(request, deps = {}) {
  const env = deps.env || process.env;
  const sleep = deps.sleep || defaultSleep;
  const log = deps.log || defaultLog;

  const url = new URL(request.url);
  const path = routePath(url);
  const auth = request.headers.get('authorization') || '';
  const response = await route(request, { url, path, env, sleep });

  // What the agent sent, minus anything secret: this is how M0 learns
  // whether Muse speaks Bearer, OAuth, REST or MCP.
  log({
    at: new Date().toISOString(),
    method: request.method,
    path,
    status: response.status,
    userAgent: request.headers.get('user-agent') || null,
    authScheme: auth ? auth.split(' ')[0] : null,
    mcpProtocol: request.headers.get('mcp-protocol-version') || null,
  });
  return response;
}

async function route(request, { url, path, env, sleep }) {
  // Public on purpose: the agent reads this to build its client before it holds a token.
  if (path === '/openapi.json' && request.method === 'GET') return json(200, openApiDocument(url.origin));

  const denied = checkAuth(request, env);
  if (denied) return denied;

  if (path === '/mcp') return handleMcp(request, { sleep });
  if (request.method !== 'GET') return fail(405, 'Method not allowed.', { allow: 'GET' });
  if (path === '/v1/ping') return ok({ pong: true, at: new Date().toISOString() });
  if (path === '/v1/slow') {
    const seconds = clampSeconds(url.searchParams.get('seconds'));
    await sleep(seconds * 1000);
    return ok({ slept_seconds: seconds });
  }
  if (path === '/v1/files/sample.txt') {
    return new Response(SAMPLE_FILE, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="tailorune-probe.txt"',
      },
    });
  }
  return fail(404, `No route for ${path}.`);
}
