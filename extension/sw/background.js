// sw/background.js — MV3 service worker.
//
// Two jobs only: keep exactly one offscreen document alive (that is where
// the whole engine — LLM client, parser, tailoring, DOCX renderer — actually
// runs, since a 12-LLM-call pipeline can exceed the service worker's 5-minute
// per-event ceiling; see MIGRATION_PLAN.md §2-3), and trigger the final
// chrome.downloads call once the offscreen document hands back a finished
// file. All chrome.downloads access is kept here rather than in the
// offscreen document deliberately, since offscreen-document access to that
// API was never verified in the Phase 0 spike.
//
// Message convention: every message carries a `target` field ('sw' or
// 'offscreen') so the two listeners never react to each other's traffic —
// the standard pattern for MV3 offscreen documents.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS'],
    justification: 'Runs the LLM tailoring pipeline and builds the tailored .docx as a Blob.',
  });
}

async function triggerDownload(base64, filename) {
  const dataUrl = `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${base64}`;
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' });
  return downloadId;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sw') return undefined;

  (async () => {
    if (message.type === 'tailor:run') {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'tailor:run',
          payload: message.payload,
        });
        if (!result || !result.ok) {
          sendResponse(result || { ok: false, error: 'Offscreen document returned no result.' });
          return;
        }
        const downloadId = await triggerDownload(result.docxBase64, result.filename);
        sendResponse({ ok: true, wordCount: result.wordCount, compactionIterations: result.compactionIterations, downloadId });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })();

  return true; // keep the message channel open for the async sendResponse above
});
