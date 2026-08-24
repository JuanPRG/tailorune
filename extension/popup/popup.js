// popup/popup.js — the whole UI: paste or upload a resume plus a job
// description, get a tailored .docx (and optionally a cover letter .docx)
// in Downloads, with an HTML preview of each for browser print-to-PDF.
//
// No bundling needed: this file imports only relative, dependency-free
// modules plus the ambient `chrome` global, so MV3's native ES module
// loading handles it directly.

import { getSettings, setSettings } from '../engine/store.js';

const $ = (id) => document.getElementById(id);
const els = {
  resumeText: $('resumeText'),
  resumeFile: $('resumeFile'),
  jobDescription: $('jobDescription'),
  jobTitle: $('jobTitle'),
  employer: $('employer'),
  includeCoverLetter: $('includeCoverLetter'),
  resumeDensity: $('resumeDensity'),
  keywordAlignment: $('keywordAlignment'),
  coverLetterLength: $('coverLetterLength'),
  coverLetterTone: $('coverLetterTone'),
  preservePoints: $('preservePoints'),
  resumeNotes: $('resumeNotes'),
  coverLetterNotes: $('coverLetterNotes'),
  provider: $('provider'),
  modelName: $('modelName'),
  apiKey: $('apiKey'),
  providerDetails: $('providerDetails'),
  tailorBtn: $('tailorBtn'),
  previewBtn: $('previewBtn'),
  previewClBtn: $('previewClBtn'),
  status: $('status'),
  warnings: $('warnings'),
  result: $('result'),
};

let lastResumeHtml = null;
let lastCoverLetterHtml = null;

