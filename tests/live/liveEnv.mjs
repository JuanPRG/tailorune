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
// Read, in order: a gitignored `.env.local` in this repo, then
// ~/.hirepilot/.env (hirepilot v4's own config). Nothing is copied between
// them -- the secret stays in the one place already managing it, so there is
// no second copy to leak or to go stale.

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

const ENV_FILES = [
  path.join(ROOT, '.env.local'),
  path.join(os.homedir(), '.hirepilot', '.env'),
];

// v4 names two of its provider keys differently. Mapped rather than renamed,
// so v4's own config is never edited to suit this repo.
const KEY_ALIASES = {
  LLM_PROVIDER_CEREBRAS_API_KEY: 'CEREBRAS_API_KEY',
  LLM_PROVIDER_OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
};

export const PROVIDER_ENV = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Load KEY=value pairs into the environment, without printing any value. */
export function loadEnvFiles() {
  const loadedFrom = [];
  for (const file of ENV_FILES) {
    if (!existsSync(file)) continue;
    let used = false;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (!value) continue;
      for (const name of [m[1], KEY_ALIASES[m[1]]].filter(Boolean)) {
        if (!process.env[name]) { process.env[name] = value; used = true; }
      }
    }
    if (used) loadedFrom.push(file);
  }
  return loadedFrom;
}

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
