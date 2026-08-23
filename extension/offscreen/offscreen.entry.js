// offscreen/offscreen.entry.js — the actual pipeline: parse -> tailor -> render.
//
// Runs inside the offscreen document (unlimited lifetime, unlike the service
// worker's 5-minute-per-event ceiling — see MIGRATION_PLAN.md §3). Bundled
// by build/build-offscreen.mjs into offscreen.bundle.js, since renderDocx.js
// pulls in the `docx` npm package and MV3's CSP forbids resolving bare
// module specifiers or remote code at runtime.

import { parseTxt } from '../engine/parseTxt.js';
import { tailorResume } from '../engine/tailor.js';
import { renderResumeDocx } from '../engine/renderDocx.js';
import { renderResumeHtml } from '../engine/renderHtml.js';
import { getProvider } from '../engine/providers.js';
import { extractDocxText } from '../engine/extractDocxText.js';
import { extractPdfText } from '../engine/extractPdfText.js';

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Resolves the raw resume text regardless of whether the user pasted text or uploaded a file. */
async function resolveResumeText({ resumeText, resumeFileBase64, resumeFileExt }) {
  if (!resumeFileBase64) return resumeText;
  const bytes = base64ToBytes(resumeFileBase64);
  if (resumeFileExt === '.docx') return extractDocxText(bytes);
  if (resumeFileExt === '.pdf') return extractPdfText(bytes);
  if (resumeFileExt === '.txt') return new TextDecoder('utf-8').decode(bytes);
  throw new Error(`Unsupported resume file type: ${resumeFileExt}`);
}

function slugify(text) {
  return String(text || 'resume')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'resume';
}

function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(new Blob([bytes]));
  });
}

async function runTailor(payload) {
  const { jobDescription, providerId, apiKey, modelName, baseUrlOverride } = payload;

  const resumeText = await resolveResumeText(payload);
  const model = parseTxt(resumeText);
  // baseUrlOverride points at any OpenAI-compatible endpoint instead of the
  // provider's real host — the same escape hatch hirepilot_v4 offered for a
  // local/self-hosted model (config.py's LOCAL_LLM_URL), and what the
  // Playwright e2e test uses to exercise the real pipeline against a local
  // mock server, since context.route() does not intercept fetches made from
  // an offscreen document (confirmed empirically, not documented anywhere).
  const provider = baseUrlOverride ? { ...getProvider(providerId), baseUrl: baseUrlOverride } : getProvider(providerId);

  const { model: tailoredModel, wordCount, compactionIterations } = await tailorResume({
    model,
    jobDescription,
    provider,
    apiKey,
    modelName: modelName || provider.defaultModel,
  });

  const docxBytes = await renderResumeDocx(tailoredModel);
  const docxBase64 = await bytesToBase64(docxBytes);
  const filename = `${slugify(model.name)}_tailored_resume.docx`;
  // Secondary output path (MIGRATION_PLAN.md §3): one content model, two
  // exits. DOCX above auto-downloads; this HTML is opened as a real page so
  // the user can preview it and, if they want a PDF, use the browser's own
  // print-to-PDF -- the same Skia/PDF renderer as the current v4 backend's
  // Playwright path, per SPIKE_FINDINGS.md.
  const htmlPreview = renderResumeHtml(tailoredModel);

  return { ok: true, docxBase64, filename, htmlPreview, wordCount, compactionIterations };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return undefined;
  if (message.type !== 'tailor:run') {
    sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    return undefined;
  }
  runTailor(message.payload)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err), kind: err && err.kind }));
  return true;
});
