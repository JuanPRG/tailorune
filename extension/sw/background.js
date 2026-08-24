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

/**
 * Download every produced artifact (tailored resume, and the cover letter
 * when requested). Sequential rather than Promise.all: two data-URL
 * downloads fired simultaneously is exactly the kind of race the v4 backend
 * had to add a whole staging-and-move dance to work around
 * (server.py:604-630), and there is no reason to invite it back here.
 */
async function downloadOutputs(outputs) {
  const results = [];
  for (const output of outputs || []) {
    results.push({
      kind: output.kind,
      filename: output.filename,
      downloadId: await triggerDownload(output.base64, output.filename),
    });
  }
  return results;
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
        const downloads = await downloadOutputs(result.outputs);
        sendResponse({
          ok: true,
          wordCount: result.wordCount,
          compactionIterations: result.compactionIterations,
          downloads,
          htmlPreview: result.htmlPreview,
          resumeStatus: result.resumeStatus,
          resumeWarnings: result.resumeWarnings,
          resumeErrors: result.resumeErrors,
          skills: result.skills,
          coverLetter: result.coverLetter,
          cooldowns: result.cooldowns,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })();

  return true; // keep the message channel open for the async sendResponse above
});
