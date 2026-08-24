// offscreen/offscreen.entry.js — the actual pipeline: parse -> tailor -> render.
//
// Runs inside the offscreen document (unlimited lifetime, unlike the service
// worker's 5-minute-per-event ceiling — see MIGRATION_PLAN.md §3). Bundled
// by build/build-offscreen.mjs into offscreen.bundle.js, since renderDocx.js
// pulls in the `docx` npm package and MV3's CSP forbids resolving bare
// module specifiers or remote code at runtime.

import { parseTxt } from '../engine/parseTxt.js';
import { tailorResume } from '../engine/tailor.js';
import { renderResumeDocx, renderCoverLetterDocx } from '../engine/renderDocx.js';
import { renderResumeHtml } from '../engine/renderHtml.js';
import { generateCoverLetter, renderCoverLetterHtml } from '../engine/coverLetter.js';
import { tailorSkills } from '../engine/tailorSkills.js';
import { judgeTailoredModel } from '../engine/judge.js';
import { chatWithRotation, cooldownState } from '../engine/rotatingClient.js';
import { validatePreferences } from '../engine/preferences.js';
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
  const preferences = validatePreferences(payload.preferences || {});

  // The provider chain: the user's selected provider first, then every other
  // provider they've supplied a key for, so a rate limit on the primary fails
  // over instead of failing the run. `providerKeys` is a {providerId: key}
  // map from the popup; `apiKey`/`providerId` remain the primary selection.
  //
  // baseUrlOverride points every entry at one OpenAI-compatible endpoint
  // instead of the real hosts — the same escape hatch hirepilot_v4 offered
  // for a local/self-hosted model (config.py's LOCAL_LLM_URL), and what the
  // Playwright e2e tests use to exercise the real pipeline against a local
  // mock server, since context.route() does not intercept fetches made from
  // an offscreen document (confirmed empirically, not documented anywhere).
  const providerKeys = payload.providerKeys || {};
  const chain = [{ providerId, apiKey, model: modelName || undefined }];
  for (const [id, key] of Object.entries(providerKeys)) {
    if (id !== providerId && key) chain.push({ providerId: id, apiKey: key });
  }

  // One rotating caller shared by every stage, so a provider that just got
  // rate-limited during the resume pass is already cooling down by the time
  // the skills and cover-letter passes run.
  const callLlm = ({ messages, jsonMode, maxTokens }) => chatWithRotation({
    chain, messages, jsonMode, maxTokens, baseUrlOverride,
  });

  const job = { title: payload.jobTitle, company: payload.employer, description: jobDescription };

  // The judge is a real extra call per attempt, so it is opt-out rather than
  // mandatory -- but defaults ON, because it is the only check that catches a
  // rewrite swapping in a different-but-plausible activity (see judge.js).
  const useJudge = payload.useJudge !== false;
  const judge = useJudge ? (args) => judgeTailoredModel({ ...args, callLlm }) : undefined;

  const { model: tailoredModel, wordCount, compactionIterations, report: resumeReport } = await tailorResume({
    model,
    jobDescription,
    preferences,
    callLlm,
    judge,
    job,
  });

  // Skills are a separate pass with their own rules (adding plausible
  // adjacent skills is allowed here, unlike for bullets) and their own
  // deterministic retention guard -- see tailorSkills.js.
  let skillsReport = { status: 'no_change', attempts: 0, reverted: [] };
  if (tailoredModel.skills && tailoredModel.skills.lines.length) {
    const { lines, report } = await tailorSkills({
      skillsLines: tailoredModel.skills.lines,
      job,
      callLlm,
    });
    tailoredModel.skills = { ...tailoredModel.skills, lines };
    skillsReport = report;
  }

  const slug = slugify(model.name);
  const outputs = [];

  const resumeDocx = await renderResumeDocx(tailoredModel);
  outputs.push({
    kind: 'resume',
    filename: `${slug}_tailored_resume.docx`,
    base64: await bytesToBase64(resumeDocx),
  });

  // Secondary output path (MIGRATION_PLAN.md §3): one content model, two
  // exits. The DOCX above auto-downloads; this HTML is opened as a real page
  // so the user can preview it and, if they want a PDF, use the browser's own
  // print-to-PDF -- the same Skia/PDF renderer as the v4 backend's Playwright
  // path, per SPIKE_FINDINGS.md.
  const htmlPreview = renderResumeHtml(tailoredModel);

  let coverLetter = null;
  if (payload.includeCoverLetter) {
    const { paragraphs, report } = await generateCoverLetter({
      model: tailoredModel,
      job,
      preferences,
      callLlm,
    });
    const clDocx = await renderCoverLetterDocx({ bodyParagraphs: paragraphs, model: tailoredModel, job });
    outputs.push({
      kind: 'cover_letter',
      filename: `${slug}_cover_letter.docx`,
      base64: await bytesToBase64(clDocx),
    });
    coverLetter = {
      status: report.status,
      wordCount: report.validator ? report.validator.wordCount : null,
      warnings: report.validator ? report.validator.warnings : [],
      errors: report.validator ? report.validator.errors : [],
      htmlPreview: renderCoverLetterHtml({ bodyParagraphs: paragraphs, model: tailoredModel, job }),
    };
  }

  return {
    ok: true,
    outputs,
    htmlPreview,
    wordCount,
    compactionIterations,
    resumeStatus: resumeReport.status,
    resumeWarnings: resumeReport.validator.warnings,
    resumeErrors: resumeReport.validator.errors,
    resumeJudge: resumeReport.judge || null,
    skills: skillsReport,
    coverLetter,
    cooldowns: cooldownState(),
  };
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
