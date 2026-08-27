// popup/popup.js — the whole UI: paste or upload a resume plus a job
// description, get a tailored .docx (and optionally a cover letter .docx)
// in Downloads, with an HTML preview of each for browser print-to-PDF.
//
// No bundling needed: this file imports only relative, dependency-free
// modules plus the ambient `chrome` global, so MV3's native ES module
// loading handles it directly.

import { getSettings, setSettings } from '../engine/store.js';
import {
  chromeStorageAdapter, loadLibrary, saveResume, deleteResume, markUsed, suggestName,
} from '../engine/resumeLibrary.js';

const $ = (id) => document.getElementById(id);
const els = {
  resumeText: $('resumeText'),
  resumeFile: $('resumeFile'),
  savedResumes: $('savedResumes'),
  resumeName: $('resumeName'),
  saveResumeBtn: $('saveResumeBtn'),
  deleteResumeBtn: $('deleteResumeBtn'),
  libraryHint: $('libraryHint'),
  jobDescription: $('jobDescription'),
  readPageBtn: $('readPageBtn'),
  extractHint: $('extractHint'),
  jobTitle: $('jobTitle'),
  employer: $('employer'),
  includeCoverLetter: $('includeCoverLetter'),
  useJudge: $('useJudge'),
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
  fallbackGemini: $('fallbackGemini'),
  fallbackGroq: $('fallbackGroq'),
  fallbackCerebras: $('fallbackCerebras'),
  fallbackOpenrouter: $('fallbackOpenrouter'),
  tailorBtn: $('tailorBtn'),
  previewBtn: $('previewBtn'),
  previewClBtn: $('previewClBtn'),
  status: $('status'),
  warnings: $('warnings'),
  result: $('result'),
};

let lastResumeHtml = null;
let lastCoverLetterHtml = null;

const storage = chromeStorageAdapter();

// In-flight file extraction, if any. Clicking "Tailor resume" while a file is
// still being read must WAIT for it, not fail with "paste your resume first"
// -- a large .pdf takes noticeably longer than a .docx (pdf.js has a worker to
// spin up), which is exactly long enough for a user to click through it.
// Disabling the button instead would trade one dead end for another.
let pendingExtraction = null;

// ---------------------------------------------------------------- library --

function setLibraryHint(text) {
  els.libraryHint.textContent = text || '';
}

/**
 * Repaint the dropdown from storage and, when asked, load the selected
 * resume's text into the textarea.
 *
 * `selectId` defaults to the last-used resume, which is the entire point of
 * the feature: the common case is one resume reused for every application,
 * and that case should cost zero clicks on open.
 */
async function refreshLibrary({ selectId, loadText = false } = {}) {
  const library = await loadLibrary(storage);
  const chosen = selectId !== undefined ? selectId : library.lastUsedId;

  els.savedResumes.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = library.resumes.length ? '— not saved —' : '— none saved —';
  els.savedResumes.appendChild(none);
  for (const resume of library.resumes) {
    const option = document.createElement('option');
    option.value = resume.id;
    option.textContent = resume.name;
    els.savedResumes.appendChild(option);
  }

  const match = library.resumes.find((r) => r.id === chosen);
  els.savedResumes.value = match ? match.id : '';
  if (match) els.resumeName.value = match.name;
  if (match && loadText) els.resumeText.value = match.text;
  return library;
}

async function onSelectResume() {
  // Changing the selection cancels an armed delete: the armed id would no
  // longer match, but the button label must stop saying "Confirm".
  disarmDelete();
  const id = els.savedResumes.value;
  if (!id) return;
  const library = await loadLibrary(storage);
  const match = library.resumes.find((r) => r.id === id);
  if (!match) return;
  els.resumeText.value = match.text;
  els.resumeName.value = match.name;
  // Clear any staged upload: the textarea is now the source of truth, and
  // leaving a file selected would silently override the resume just chosen.
  els.resumeFile.value = '';
  await markUsed(storage, id);
  setLibraryHint(`Loaded "${match.name}".`);
}

/**
 * Save whatever is in the textarea under the name in the name field.
 *
 * The name comes from a real input rather than window.prompt(). That is not a
 * style preference: opening a JS dialog from a browser-action popup dismisses
 * the popup, and prompt() returns null, so the save silently never happened.
 * It looked fine in tests only because Playwright loads popup.html as an
 * ordinary tab, where dialogs behave normally -- the one context difference
 * that mattered. Nothing in this file may depend on prompt/confirm/alert.
 */
