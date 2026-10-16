// server/http/auth.mjs — the API's one credential: a Bearer token, stored as a hash.
//
// The server never holds the token itself, only TAILORUNE_API_TOKEN_SHA256.
// The plain token exists in two places: your gitignored .env.local and Muse's
// credential store. Reading the server's environment, its logs or its storage
// does not give anyone a working token.
//
// SHA-256 rather than a slow password hash, because the token is 32 random
// bytes, not something a person chose: there is nothing to brute-force.
// Digests are compared in constant time.

import { createHash, timingSafeEqual } from 'node:crypto';

export const sha256Hex = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

/**
 * @returns {'ok'|'unconfigured'|'denied'}
 */
export function checkBearer(request, env) {
  const expectedHex = String(env.TAILORUNE_API_TOKEN_SHA256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return 'unconfigured';

  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return 'denied';

  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return timingSafeEqual(a, b) ? 'ok' : 'denied';
}
