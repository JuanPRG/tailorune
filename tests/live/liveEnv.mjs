// tests/live/liveEnv.mjs — provider keys for the live harnesses.
//
// Extracted so the "never print a key" rule lives in exactly one place. This
// project has already leaked two real credentials once, through an identifier
// nobody thought of as containing one, so the number of places that touch a
// key is worth keeping at one.
//
// THE KEY IS NEVER READ FROM SOURCE, AN ARGUMENT, OR THIS FILE. It comes from
// the environment only:
//
//   PowerShell:  $env:GEMINI_API_KEY = "..."   ; npm run test:live
//   bash:        GEMINI_API_KEY=... npm run test:live
//
// Read, in order: a gitignored `.env.local` in this repo, then whatever
// TAILORUNE_ENV_FILE points at. Nothing is copied between them -- the secret
// stays in the one place already managing it, so there is no second copy to
// leak or to go stale.
//
// That second location is an ENV VAR rather than a hard-coded directory, so
// this repo names no other product's config path. To keep using an existing
// key file, set it once in your shell profile:
//
//   PowerShell:  $env:TAILORUNE_ENV_FILE = "$HOME/.your-tool/.env"
//   bash:        export TAILORUNE_ENV_FILE=~/.your-tool/.env
//
// The loading itself lives in server/keys.mjs, shared with the agent API's
// CLI; this module keeps what only the harnesses need.

import path from 'node:path';
import { loadEnvFiles, PROVIDER_ENV, ROOT } from '../../server/keys.mjs';

export { loadEnvFiles, PROVIDER_ENV, ROOT };

/** @returns {Array<{providerId: string, apiKey: string}>} configured providers only. */
export function buildChain() {
  return Object.entries(PROVIDER_ENV)
    .filter(([, envName]) => (process.env[envName] || '').trim())
    .map(([providerId, envName]) => ({ providerId, apiKey: process.env[envName].trim() }));
}

export const NO_KEYS_MESSAGE = 'No provider key found in the environment.\n\n'
  + '  PowerShell:  $env:GEMINI_API_KEY = "your-key"; npm run test:live\n'
  + '  bash:        GEMINI_API_KEY=your-key npm run test:live\n\n'
  + `Or put GEMINI_API_KEY=your-key in ${path.join(ROOT, '.env.local')} (gitignored).\n`
  + 'The key is read from the environment only — never from a command argument,\n'
  + 'which would put it in your shell history.';
