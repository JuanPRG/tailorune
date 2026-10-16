// deployConfig.test.mjs — what the Vercel deployment of the agent API may contain.
//
// The API deploys from the repo root (it imports extension/engine and the
// root dependencies), and this repo is public and full of things that must
// never be served or uploaded: .env.local holds the API token, server/.data
// holds resumes. These tests pin the three properties that keep it that way,
// plus the files the function cannot run without.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const ignore = readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());

test('nothing in the repo is served as a static file', () => {
  // Without an explicit build, Vercel would run the extension's `npm run build`
  // and serve the repo root -- README, fixtures, everything -- as static files.
  // The build makes exactly one static file (Vercel refuses an empty output):
  // a robots.txt asking crawlers to stay out.
  assert.equal(vercel.framework, null);
  assert.equal(vercel.outputDirectory, 'public');
  assert.equal(vercel.buildCommand, "mkdir -p public && printf 'User-agent: *\\nDisallow: /\\n' > public/robots.txt");
  assert.deepEqual(vercel.rewrites, [{ source: '/(.*)', destination: '/api/index?path=$1' }]);
});

test('the upload is an allowlist, and secrets and local data are excluded', () => {
  assert.equal(ignore[ignore.findIndex((l) => l && !l.startsWith('#'))], '/*', 'starts by ignoring everything');
  for (const needed of ['!/api', '!/server', '!/extension', '!/package.json', '!/package-lock.json', '!/vercel.json']) {
    assert.ok(ignore.includes(needed), `uploads ${needed.slice(1)}`);
  }
  for (const excluded of ['**/.env*', '/server/.data', '/server/.vercel']) {
    assert.ok(ignore.includes(excluded), `excludes ${excluded}`);
  }
});

test('the function gets the time, the region, and the files it reads from disk', () => {
  const fn = vercel.functions['api/index.js'];
  assert.equal(fn.maxDuration, 300, 'a run plus one retry fits; M0 measured Muse waiting 240s');
  for (const file of ['extension/fonts/', 'pdfjs-dist/standard_fonts/', 'pdfjs-dist/legacy/build/pdf.worker.mjs']) {
    assert.ok(fn.includeFiles.includes(file), `includes ${file}`);
  }
  // pdf.js in Node takes DOMMatrix from @napi-rs/canvas, loaded through
  // createRequire at runtime -- which Vercel's file tracing cannot follow, so
  // it must be listed. Without it every PDF upload failed in production with
  // "DOMMatrix is not defined" (found 2026-10-16, when Muse uploaded a PDF).
  assert.ok(fn.includeFiles.includes('node_modules/@napi-rs/'), 'includes the canvas package pdf.js needs');
  assert.deepEqual(vercel.regions, ['iad1'], 'next to the Blob store, which defaults to iad1');
  assert.match(vercel.installCommand, /npm ci --omit=dev/, 'no Playwright or esbuild in the function');
});

test('the entry point serves every method the API routes', async () => {
  const entry = await import('../../api/index.js');
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal(typeof entry[method], 'function', method);
});
