// server/platform/node.js — the Node side of engine/pipeline.js's platform seams.
//
// The extension supplies these from Chrome (offscreen/offscreen.entry.js);
// the agent API supplies them from here. Same pipeline, same fonts, same
// PDF text assembly -- only where the bytes come from differs.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextWith } from '../../extension/engine/pdfText.js';

const FONT_DIR = new URL('../../extension/fonts/', import.meta.url);

/** The three Arimo faces, read once per process -- the same files the extension ships. */
let fontsPromise = null;
function loadFonts() {
  if (fontsPromise) return fontsPromise;
  const face = async (name) => new Uint8Array(await readFile(fileURLToPath(new URL(name, FONT_DIR))));
  fontsPromise = (async () => ({
    regular: await face('arimo-regular.ttf'),
    bold: await face('arimo-bold.ttf'),
    italic: await face('arimo-italic.ttf'),
  }))().catch((err) => { fontsPromise = null; throw err; });
  return fontsPromise;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * pdf.js's legacy build is the one that runs in Node. Loaded lazily, so a
 * run with a text or .docx resume never pays for parsing it.
 */
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      return pdfjsLib;
    }).catch((err) => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

// pdf.js's Node build reads standard fonts from disk, and without them warns
// once per PDF -- on stdout, where the CLI writes the JSON an agent parses.
// Verbosity 0 is errors only.
// The location must end in "/" -- pdf.js rejects a Windows "\" -- and fs
// accepts forward slashes on every platform.
const PDF_DOCUMENT_OPTIONS = Object.freeze({
  standardFontDataUrl: `${path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))).replace(/\\/g, '/')}/standard_fonts/`,
  verbosity: 0,
});

async function extractPdfText(bytes) {
  // pdf.js takes ownership of (and detaches) the buffer it is given, so it
  // gets a copy and the caller's bytes stay usable.
  return extractPdfTextWith(await loadPdfjs(), new Uint8Array(bytes), PDF_DOCUMENT_OPTIONS);
}

export const nodePlatform = Object.freeze({ loadFonts, toBase64, extractPdfText });
