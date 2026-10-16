// dev.mjs — run the agent API locally: `node server/dev.mjs`.
//
// Adapts node:http to the same (Request) -> Response handler Vercel will run,
// so what is tested here is what deploys. Local only: Muse cannot reach
// localhost (it runs in Meta's cloud), so this is for curl and the tests.
//
// Needs TAILORUNE_API_TOKEN_SHA256 (from `node server/hash-token.mjs`) and at
// least one provider key, both from the environment or the env files that
// server/keys.mjs reads. Data goes to server/.data/ (gitignored).

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.mjs';
import { loadEnvFiles } from './keys.mjs';
import { sha256Hex } from './http/auth.mjs';

const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');

loadEnvFiles();
// Locally the plain token in .env.local is enough: hash it here, so the
// handler still only ever compares hashes.
if (!process.env.TAILORUNE_API_TOKEN_SHA256 && process.env.TAILORUNE_API_TOKEN) {
  process.env.TAILORUNE_API_TOKEN_SHA256 = sha256Hex(process.env.TAILORUNE_API_TOKEN);
}
if (!process.env.TAILORUNE_API_TOKEN_SHA256) {
  console.error('Set TAILORUNE_API_TOKEN (in .env.local) or TAILORUNE_API_TOKEN_SHA256 first. The API fails closed without it.');
  process.exit(1);
}

const app = createApp({ dataDir: DATA_DIR });

createServer(async (req, res) => {
  try {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
    });
    const response = await app.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('dev server error', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, data: null, error: 'Internal error.' }));
  }
}).listen(PORT, () => console.info(`Tailorune API listening on http://localhost:${PORT} (data in ${DATA_DIR})`));
