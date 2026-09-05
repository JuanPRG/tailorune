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

import { normalizePageUrl } from '../engine/pageIdentity.js';
import { HISTORY_KEY, rememberTailoring } from '../engine/jobHistory.js';

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

const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

/**
 * Save base64 bytes to the user's Downloads folder, no dialog.
 *
 * `saveAs: false` is the whole point: the DOCX has always landed in Downloads
 * by itself while the PDF demanded a print dialog and a location picker.
 * Given real PDF bytes the same call serves both, so the two artifacts
 * finally behave the same way.
 */
async function triggerDownload(base64, filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${base64}`;
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

const LAST_RUN_KEY = 'tailorune_last_run_v1';

/**
 * Keep the most recent finished run so the popup can show it again.
 *
 * Only the latest, and only what the popup actually renders: the two HTML
 * previews, the findings, and enough context to say which job it was for.
 * The resume TEXT is deliberately not copied here -- it already lives in the
 * resume library, and a second copy is a second thing to leak and to forget
 * to clear.
 */
async function saveLastRun(payload, request) {
  try {
    const at = Date.now();
    const pageUrl = await activePageUrl();
    await chrome.storage.local.set({
      [LAST_RUN_KEY]: {
        at,
        jobTitle: (request && request.jobTitle) || '',
        // The page this run was FOR. Without it the popup cannot tell
        // "reopened on the same posting" from "moved on to a different job",
        // and a finished run stayed on screen -- stale Re-tailor, stale
        // findings, stale save-as-PDF buttons -- over a posting it had
        // nothing to do with.
        pageUrl,
        employer: (request && request.employer) || '',
        // The description this run was actually tailored against.
        //
        // Without it, coming back to a posting you had already tailored
        // restored the RESULT and nothing to re-tailor: the header offered
        // "Re-tailor" over an empty job field. The draft could not cover it
        // -- there is one draft slot, so visiting a second posting overwrites
        // the first -- and the page was never re-read, because a restored run
        // returns before the read.
        //
        // Stored rather than re-read on the way back, because this is the
        // text the output came from. Re-tailoring should mean the same job
        // unless the user changes it, and it still works when the posting has
        // since been edited or taken down.
        jobDescription: (request && request.jobDescription) || '',
        wordCount: payload.wordCount,
        downloads: (payload.downloads || []).map((d) => d.filename),
        resumeStatus: payload.resumeStatus,
        resumeWarnings: payload.resumeWarnings,
        resumeErrors: payload.resumeErrors,
        resumeJudge: payload.resumeJudge,
        skills: payload.skills,
        coverLetterStatus: (payload.coverLetter && payload.coverLetter.status) || null,
        timings: payload.timings,
        llm: payload.llm,
      },
    });

    // ...and a LASTING note that this job has been tailored for, which the
    // single last-run slot cannot be. Tailor five other postings and come
    // back, and the slot has long since moved on; this is what still knows.
    //
    // Identity only -- no description, no output. See jobHistory.js.
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    await chrome.storage.local.set({
      [HISTORY_KEY]: rememberTailoring(stored[HISTORY_KEY], {
        at,
        pageUrl,
        jobTitle: (request && request.jobTitle) || '',
        employer: (request && request.employer) || '',
      }),
    });
  } catch (err) {
    // Never fail a finished run over bookkeeping: the documents are already
    // downloaded and the response is about to be sent.
    console.warn('could not persist the last run', err);
  }
}

/**
 * Read the job posting off the user's active tab.
 *
 * Injected on demand rather than declared as a `content_scripts` entry, so
 * the extension holds no standing access to any page: `activeTab` grants
 * access to exactly one tab, only because the user clicked this extension's
 * own button, and it lapses afterwards. Reading a posting is a strictly
 * narrower capability than filling a form.
 */
const RESTRICTED_URL_RE = /^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i;

/**
 * Translate Chrome's injection failures into something a user can act on.
 *
 * Note `tab.url` is NOT reliably readable here: without the broad `tabs`
 * permission it is only populated for tabs the extension already has access
 * to, so the pre-check below can be skipped entirely on the very page that
 * needs it. The post-hoc mapping is therefore the real guard, and the
 * pre-check is just a faster path when the URL happens to be visible.
 */
function friendlyInjectionError(message) {
  const text = String(message || '');
  if (/chrome:\/\/|Cannot access a chrome/i.test(text)) {
    return 'Chrome blocks reading its own internal pages. Open the job posting in a normal tab first.';
  }
  if (/must request permission|Cannot access contents/i.test(text)) {
    // activeTab is granted only when the user invokes the extension on that
    // tab -- i.e. by clicking its toolbar icon while the job page is open.
    return 'Open the job posting in the active tab, then click the Tailorune toolbar icon and try again.';
  }
  if (/No tab with id|No active tab/i.test(text)) {
    return 'No active tab to read. Open the job posting first.';
  }
  return `Could not read this page: ${text}`;
}

/** The active tab's normalized URL, or '' when there is nothing readable. */
async function activePageUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || RESTRICTED_URL_RE.test(tab.url)) return '';
    return normalizePageUrl(tab.url);
  } catch {
    return '';
  }
}

async function extractJobFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('No active tab to read. Open the job posting first.');
  if (RESTRICTED_URL_RE.test(tab.url || '')) {
    throw new Error('This page cannot be read. Open the job posting in a normal tab first.');
  }

  let injected;
  try {
    [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/extractJob.js'],
    });
  } catch (err) {
    throw new Error(friendlyInjectionError((err && err.message) || err));
  }

  if (!injected || !injected.result) throw new Error('Could not find a job posting on this page.');
  return injected.result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'sw') return undefined;

  (async () => {
    // Cheap enough to ask on every open, and the popup needs the answer
    // BEFORE it decides whether to restore a run or read the page.
    if (message.type === 'tab:url') {
      sendResponse({ ok: true, url: await activePageUrl() });
      return;
    }

    if (message.type === 'job:extract') {
      try {
        sendResponse({ ok: true, job: await extractJobFromActiveTab() });
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }

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
        const payload = {
          ok: true,
          wordCount: result.wordCount,
          compactionIterations: result.compactionIterations,
          downloads,
          resumeStatus: result.resumeStatus,
          resumeWarnings: result.resumeWarnings,
          resumeErrors: result.resumeErrors,
          resumeJudge: result.resumeJudge,
          skills: result.skills,
          coverLetter: result.coverLetter,
          cooldowns: result.cooldowns,
          timings: result.timings,
          llm: result.llm,
        };

        // Persist BEFORE responding, and unconditionally.
        //
        // A browser-action popup is destroyed the moment it loses focus, so
        // if the user tabs away while this runs -- or even glances at the
        // download shelf -- sendResponse below has nowhere to land and the
        // whole result is dropped: previews, findings, timings, the lot. The
        // .docx files survive because downloadOutputs() already ran, which
        // makes the loss especially confusing: the files are there and the
        // reasons they look the way they do are gone.
        //
        // Writing it here rather than in the popup is what makes a run
        // survivable. The popup restores it on next open.
        await saveLastRun(payload, message.payload);
        sendResponse(payload);
      } catch (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
      return;
    }
    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
  })();

  return true; // keep the message channel open for the async sendResponse above
});
