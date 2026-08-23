// mockLlmServer.mjs — a tiny local OpenAI-compatible HTTP server for e2e
// tests. context.route() does not intercept fetches made from an offscreen
// document (confirmed empirically while building this test — not documented
// anywhere), so the extension is pointed at this real local server instead
// via the baseUrlOverride debug affordance (see offscreen.entry.js).
//
// CORS headers are required: an extension page fetching an origin NOT in its
// manifest's host_permissions is subject to ordinary CORS, same as any
// webpage. localhost is not declared there on purpose (it is a debug-only
// path), so this server has to answer the preflight itself.

import http from 'node:http';

/**
 * @param {() => object} responseBodyFn returns the OpenAI-shaped JSON body to answer with
 * @returns {Promise<{ url: string, close: () => Promise<void>, requestCount: () => number }>}
 */
export function startMockLlmServer(responseBodyFn) {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requestCount += 1;
      const body = JSON.stringify(responseBodyFn());
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        requestCount: () => requestCount,
      });
    });
  });
}
