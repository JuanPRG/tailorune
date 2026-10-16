// hash-token.mjs — print the SHA-256 of your API token, for TAILORUNE_API_TOKEN_SHA256.
//
//   node server/hash-token.mjs
//
// Reads TAILORUNE_API_TOKEN from the environment or .env.local (never from an
// argument) and prints only its hash. The hash is safe to paste into Vercel:
// the token is 32 random bytes, so the hash cannot be turned back into it.

import { loadEnvFiles } from './keys.mjs';
import { sha256Hex } from './http/auth.mjs';

loadEnvFiles();
const token = (process.env.TAILORUNE_API_TOKEN || '').trim();
if (!token) {
  console.error('TAILORUNE_API_TOKEN is not set in the environment or .env.local.');
  process.exit(2);
}
process.stdout.write(`${sha256Hex(token)}\n`);