async function onSaveResume() {
  const text = await ensureResumeText();
  if (!text) { setLibraryHint('Nothing to save — paste or upload a resume first.'); return; }

  const selectedId = els.savedResumes.value;
  const library = await loadLibrary(storage);
  const existing = library.resumes.find((r) => r.id === selectedId);
  const name = els.resumeName.value.trim() || (existing ? existing.name : suggestName(text));

  try {
    // Pass the id only when the user is updating the resume they had loaded
    // under its own name; otherwise let saveResume() decide by name, so
    // re-saving under an existing name updates it rather than duplicating it.
    const saved = await saveResume(storage, {
      id: existing && existing.name === name ? existing.id : undefined,
      name,
      text,
    });
    await refreshLibrary({ selectId: saved.id });
    els.resumeName.value = saved.name;
    setLibraryHint(`Saved as "${saved.name}".`);
  } catch (err) {
    setLibraryHint(String((err && err.message) || err));
  }
}

/**
 * Delete needs a confirmation step, and window.confirm() is unavailable for
 * the same reason prompt() is (see onSaveResume). So it is two-step: the
 * first click arms, a second click within a few seconds commits. Arming is
 * scoped to the id that was selected, so changing the dropdown between clicks
 * cannot delete something the user never armed.
 */
const DELETE_ARM_MS = 4000;
let armedDeleteId = null;
let armedDeleteTimer = null;

function disarmDelete() {
  armedDeleteId = null;
  if (armedDeleteTimer) { clearTimeout(armedDeleteTimer); armedDeleteTimer = null; }
  els.deleteResumeBtn.textContent = 'Delete';
}

async function onDeleteResume() {
  const id = els.savedResumes.value;
  if (!id) { setLibraryHint('Select a saved resume to delete.'); return; }
  const library = await loadLibrary(storage);
  const match = library.resumes.find((r) => r.id === id);
  if (!match) return;

  if (armedDeleteId !== id) {
    disarmDelete();
    armedDeleteId = id;
    els.deleteResumeBtn.textContent = 'Confirm';
    setLibraryHint(`Click Confirm to delete "${match.name}". This cannot be undone.`);
    armedDeleteTimer = setTimeout(() => {
      disarmDelete();
      setLibraryHint('');
    }, DELETE_ARM_MS);
    return;
  }

  disarmDelete();
  await deleteResume(storage, id);
  await refreshLibrary({ selectId: '' });
  els.resumeName.value = '';
  setLibraryHint(`Deleted "${match.name}".`);
}

/**
 * Turn an uploaded file into text immediately, rather than at tailoring time.
 *
 * Extraction needs JSZip/pdf.js, which live in the offscreen bundle, so this
 * round-trips through the service worker. Doing it on selection rather than
 * on run is what makes the file saveable to the library at all -- and it
 * surfaces an unreadable PDF right away instead of a minute into a run.
 */
/** Extract the currently selected file into the textarea. Returns its text, or null. */
async function extractSelectedFile() {
  const file = els.resumeFile.files[0];
  if (!file) return null;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  setLibraryHint(`Reading ${file.name}...`);

  pendingExtraction = (async () => {
    try {
      const base64 = await readFileAsBase64(file);
      const response = await chrome.runtime.sendMessage({
        target: 'sw',
        type: 'resume:extract',
        payload: { resumeFileBase64: base64, resumeFileExt: ext },
      });
      if (!response || !response.ok) {
        // Surfaced in BOTH places on purpose. The hint is right under the
        // button that failed, but it is also the line every other library
        // action overwrites -- so a failure that scrolls past unnoticed
        // becomes "it just does nothing", which is exactly how this was
        // reported. #status is the durable copy.
        const message = `Could not read ${file.name}: ${(response && response.error) || 'unknown error'}`;
        setLibraryHint(message);
        setStatus(message);
        return null;
      }
      els.resumeText.value = response.text;
      els.savedResumes.value = '';
      // Default the name to the file's own base name -- it is almost always a
      // better label than the first line of the resume, which is just the
      // person's name and identical across every one of their resumes.
      if (!els.resumeName.value.trim()) {
        els.resumeName.value = file.name.replace(/\.[^.]+$/, '');
      }
      setLibraryHint(`Read ${file.name}. Click Save to keep it for next time.`);
      return response.text;
    } catch (err) {
      const message = `Could not read ${file.name}: ${(err && err.message) || err}`;
      setLibraryHint(message);
      setStatus(message);
      return null;
    }
  })();

  const text = await pendingExtraction;
  pendingExtraction = null;
  return text;
}

