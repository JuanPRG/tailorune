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
import { renderResumePdf, renderCoverLetterPdf } from '../engine/renderPdf.js';
import { generateCoverLetter } from '../engine/coverLetter.js';
import { tailorSkills } from '../engine/tailorSkills.js';
import { judgeTailoredModel } from '../engine/judge.js';
import {
  chatWithRotation, cooldownState, demoteModel, describeChain,
} from '../engine/rotatingClient.js';
import { resolveProviderChain } from '../engine/providers.js';
import { validatePreferences } from '../engine/preferences.js';
import { extractDocxText } from '../engine/extractDocxText.js';
import { extractPdfText } from '../engine/extractPdfText.js';
import { artifactName } from '../engine/artifactName.js';

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
  // Shared with the popup's header pill, so the number the user is shown and
  // the chain a run actually walks cannot drift apart.
  const chain = resolveProviderChain({
    providerId, apiKey, model: modelName, providerKeys: payload.providerKeys,
  });

  // One rotating caller shared by every stage, so a provider that just got
  // rate-limited during the resume pass is already cooling down by the time
  // the skills and cover-letter passes run.
  // Timing, because "it felt slow" is not something you can act on.
  //
  // The pipeline is up to nine SEQUENTIAL model calls -- resume (2 attempts,
  // each able to trigger a judge call), skills (2), cover letter (3) -- and
  // any of them can rotate across the provider chain on failure. Which of
  // those actually ran is invisible from the finished document, so it is
  // recorded here and reported alongside the word count.
  const llm = { calls: 0, ms: 0, demotions: [] };

  // The model that answered most recently, so a caller whose VALIDATION failed
  // can rotate away from it -- see demoteLast below.
  let lastCall = null;

  const callLlm = async ({ messages, jsonMode, maxTokens, reasoningEffort, task }) => {
    const started = Date.now();
    try {
      const response = await chatWithRotation({
        chain, messages, jsonMode, maxTokens, reasoningEffort, task, baseUrlOverride,
      });
      lastCall = {
        providerId: response.providerId,
        model: response.model,
        mode: response.mode,
        task,
        chainLength: describeChain(chain, task).length,
      };
      return response;
    } finally {
      llm.calls += 1;
      llm.ms += Date.now() - started;
    }
  };

  /**
   * llm.py:1441 `cooldown_last_provider`, wired to the pipeline's retry
   * points. A model can answer perfectly well and still produce output the
   * task cannot use -- a bullet that dropped a quantity, a letter under the
   * word floor. Asking the SAME model again, only with a longer list of
   * complaints, is the least likely thing to work.
   *
   * The hold is task-scoped and 30 seconds, so it shapes this run's retries
   * without sidelining the model for the rest of the session. It no-ops on a
   * one-entry chain, where demotion would just leave the retry nowhere to go.
   */
  const demoteLast = (reason) => {
    if (!lastCall) return false;
    const apiKey = (chain.find((c) => c.providerId === lastCall.providerId) || {}).apiKey;
    const demoted = demoteModel({ ...lastCall, apiKey, reason });
    if (demoted) llm.demotions.push({ model: lastCall.model, task: lastCall.task, reason });
    return demoted;
  };

  const timings = {};
  const timed = async (label, fn) => {
    const started = Date.now();
    const before = llm.calls;
    try {
      return await fn();
    } finally {
      timings[label] = { ms: Date.now() - started, calls: llm.calls - before };
    }
  };

  const job = { title: payload.jobTitle, company: payload.employer, description: jobDescription };

  // The judge is a real extra call per attempt, and it is OPT-IN: it now
  // lives in Settings, unchecked. It is the only check that catches a rewrite
  // swapping in a different-but-plausible activity (see judge.js), so this
  // trades that safety net for a cheaper, faster default run -- worth knowing
  // if a fabrication ever gets through.
  //
  // Default-deny, not `!== false`. The popup always sends the flag, so the
  // two spellings behave identically today; this one means a caller that
  // FORGETS it cannot silently spend an extra call per attempt.
  const useJudge = payload.useJudge === true;
  const judge = useJudge ? (args) => judgeTailoredModel({ ...args, callLlm }) : undefined;

  const { model: tailoredModel, wordCount, compactionIterations, report: resumeReport } = await timed('resume', () => tailorResume({
    model,
    jobDescription,
    preferences,
    callLlm,
    demoteLast,
    judge,
    job,
  }));

  // Skills are a separate pass with their own rules (adding plausible
  // adjacent skills is allowed here, unlike for bullets) and their own
  // deterministic retention guard -- see tailorSkills.js.
  let skillsReport = { status: 'no_change', attempts: 0, reverted: [] };
  if (tailoredModel.skills && tailoredModel.skills.lines.length) {
    const { lines, report } = await timed('skills', () => tailorSkills({
      skillsLines: tailoredModel.skills.lines,
      job,
      callLlm,
      demoteLast,
    }));
    tailoredModel.skills = { ...tailoredModel.skills, lines };
    skillsReport = report;
  }

  // One timestamp for the whole run. The cover letter is generated seconds
  // after the resume, and a run started at 23:59:58 would otherwise hand the
  // user two files stamped different days.
  const stamp = Date.now();
  const nameFor = (kind, ext) => artifactName({
    candidateName: model.name, employer: payload.employer, kind, ext, at: stamp,
  });
  const outputs = [];

  const resumeDocx = await timed('render', () => renderResumeDocx(tailoredModel));
  outputs.push({
    kind: 'resume',
    filename: nameFor('resume', '.docx'),
    base64: await bytesToBase64(resumeDocx),
  });

  // The PDF, when the "PDF copy" chip asks for one.
  //
  // A failure here is NOT fatal: the .docx is the primary artifact and goes
  // out regardless, so a resume that somehow defeats the layout engine costs
  // a format, never the run.
  let resumePdfBase64 = null;
  const resumePdfFilename = nameFor('resume', '.pdf');
  try {
    resumePdfBase64 = await bytesToBase64(await renderResumePdf(tailoredModel, await loadPdfFonts()));
  } catch (err) {
    console.error('resume PDF render failed, falling back to print preview', err);
  }

  // Rendering is unconditional; only DOWNLOADING is a preference. The button
  // needs the bytes whether or not the file was wanted automatically, and 80ms
  // against a 7-17s run is not worth a branch.
  if (resumePdfBase64 && payload.autoDownloadPdf) {
    outputs.push({ kind: 'resume_pdf', filename: resumePdfFilename, base64: resumePdfBase64 });
  }

  let coverLetter = null;
  if (payload.includeCoverLetter) {
    const { paragraphs, report } = await timed('coverLetter', () => generateCoverLetter({
      model: tailoredModel,
      job,
      preferences,
      callLlm,
      demoteLast,
    }));
    const clDocx = await renderCoverLetterDocx({ bodyParagraphs: paragraphs, model: tailoredModel, job });
    outputs.push({
      kind: 'cover_letter',
      filename: nameFor('cover', '.docx'),
      base64: await bytesToBase64(clDocx),
    });
    coverLetter = {
      status: report.status,
      wordCount: report.validator ? report.validator.wordCount : null,
      warnings: report.validator ? report.validator.warnings : [],
      errors: report.validator ? report.validator.errors : [],
      pdfBase64: await (async () => {
        try {
          return await bytesToBase64(await renderCoverLetterPdf(
            { bodyParagraphs: paragraphs, model: tailoredModel, job }, await loadPdfFonts(),
          ));
        } catch (err) {
          console.error('cover letter PDF render failed, falling back to print preview', err);
          return null;
        }
      })(),
      pdfFilename: nameFor('cover', '.pdf'),
    };
    if (coverLetter.pdfBase64 && payload.autoDownloadPdf) {
      outputs.push({
        kind: 'cover_letter_pdf',
        filename: coverLetter.pdfFilename,
        base64: coverLetter.pdfBase64,
      });
    }
  }

  return {
    ok: true,
    outputs,
    wordCount,
    compactionIterations,
    resumeStatus: resumeReport.status,
    resumeWarnings: resumeReport.validator.warnings,
    resumeErrors: resumeReport.validator.errors,
    resumeJudge: resumeReport.judge || null,
    skills: skillsReport,
    coverLetter,
    cooldowns: cooldownState(),
    timings,
    llm,
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
