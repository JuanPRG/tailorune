// extractPdfText.js — .pdf -> plain text, via pdf.js.
//
// Imports the prebuilt browser bundle directly (../vendor/pdfjs/pdf.min.mjs,
// copied from node_modules by build/build-offscreen.mjs) rather than the
// bare 'pdfjs-dist' package specifier -- this is the exact shape verified
// safe under the literal MV3 CSP default (script-src 'self'; object-src
// 'self') with zero violations and no wasm-unsafe-eval needed, in
// SPIKE_FINDINGS.md's gap-closure round. The worker file is copied
// alongside it as a separate static asset, since pdf.js loads it via a URL
// at runtime rather than through any bundler's module graph.
//
// The text assembly and the scanned-PDF guard live in pdfText.js, shared
// with the agent API's Node path (server/platform/node.js).

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { extractPdfTextWith } from './pdfText.js';

export { MIN_EXTRACTABLE_WORDS, NoExtractableTextError } from './pdfText.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<string>} page texts joined by "\n\n"
 */
export function extractPdfText(bytes) {
  return extractPdfTextWith(pdfjsLib, bytes);
}