/**
 * The resume text, extracting a selected-but-unread file if that is what it
 * takes.
 *
 * A file sitting in the file input with an empty textarea is a state the user
 * reasonably reads as "my resume is loaded" -- answering that with "nothing to
 * save" is just wrong, whatever caused the change event to be missed. So both
 * Save and Tailor recover from it instead of refusing.
 */
async function ensureResumeText() {
  if (pendingExtraction) await pendingExtraction;
  const text = els.resumeText.value.trim();
  if (text) return text;
  if (!els.resumeFile.files[0]) return '';
  await extractSelectedFile();
  return els.resumeText.value.trim();
}

async function onResumeFileChange() {
  if (!els.resumeFile.files[0]) return;
  await extractSelectedFile();
}

function openHtmlInTab(html) {
  chrome.tabs.create({ url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
}

els.previewBtn.addEventListener('click', () => lastResumeHtml && openHtmlInTab(lastResumeHtml));
els.previewClBtn.addEventListener('click', () => lastCoverLetterHtml && openHtmlInTab(lastCoverLetterHtml));

/** {providerId: key} for every provider the user supplied a fallback key for. */
/**
 * Pull the job posting off the active tab and fill the three job fields.
 *
 * `confidence` comes from the extractor's tier: 'high' means structured
 * JSON-LD data, 'low' means it fell back to stripped body text. A low or
 * partial result is surfaced as a request to review rather than silently
 * trusted, since the body-text fallback always returns *something*.
 */
async function onReadPageClick() {
  els.readPageBtn.disabled = true;
  els.extractHint.textContent = 'Reading this page...';
  try {
    const response = await chrome.runtime.sendMessage({ target: 'sw', type: 'job:extract' });
    if (!response || !response.ok) {
      els.extractHint.textContent = (response && response.error) || 'Could not read this page.';
      return;
    }
    const { text, employer, jobTitle, source, confidence } = response.job;
    if (text) els.jobDescription.value = text;
    if (employer) els.employer.value = employer;
    if (jobTitle) els.jobTitle.value = jobTitle;

    const note = confidence === 'high'
      ? `Read from ${source}. Looks complete.`
      : `Read from ${source} (${confidence} confidence) — please check the fields below before tailoring.`;
    els.extractHint.textContent = note;
  } catch (err) {
    els.extractHint.textContent = `Could not read this page: ${(err && err.message) || err}`;
  } finally {
    els.readPageBtn.disabled = false;
  }
}

/** {providerId: key} for every provider the user supplied a fallback key for. */
function collectProviderKeys() {
  return {
    gemini: els.fallbackGemini.value.trim(),
    groq: els.fallbackGroq.value.trim(),
    cerebras: els.fallbackCerebras.value.trim(),
    openrouter: els.fallbackOpenrouter.value.trim(),
  };
}

function applyProviderKeys(keys) {
  if (!keys) return;
  els.fallbackGemini.value = keys.gemini || '';
  els.fallbackGroq.value = keys.groq || '';
  els.fallbackCerebras.value = keys.cerebras || '';
  els.fallbackOpenrouter.value = keys.openrouter || '';
}

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

/**
 * Everything the popup remembers between openings, except the resume library
 * (which has its own store).
 */
function collectSettings() {
  return {
    provider: els.provider.value,
    model: els.modelName.value.trim(),
    apiKey: els.apiKey.value.trim(),
    includeCoverLetter: els.includeCoverLetter.checked,
    useJudge: els.useJudge.checked,
    preferences: collectPreferences(),
    providerKeys: collectProviderKeys(),
  };
}

/**
 * Persist as the user types, not only on run.
 *
 * Settings used to be written inside onTailorClick, which meant typing an API
 * key and then closing the popup without tailoring silently discarded it --
 * and a popup closes every time it loses focus, so that is the normal case,
 * not an edge one.
 *
 * Both `input` and `change` are listened for, deliberately. On a text field
 * `change` fires only on BLUR, so a user who types their key and then clicks
 * away from the popup entirely never fires it and loses the key -- the exact
 * bug this is meant to fix. `input` fires per keystroke, hence the debounce;
 * `change` still matters for <select> and checkboxes.
 */
const PERSIST_ON_CHANGE = [
  'provider', 'modelName', 'apiKey', 'includeCoverLetter', 'useJudge',
  'resumeDensity', 'keywordAlignment', 'coverLetterLength', 'coverLetterTone',
  'preservePoints', 'resumeNotes', 'coverLetterNotes',
  'fallbackGemini', 'fallbackGroq', 'fallbackCerebras', 'fallbackOpenrouter',
];

async function persistSettings() {
  await setSettings(collectSettings());
}

const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistSettings(); }, PERSIST_DEBOUNCE_MS);
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
  if (typeof settings.useJudge === 'boolean') els.useJudge.checked = settings.useJudge;
  applyPreferences(settings.preferences);
  applyProviderKeys(settings.providerKeys);
}

