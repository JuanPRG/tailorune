// dev.mjs — run the handler locally: `TAILORUNE_API_TOKEN=... node server/dev.mjs`.
//
// Adapts node:http to the same (Request) -> Response handler Vercel runs, so
// what is tested here is what deploys. Local only: Muse cannot reach
// localhost (it runs in Meta's cloud), so this is for curl and MCP Inspector.

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { handleProbe } from './http/probe.js';

const PORT = Number(process.env.PORT) || 8787;

if (!process.env.TAILORUNE_API_TOKEN) {
  console.error('Set TAILORUNE_API_TOKEN first. The server fails closed without it.');
  process.exit(1);
}

createServer(async (req, res) => {
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
    });
    const response = await handleProbe(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('dev server error', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, data: null, error: 'Internal error.' }));
  }
}).listen(PORT, () => console.info(`probe listening on http://localhost:${PORT}`));
