// offscreen/offscreen.entry.js — runs the tailoring pipeline for the extension.
//
// The pipeline itself lives in engine/pipeline.js, shared with the agent API
// (docs/AGENT_API_PLAN.md M1). This file supplies the three things that are
// Chrome's to supply -- fonts from the extension package, FileReader base64,
// and the vendored pdf.js -- and answers the service worker's message.
//
// Runs inside the offscreen document (unlimited lifetime, unlike the service
// worker's 5-minute-per-event ceiling — see MIGRATION_PLAN.md §3). Bundled
// by build/build-offscreen.mjs into offscreen.bundle.js, since renderDocx.js
// pulls in the `docx` npm package and MV3's CSP forbids resolving bare
// module specifiers or remote code at runtime.

import { runTailorPipeline } from '../engine/pipeline.js';
import { extractPdfText } from '../engine/extractPdfText.js';

/**
 * The three Arimo faces, fetched once per offscreen document.
 *
 * They are extension resources rather than bundled base64 because 134KB of
 * font inlined into offscreen.bundle.js is 134KB parsed on every startup,
 * whether or not anyone asks for a PDF.
 */
let fontsPromise = null;
function loadPdfFonts() {
  if (fontsPromise) return fontsPromise;
  const face = async (name) => new Uint8Array(
    await (await fetch(chrome.runtime.getURL(`fonts/${name}`))).arrayBuffer(),
  );
  fontsPromise = (async () => ({
    regular: await face('arimo-regular.ttf'),
    bold: await face('arimo-bold.ttf'),
    italic: await face('arimo-italic.ttf'),
  }))().catch((err) => { fontsPromise = null; throw err; });
  return fontsPromise;
}

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(new Blob([bytes]));
  });
}

const chromePlatform = { loadFonts: loadPdfFonts, toBase64: bytesToBase64, extractPdfText };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;

  if (message.type !== 'tailor:run') {
    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    return undefined;
  }
  runTailorPipeline(message.payload, chromePlatform)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), kind: err && err.kind }));
  return true;
});
