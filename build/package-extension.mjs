// package-extension.mjs — produce a Chrome Web Store upload zip.
//
// Ported in spirit from v4's scripts/build_chrome_web_store_package.py.
// The checks matter more than the zipping: this listing REPLACES the previously published one,
// so a mistake here does not fail loudly — it either gets rejected at upload,
// or worse, publishes something that reaches every existing user.
//
// What it refuses to package, and why each one is a real failure:
//
//   - a version not strictly greater than the published one. Chrome rejects
//     the upload, but only after review time has been spent.
//   - a missing build. The bundles are gitignored, so a clean checkout has
//     none, and a zip without them installs and does nothing.
//   - a provider whose host is absent from host_permissions. MV3 blocks the
//     request at runtime and it surfaces as a network error, so it survives
//     review and breaks only once a user's rotation reaches that provider.
//
// Usage: node build/package-extension.mjs [--published <version>]

import {
  readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const OUT_DIR = path.join(ROOT, 'dist');

// The version currently live on the store, and the one fact this script cannot
// discover for itself.
//
// READ FROM A FILE, not hard-coded. This is a SAME-ITEM UPDATE workflow -- the
// listing that was the previous product's -- so Chrome enforces a strictly increasing
// version on every upload, and getting it wrong costs a review cycle. As a
// literal default it protected exactly one release: the moment 2.3.0 went
// live, a hard-coded 2.2.5 would happily let 2.3.0 be packaged over itself
// again, which is the case the gate exists to catch.
//
// store/PUBLISHED_VERSION is bumped AFTER a successful upload, so the file
// always answers "what is live right now". --published still overrides.
const publishedArg = process.argv.indexOf('--published');
const PUBLISHED_FILE = path.join(ROOT, 'store/PUBLISHED_VERSION');
const PUBLISHED_VERSION = publishedArg !== -1
  ? process.argv[publishedArg + 1]
  : readFileSync(PUBLISHED_FILE, 'utf8').trim();

/** Files and directories never shipped: sources, tests, maps. */
const EXCLUDE = [/\.map$/, /(^|[\\/])\./, /(^|[\\/])node_modules([\\/]|$)/];

// Source that is already inside a shipped artifact. Shipping it twice doubles
// the review surface and, for the mascot, wastes a quarter of a megabyte.
//
//   *.entry.js    -- their bundles contain them
//   *-mark.svg    -- inlined in popup.html, and rasterised to PNG at build
//                    time by build/make-icons.mjs
//   *-raccoon.svg -- inlined in popup.html's empty state, and used by
//                    build/make-store-assets.mjs for the listing artwork
const BUNDLED_SOURCES = [
  'popup/popup.entry.js',
  'offscreen/offscreen.entry.js',
  'icons/tailorune-mark.svg',
  'icons/tailorune-raccoon.svg',
];

const problems = [];
const note = (msg) => console.log(`  ${msg}`);

const manifest = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

// --- version ----------------------------------------------------------------
const parse = (v) => String(v).split('.').map(Number);
const greater = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
};
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  problems.push(`version "${manifest.version}" is not Chrome-compatible (1-4 dot-separated integers)`);
} else if (!greater(manifest.version, PUBLISHED_VERSION)) {
  problems.push(
    `version ${manifest.version} is not greater than the published ${PUBLISHED_VERSION} — `
    + 'Chrome will reject the upload',
  );
}

// --- build output present ---------------------------------------------------
for (const bundle of ['popup/popup.bundle.js', 'offscreen/offscreen.bundle.js']) {
  const file = path.join(EXT, bundle);
  if (!existsSync(file)) problems.push(`missing ${bundle} — run \`npm run build\` first`);
  else if (statSync(file).size < 1000) problems.push(`${bundle} looks truncated`);
}
if (!existsSync(path.join(EXT, 'vendor/pdfjs/pdf.worker.min.mjs'))) {
  problems.push('missing vendor/pdfjs — run `npm run build` first');
}

// --- providers reachable ----------------------------------------------------
const { PROVIDERS } = await import('../extension/engine/providers.js');
const hosts = manifest.host_permissions || [];
for (const [id, provider] of Object.entries(PROVIDERS)) {
  const { hostname } = new URL(provider.baseUrl);
  const covered = hosts.some((p) => {
    const m = /^(?:\*|https?):\/\/([^/]+)\//.exec(p);
    if (!m) return false;
    return m[1] === hostname || (m[1].startsWith('*.') && hostname.endsWith(m[1].slice(1)));
  });
  if (!covered) problems.push(`provider "${id}" (${hostname}) has no matching host_permission`);
}

if (problems.length) {
  console.error('\nRefusing to package:\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// --- zip --------------------------------------------------------------------
const zip = new JSZip();
let count = 0;

function add(dir, prefix = '') {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    if (BUNDLED_SOURCES.includes(rel)) continue;
    if (statSync(full).isDirectory()) add(full, rel);
    else { zip.file(rel, readFileSync(full)); count += 1; }
  }
}
add(EXT);

mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `tailorune-${manifest.version}.zip`);
writeFileSync(outFile, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

console.log(`\npackaged ${path.relative(ROOT, outFile)}`);
note(`${count} files, ${(statSync(outFile).size / 1024).toFixed(0)} KB`);
note(`version ${manifest.version} (replacing ${PUBLISHED_VERSION})`);
note(`providers: ${Object.keys(PROVIDERS).join(', ')}`);
// A disable-until-accepted prompt only happens when an EXISTING install gains
// permissions.
//
// THIS USED TO SAY there were no installs, so nobody could be interrupted and
// there was nothing to plan around. That stopped being true the moment 2.3.0
// published. It also cannot be replaced with "permissions are unchanged",
// because nothing here knows what the PUBLISHED build declared -- the only
// state this script has about the live version is its version number. So it
// prints what this build declares and leaves the comparison to a human, which
// is the honest version. Removing a permission is silent and safe; adding one
// disables the extension for every existing user until each accepts it.
console.log('\nThere ARE published installs now, so permission changes are not free.');
console.log('This build declares:');
console.log(`  permissions      ${(manifest.permissions || []).join(', ') || '(none)'}`);
console.log(`  host_permissions ${hosts.join(', ') || '(none)'}`);
console.log('Compare that against the live listing before uploading. Anything ADDED');
console.log('here disables the extension for existing users until each one accepts.');
