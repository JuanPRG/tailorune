// build-offscreen.mjs — bundle the offscreen entry (and its `docx` dependency)
// into one file the offscreen document's <script type="module"> can load
// under MV3's CSP. Verified safe in SPIKE_FINDINGS.md: `docx` runs under the
// literal MV3 default header (script-src 'self'; object-src 'self') with
// zero violations, no wasm-unsafe-eval required.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// pdf.js's worker is loaded by URL at runtime, not through any bundler's
// module graph -- it must exist as a real static file in the extension,
// copied straight from the same prebuilt package files verified safe under
// MV3 CSP in SPIKE_FINDINGS.md (not resolved via the bare 'pdfjs-dist'
// specifier). The main-thread pdf.min.mjs is vendored the same way so
// extractPdfText.js's relative import has something real to bundle.
const vendorDir = path.join(root, 'extension/vendor/pdfjs');
mkdirSync(vendorDir, { recursive: true });
for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build', file), path.join(vendorDir, file));
}
console.log('vendored extension/vendor/pdfjs/{pdf.min.mjs,pdf.worker.min.mjs}');

await build({
  entryPoints: [path.join(root, 'extension/offscreen/offscreen.entry.js')],
  outfile: path.join(root, 'extension/offscreen/offscreen.bundle.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: false,
  sourcemap: false,
  target: ['chrome116'],
  // pdf.min.mjs ends up bundled inline (it's imported, not loaded by URL);
  // the worker file above is deliberately left untouched by this step.
});

console.log('built extension/offscreen/offscreen.bundle.js');
