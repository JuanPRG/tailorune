// package-extension.mjs — produce a Chrome Web Store upload zip.
//
// Ported in spirit from hirepilot's scripts/build_chrome_web_store_package.py.
// The checks matter more than the zipping: this listing REPLACES HirePilot's,
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

// The version currently live on the store. Overridable, because it is the one
// fact this script cannot read for itself.
const publishedArg = process.argv.indexOf('--published');
const PUBLISHED_VERSION = publishedArg !== -1 ? process.argv[publishedArg + 1] : '2.2.5';

/** Files and directories never shipped: sources, tests, maps. */
const EXCLUDE = [/\.map$/, /(^|[\\/])\./, /(^|[\\/])node_modules([\\/]|$)/];

// Bundled entry points: their source stays out of the package, since the
// bundle already contains it and shipping both doubles the review surface.
const BUNDLED_SOURCES = ['popup/popup.entry.js', 'offscreen/offscreen.entry.js'];

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
console.log('\nThis update ADDS host permissions, so Chrome will disable the extension');
console.log('for existing users until each one accepts. That is expected for this');
console.log('release; the in-popup notice explains it once they re-enable.');