function openHtmlInTab(html) {
  chrome.tabs.create({ url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
}

els.previewBtn.addEventListener('click', () => lastResumeHtml && openHtmlInTab(lastResumeHtml));
els.previewClBtn.addEventListener('click', () => lastCoverLetterHtml && openHtmlInTab(lastCoverLetterHtml));

function collectPreferences() {
  return {
    resume_density: els.resumeDensity.value,
    keyword_alignment: els.keywordAlignment.value,
    cover_letter_length: els.coverLetterLength.value,
    cover_letter_tone: els.coverLetterTone.value,
    preserve_points: els.preservePoints.value.trim(),
    resume_notes: els.resumeNotes.value.trim(),
    cover_letter_notes: els.coverLetterNotes.value.trim(),
    emphasis_areas: [],
  };
}

function applyPreferences(prefs) {
  if (!prefs) return;
  if (prefs.resume_density) els.resumeDensity.value = prefs.resume_density;
  if (prefs.keyword_alignment) els.keywordAlignment.value = prefs.keyword_alignment;
  if (prefs.cover_letter_length) els.coverLetterLength.value = prefs.cover_letter_length;
  if (prefs.cover_letter_tone) els.coverLetterTone.value = prefs.cover_letter_tone;
  els.preservePoints.value = prefs.preserve_points || '';
  els.resumeNotes.value = prefs.resume_notes || '';
  els.coverLetterNotes.value = prefs.cover_letter_notes || '';
}

async function restoreSettings() {
  const settings = await getSettings();
  // No key saved yet means this is a first run: expand the provider section
  // rather than hiding the one field the user MUST fill behind a collapsed
  // <details>. (Found by an e2e test that couldn't fill it either.)
  if (!settings || !settings.apiKey) els.providerDetails.open = true;
  if (!settings) return;
  if (settings.provider) els.provider.value = settings.provider;
  if (settings.model) els.modelName.value = settings.model;
  if (settings.apiKey) els.apiKey.value = settings.apiKey;
  if (typeof settings.includeCoverLetter === 'boolean') els.includeCoverLetter.checked = settings.includeCoverLetter;
  applyPreferences(settings.preferences);
}

function setStatus(text) {
  els.status.textContent = text;
}

/** Surface validation findings honestly instead of only reporting success. */
function renderFindings({ resumeStatus, resumeWarnings, resumeErrors, coverLetter }) {
  const blocks = [];
  const resumeIssues = [...(resumeErrors || []), ...(resumeWarnings || [])];
  if (resumeStatus && resumeStatus !== 'approved' && resumeIssues.length) {
    blocks.push(`<strong>Resume (${resumeStatus}):</strong><ul>${resumeIssues.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  }
  if (coverLetter) {
    const clIssues = [...(coverLetter.errors || []), ...(coverLetter.warnings || [])];
    if (coverLetter.status !== 'approved' && clIssues.length) {
      blocks.push(`<strong>Cover letter (${coverLetter.status}):</strong><ul>${clIssues.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    }
  }
  els.warnings.innerHTML = blocks.join('');
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

async function onTailorClick() {
  const resumeText = els.resumeText.value.trim();
  const jobDescription = els.jobDescription.value.trim();
  const providerId = els.provider.value;
  const modelName = els.modelName.value.trim();
  const apiKey = els.apiKey.value.trim();
  const file = els.resumeFile.files[0];
  const includeCoverLetter = els.includeCoverLetter.checked;
  const preferences = collectPreferences();

  if (!resumeText && !file) { setStatus('Paste your resume or upload a file first.'); return; }
  if (!jobDescription) { setStatus('Paste the job description first.'); return; }
  if (!apiKey) { setStatus('Enter an API key first (AI provider section).'); return; }

  let resumeFileBase64;
  let resumeFileExt;
  if (file) {
    resumeFileExt = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    resumeFileBase64 = await readFileAsBase64(file);
  }

  await setSettings({ provider: providerId, model: modelName, apiKey, includeCoverLetter, preferences });

  els.tailorBtn.disabled = true;
  els.previewBtn.style.display = 'none';
  els.previewClBtn.style.display = 'none';
  els.warnings.innerHTML = '';
  els.result.textContent = '';
  setStatus(includeCoverLetter
    ? 'Tailoring resume and writing cover letter... this can take a couple of minutes.'
    : 'Tailoring... this can take up to a minute.');

  // baseUrlOverride is a debug/testing affordance only: point at any
  // OpenAI-compatible endpoint instead of the selected provider's real host.
  // Normal usage never sets it -- Chrome opens default_popup with no query.
  const baseUrlOverride = new URLSearchParams(location.search).get('llmBaseUrlOverride') || undefined;

  try {
    const response = await chrome.runtime.sendMessage({
      target: 'sw',
      type: 'tailor:run',
      payload: {
        resumeText, resumeFileBase64, resumeFileExt, jobDescription,
        jobTitle: els.jobTitle.value.trim(), employer: els.employer.value.trim(),
        includeCoverLetter, preferences,
        providerId, apiKey, modelName, baseUrlOverride,
      },
    });
    els.result.textContent = JSON.stringify(response);

    if (response && response.ok) {
      const files = (response.downloads || []).length;
      setStatus(`Done — ${response.wordCount} words, ${files} file${files === 1 ? '' : 's'} in Downloads.`);
      renderFindings(response);
      lastResumeHtml = response.htmlPreview || null;
      lastCoverLetterHtml = response.coverLetter ? response.coverLetter.htmlPreview : null;
      els.previewBtn.style.display = lastResumeHtml ? 'block' : 'none';
      els.previewClBtn.style.display = lastCoverLetterHtml ? 'block' : 'none';
    } else {
      setStatus(`Failed: ${(response && response.error) || 'unknown error'}`);
    }
  } catch (err) {
    setStatus(`Failed: ${err && err.message ? err.message : err}`);
    els.result.textContent = JSON.stringify({ ok: false, error: String(err) });
  } finally {
    els.tailorBtn.disabled = false;
  }
}

els.tailorBtn.addEventListener('click', onTailorClick);
restoreSettings();
