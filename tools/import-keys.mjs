// tools/import-keys.mjs — move the provider keys you already have in a .env
// into a live install's chrome.storage.local, without typing them three times.
//
// WHY THIS IS NOT A FILE THE EXTENSION READS. There is no path from a packaged
// extension to your disk, by design -- and a build step that baked keys into
// the source would put them in dist/tailorune-<v>.zip and from there into the
// Chrome Web Store, public. So the keys have to arrive the way a user's keys
// arrive: written into that browser profile's own storage.
//
// WHY THE CLIPBOARD, AND NOT STDOUT. The snippet contains real credentials.
// Printing it would put them in the terminal, in scrollback, in any log or
// transcript capturing this session, and in the context of any agent reading
// that output. This repo has already leaked two live keys once, through an
// identifier nobody thought of as containing one. So the only thing this
// script prints is an FNV fingerprint -- the same representation the rotation
// uses for cooldown bookkeeping, chosen there for exactly this reason.
//
// Keys are read from the same places the live tests read them (a gitignored
// .env.local, then $TAILORUNE_ENV_FILE), via the same loader, so there is
// still exactly one piece of code that touches a credential.
//
//   node tools/import-keys.mjs
//
// Then paste into the extension's SERVICE WORKER console -- not a page
// console, where `chrome.storage` is undefined. The script says how.

import { execFileSync } from 'node:child_process';
import { loadEnvFiles, PROVIDER_ENV } from '../tests/live/liveEnv.mjs';
import { credentialFingerprint } from '../extension/engine/fingerprint.js';

const SETTINGS_KEY = 'tailorune_settings_v1';

const loadedFrom = loadEnvFiles();
if (!loadedFrom.length) {
  console.error('No env file found. Looked for .env.local in this repo, then $TAILORUNE_ENV_FILE.');
  process.exit(1);
}

const found = Object.entries(PROVIDER_ENV)
  .map(([providerId, envName]) => [providerId, (process.env[envName] || '').trim()])
  .filter(([, key]) => key);

if (!found.length) {
  console.error(`Read ${loadedFrom.join(', ')}, but none of `
    + `${Object.values(PROVIDER_ENV).join(', ')} had a value.`);
  process.exit(1);
}

const providerKeys = Object.fromEntries(found);

// MERGES, because setSettings() replaces the whole object -- writing only
// providerKeys would silently discard the theme, the preferences, the cover
// letter toggle and everything else the popup keeps in there.
//
// `apiKey` is left ALONE rather than being set to one of these. It exists only
// to carry a pre-2.3.0 single-box key through the popup's migration, and
// writing it here would look like a key the user had chosen as primary.
const snippet = `(async () => {
  const K = ${JSON.stringify(SETTINGS_KEY)};
  const incoming = ${JSON.stringify(providerKeys)};
  const cur = (await chrome.storage.local.get(K))[K] || {};
  const next = { ...cur, providerKeys: { ...(cur.providerKeys || {}), ...incoming } };
  await chrome.storage.local.set({ [K]: next });
  console.log('imported', Object.keys(incoming).join(', '),
    '— reopen the popup; the header pill should name them');
})();`;

// clip.exe on Windows; pbcopy/xclip elsewhere. If none works, the script fails
// LOUDLY rather than falling back to printing the snippet -- the fallback is
// the leak this whole file is arranged to avoid.
const CLIPBOARD = process.platform === 'win32' ? [['clip']]
  : process.platform === 'darwin' ? [['pbcopy']]
    : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];

let copied = false;
for (const [cmd, ...args] of CLIPBOARD) {
  try { execFileSync(cmd, args, { input: snippet }); copied = true; break; } catch { /* next */ }
}
if (!copied) {
  console.error(`Could not reach a clipboard (tried ${CLIPBOARD.map((c) => c[0]).join(', ')}).`);
  console.error('Refusing to print the snippet: it contains your keys in plain text.');
  process.exit(1);
}

console.log(`Read ${loadedFrom.length} env file(s). Copied an import for ${found.length} provider(s):`);
for (const [providerId, key] of found) {
  console.log(`  ${providerId.padEnd(11)} ${key.length} chars, fingerprint ${credentialFingerprint(key)}`);
}
console.log(`
The snippet is on your clipboard. It is NOT printed anywhere, on purpose.

  1. CLOSE the Tailorune popup first. An open popup persists what its own
     fields hold about 250ms after any edit, which would overwrite this.
  2. chrome://extensions -> Tailorune -> Details
  3. "Inspect views: service worker"   <- this console, not a page console.
     A page console has no chrome.storage and that is the TypeError you get.
  4. Paste, Enter. It prints which providers it imported.
  5. Open the popup. The header pill should read e.g. "Gemini +2", and the
     three key boxes under the gear should be filled.

Verify with the same fingerprints, in that same console:

  chrome.storage.local.get('${SETTINGS_KEY}').then(r =>
    console.log(Object.keys(r['${SETTINGS_KEY}']?.providerKeys || {})));
`);