function setStatus(text) {
  els.status.textContent = text;
}

/** Surface validation findings honestly instead of only reporting success. */
function renderFindings({ resumeStatus, resumeWarnings, resumeErrors, resumeJudge, coverLetter, skills }) {
  const blocks = [];
  // The judge is advisory: its findings are shown so the user can decide,
  // never used to withhold the document.
  if (resumeJudge && !resumeJudge.passed && resumeJudge.issues && resumeJudge.issues.length) {
    blocks.push(`<strong>Accuracy review flagged:</strong><ul>${resumeJudge.issues.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  }
  if (resumeJudge && resumeJudge.judgeError) {
    blocks.push(`<strong>Accuracy review skipped:</strong><ul><li>${resumeJudge.judgeError}</li></ul>`);
  }
  if (skills && skills.reverted && skills.reverted.length) {
    blocks.push(`<strong>Skills:</strong><ul><li>${skills.reverted.length} line(s) reverted — the rewrite dropped too much of your original list.</li></ul>`);
  }
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
  // The textarea is the single source of truth for the resume. An uploaded
  // file is extracted into it the moment it is selected (onResumeFileChange),
  // so there is no second, competing input here and no "which one wins"
  // question at run time -- but that extraction may still be running.
  const resumeText = await ensureResumeText();
  const jobDescription = els.jobDescription.value.trim();
  const providerId = els.provider.value;
  const modelName = els.modelName.value.trim();
  const apiKey = els.apiKey.value.trim();
  const includeCoverLetter = els.includeCoverLetter.checked;
  const useJudge = els.useJudge.checked;
  const preferences = collectPreferences();
  const providerKeys = collectProviderKeys();

  if (!resumeText) {
    if (!els.status.textContent) setStatus('Paste your resume, upload a file, or pick a saved one first.');
    return;
  }
  if (!jobDescription) { setStatus('Paste the job description first.'); return; }
  if (!apiKey) { setStatus('Enter an API key first (AI provider section).'); return; }

  await persistSettings();

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
        resumeText, jobDescription,
        jobTitle: els.jobTitle.value.trim(), employer: els.employer.value.trim(),
        includeCoverLetter, useJudge, preferences,
        providerId, apiKey, modelName, providerKeys, baseUrlOverride,
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

els.readPageBtn.addEventListener('click', onReadPageClick);
els.tailorBtn.addEventListener('click', onTailorClick);
els.savedResumes.addEventListener('change', onSelectResume);
els.saveResumeBtn.addEventListener('click', onSaveResume);
els.deleteResumeBtn.addEventListener('click', onDeleteResume);
els.resumeFile.addEventListener('change', onResumeFileChange);
// Clearing the value on click guarantees `change` fires even when the user
// picks the same file twice in a row -- otherwise the value is unchanged, no
// event is dispatched, and the second pick appears to do nothing at all.
els.resumeFile.addEventListener('click', () => { els.resumeFile.value = ''; });
for (const id of PERSIST_ON_CHANGE) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('input', schedulePersist);
  el.addEventListener('change', schedulePersist);
}

restoreSettings();
// Reopening the popup reloads whichever resume was used last, so the common
// case -- one resume, many applications -- needs no interaction at all.
refreshLibrary({ loadText: true });
