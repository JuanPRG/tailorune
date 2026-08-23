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
// Ported guard from hirepilot_v4/fallback_txt_pdf.py:42-48
// (MIN_EXTRACTABLE_WORDS = 20): a PDF with too little extractable text is
// almost always a scanned/image PDF, not a real parsing failure, and OCR
// is out of scope here exactly as it was there.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;

export const MIN_EXTRACTABLE_WORDS = 20;

export class NoExtractableTextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoExtractableTextError';
  }
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<string>} page texts joined by "\n\n"
 */
export async function extractPdfText(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js returns positioned text items; naive concatenation drops the
    // spaces/newlines a reader expects (confirmed live in
    // SPIKE_FINDINGS.md: "Juan RiveraToronto, ON" with no separator).
    // hasEOL marks a genuine line break; otherwise items on the same line
    // are joined with a space unless one already ends in whitespace.
    let text = '';
    for (const item of content.items) {
      text += item.str;
      if (item.hasEOL) text += '\n';
      else if (item.str && !/\s$/.test(item.str)) text += ' ';
    }
    pageTexts.push(text);
  }

  const fullText = pageTexts.join('\n\n');
  const wordCount = (fullText.match(/\S+/g) || []).length;
  if (wordCount < MIN_EXTRACTABLE_WORDS) {
    throw new NoExtractableTextError(
      `Only ${wordCount} extractable words found -- this looks like a scanned/image PDF, which this tool cannot read text from.`,
    );
  }

  return fullText;
}
