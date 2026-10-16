// server/keys.mjs — provider keys, for the CLI, the API and the live harnesses.
//
// The one place that reads a provider key. It moved here from
// tests/live/liveEnv.mjs (which now re-exports it) when the agent API's CLI
// needed the same loading: this project has already leaked two real
// credentials once, through an identifier nobody thought of as containing
// one, so the number of places that touch a key stays at one.
//
// THE KEY IS NEVER READ FROM SOURCE OR A COMMAND ARGUMENT -- an argument
// lands in shell history. It comes from the environment only:
//
//   PowerShell:  $env:GEMINI_API_KEY = "..."
//   bash:        GEMINI_API_KEY=...
//
// Or from env files, read in order: a gitignored `.env.local` in this repo,
// then whatever TAILORUNE_ENV_FILE points at. Nothing is copied between them,
// and a variable already set in the environment always wins over a file.
// Values are never printed.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// v4 names two of its provider keys differently. Mapped rather than renamed,
// so v4's own config is never edited to suit this repo.
const KEY_ALIASES = {
  LLM_PROVIDER_OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
};

export const PROVIDER_ENV = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** The env files to read, resolved when called, not when imported. */
export function defaultEnvFiles(env = process.env) {
  return [
    path.join(ROOT, '.env.local'),
    ...(env.TAILORUNE_ENV_FILE ? [env.TAILORUNE_ENV_FILE] : []),
  ];
}

/** Load KEY=value pairs into the environment, without printing any value. */
export function loadEnvFiles(files = defaultEnvFiles()) {
  const loadedFrom = [];
  for (const file of files) {
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

/** @returns {Record<string, string>} providerId -> key, for configured providers only. */
export function providerKeysFromEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(PROVIDER_ENV)
      .map(([providerId, envName]) => [providerId, (env[envName] || '').trim()])
      .filter(([, key]) => key),
  );
}
