// popup/popup.entry.js — the whole UI: paste or upload a resume plus a job
// description, get a tailored .docx (and optionally a cover letter .docx)
// in Downloads, with an HTML preview of each for browser print-to-PDF.
//
// Bundled to popup.bundle.js by build/build-offscreen.mjs, because the popup
// reads uploaded files itself (JSZip for .docx, pdf.js for .pdf) rather than
// shipping the bytes to the offscreen document and waiting for an answer.
// That round trip -- popup -> service worker -> offscreen document and back --
// was two message hops and three lifetimes for what is a pure function over
// bytes, and it failed in a real popup in a way no test could reproduce.
// Reading a file locally has no lifetime to get wrong.

import { getSettings, setSettings } from '../engine/store.js';
import {
  chromeStorageAdapter, loadLibrary, saveResume, deleteResume, markUsed, suggestName,
} from '../engine/resumeLibrary.js';
import { extractDocxText } from '../engine/extractDocxText.js';
import { extractPdfText } from '../engine/extractPdfText.js';
// The same resolver the offscreen document uses to build the run's chain, so
// the header pill and the actual run cannot report different things.
import { resolveProviderChain, chainLabels } from '../engine/providers.js';
import { withAutoPrint } from '../engine/renderHtml.js';

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
  autoDownloadPdf: $('autoDownloadPdf'),
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
  fallbackOpenrouter: $('fallbackOpenrouter'),
  tailorBtn: $('tailorBtn'),
  previewBtn: $('previewBtn'),
  previewClBtn: $('previewClBtn'),
  status: $('status'),
  warnings: $('warnings'),
  result: $('result'),
  keyStatus: $('keyStatus'),
  themeToggle: $('themeToggle'),
  resetBtn: $('resetBtn'),
  footerResetBtn: $('footerResetBtn'),
  tailorBtnLabel: $('tailorBtnLabel'),
  resumeEmpty: $('resumeEmpty'),
  resumeMeta: $('resumeMeta'),
  uploadBtn: $('uploadBtn'),
  resumeManage: $('resumeManage'),
};

let lastResumeHtml = null;
let lastCoverLetterHtml = null;
let lastResumePdf = null;        // { base64, filename }
let lastCoverLetterPdf = null;

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
  // Reads as a PICKER, not as a status. The pill in the title row now says
  // what is loaded, and a placeholder reading "— not saved —" directly beside
  // "Juan Rivera · 163 words" invited the opposite conclusion.
  none.textContent = library.resumes.length ? 'Load a saved resume…' : 'No saved resumes';
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
  if (match && loadText) { els.resumeText.value = match.text; refreshResumeSummary(); }
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
  refreshResumeSummary();
  syncManageDisclosure();
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
/**
 * Read one uploaded file into plain text, here in the popup.
 *
 * .docx and .pdf both parse straight from bytes -- no service worker, no
 * offscreen document, no messages. See the module header for why that round
 * trip was removed rather than debugged.
 */
async function fileToText(file) {
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (ext === '.docx') return extractDocxText(bytes);
  if (ext === '.pdf') return extractPdfText(bytes);
  if (ext === '.txt') return new TextDecoder('utf-8').decode(bytes);
  throw new Error(`Unsupported file type "${ext}". Upload a .txt, .docx, or .pdf.`);
}

/**
 * Extract the currently selected file into the textarea. Returns its text, or null.
 *
 * `renameFromFile` is true only when the user actually picked a file: the
 * filename is then the label they expect, and it wins over anything left in
 * the name field. It is false when extraction is triggered implicitly, by
 * Save or Tailor recovering an unread file — there the name field holds
 * something the user typed deliberately, and overwriting it would save their
 * resume under a name they never chose.
 */
async function extractSelectedFile({ renameFromFile = false } = {}) {
  const file = els.resumeFile.files[0];
  if (!file) return null;
  setLibraryHint(`Reading ${file.name}...`);

  pendingExtraction = (async () => {
    try {
      const text = await fileToText(file);
      if (!text || !text.trim()) {
        throw new Error('that file contained no readable text.');
      }
      els.resumeText.value = text;
      els.savedResumes.value = '';
      if (renameFromFile || !els.resumeName.value.trim()) {
        els.resumeName.value = file.name.replace(/\.[^.]+$/, '');
      }
      refreshResumeSummary();
      syncManageDisclosure();
      setLibraryHint(`Read ${file.name}. Click Save to keep it for next time.`);
      setStatus('');
      return text;
    } catch (err) {
      // Surfaced in BOTH places on purpose. The hint sits under the control
      // that failed, but it is also the line every other library action
      // overwrites -- so a failure could scroll past unnoticed and read as
      // "it just does nothing", which is exactly how this was reported.
      // #status is the durable copy.
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
  await extractSelectedFile({ renameFromFile: true });
}

function openHtmlInTab(html) {
  chrome.tabs.create({ url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
}

/**
 * Save a rendered PDF straight to Downloads.
 *
 * The bytes were produced during the run by renderPdf.js, so this is one
 * message and no dialog -- the DOCX has always behaved this way and the PDF
 * now matches it.
 *
 * If the run produced no PDF (the renderer threw on some unusual resume) the
 * old path is still there: the HTML preview opens in a tab with the print
 * dialog already up. Degrading to two clicks beats losing the artifact.
 */
async function savePdf(pdf, fallbackHtml, label) {
  if (!pdf || !pdf.base64) {
    if (fallbackHtml) openHtmlInTab(withAutoPrint(fallbackHtml));
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      target: 'sw', type: 'pdf:save', base64: pdf.base64, filename: pdf.filename,
    });
    if (!response || !response.ok) throw new Error((response && response.error) || 'Download failed');
    setStatus(`Saved ${pdf.filename} to your Downloads.`);
  } catch (err) {
    if (fallbackHtml) {
      openHtmlInTab(withAutoPrint(fallbackHtml));
      return;
    }
    setStatus(`Could not save the ${label} PDF: ${String((err && err.message) || err)}`);
  }
}

els.previewBtn.addEventListener('click', () => savePdf(lastResumePdf, lastResumeHtml, 'resume'));
els.previewClBtn.addEventListener('click', () => savePdf(lastCoverLetterPdf, lastCoverLetterHtml, 'cover letter'));

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
    // Assigned unconditionally. The extractor blanks a title it does not
    // trust (a signed-in greeting, a nav label), and leaving the previous
    // value in place would quietly keep a rejected title alive in the field
    // and let it reach the cover letter anyway.
    els.jobTitle.value = jobTitle || '';

    const titleNote = jobTitle ? '' : ' No usable job title found on the page — add one below if you want it on the cover letter.';
    const note = (confidence === 'high'
      ? `Read from ${source}. Looks complete.`
      : `Read from ${source} (${confidence} confidence) — please check the fields below before tailoring.`) + titleNote;
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
    openrouter: els.fallbackOpenrouter.value.trim(),
  };
}

function applyProviderKeys(keys) {
  if (!keys) return;
  els.fallbackGemini.value = keys.gemini || '';
  els.fallbackGroq.value = keys.groq || '';
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
    autoDownloadPdf: els.autoDownloadPdf.checked,
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
  'provider', 'modelName', 'apiKey', 'includeCoverLetter', 'useJudge', 'autoDownloadPdf',
  'resumeDensity', 'keywordAlignment', 'coverLetterLength', 'coverLetterTone',
  'preservePoints', 'resumeNotes', 'coverLetterNotes',
  'fallbackGemini', 'fallbackGroq', 'fallbackOpenrouter',
];

/**
 * The header pill, which replaced HirePilot's "Connected" backend indicator.
 *
 * There is no backend to be connected to, so the equivalent question is
 * whether this popup can actually make a call: is there a key, and how many
 * providers can it fall back across. Reported rather than assumed, because
 * "why did nothing happen" is otherwise answered only by opening a collapsed
 * <details> and squinting at a password field.
 */
/**
 * Theme: follow the OS, or an explicit choice the user has made.
 *
 * Three states, not two. No `data-theme` attribute means "follow the system",
 * which is what a fresh install should do -- the CSS handles that with
 * prefers-color-scheme. Setting the attribute pins it, and the pin has to win
 * in BOTH directions, so the stylesheet defines the canvas palette twice:
 * once under the media query guarded against an explicit dark, and once under
 * [data-theme="light"].
 */
const THEMES = ['system', 'dark', 'light'];

function applyTheme(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  if (!els.themeToggle) return;
  const label = { system: 'Following your system theme', dark: 'Dark', light: 'Canvas' }[theme] || 'Following your system theme';
  els.themeToggle.title = `${label} — click to change`;
}

/**
 * Show the mascot only while there is no resume, and say what IS loaded.
 *
 * Driven from the textarea rather than from the library, because a resume can
 * arrive four ways -- typed, pasted, uploaded, or loaded from the library --
 * and the textarea is the one place all four converge. That is also why the
 * textarea still exists now that it is folded away: it is the model, not
 * merely a control.
 *
 * The pill carries the reassurance the visible textarea used to provide, and
 * carries it better. A name and a word count say "the right document is
 * loaded"; three lines from wherever the document happened to be scrolled --
 * which is all the textarea actually showed -- say very little.
 *
 * MUST BE CALLED AFTER #resumeName is set, never before. Three call sites had
 * it the other way round. That cost nothing while this function only toggled
 * a mascot, and would have quietly dropped the name from the pill.
 */
/**
 * Open the text-and-library disclosure only while there is nothing loaded.
 *
 * Folding the textarea away is the point of this layout, but in an EMPTY
 * popup it is also the only way to paste a resume -- collapsing it there
 * would hide the primary input behind a control labelled "Text & library"
 * and leave Upload as the only visible way in. So: open when empty, closed
 * once a resume exists.
 *
 * Called when a resume ARRIVES FROM ELSEWHERE -- boot, an upload, a library
 * pick -- and deliberately not while the user is typing, since collapsing
 * the box someone is typing into would be absurd.
 */
function syncManageDisclosure() {
  if (!els.resumeManage) return;
  els.resumeManage.open = !els.resumeText.value.trim();
}

function refreshResumeSummary() {
  if (!els.resumeEmpty) return;
  const text = els.resumeText.value.trim();
  els.resumeEmpty.hidden = Boolean(text);

  if (!els.resumeMeta) return;
  els.resumeMeta.hidden = !text;
  if (!text) return;
  const words = text.split(/\s+/).filter(Boolean).length;
  const name = els.resumeName.value.trim();
  els.resumeMeta.textContent = name ? `${name} · ${words} words` : `${words} words`;
  els.resumeMeta.title = els.resumeMeta.textContent;
}

function currentTheme() {
  return document.documentElement.dataset.theme || 'system';
}

function refreshKeyStatus() {
  if (!els.keyStatus) return;

  // Counts PROVIDERS a run can actually reach, not text boxes with something
  // in them. Those are different numbers, and showing the wrong one produced
  // "why does it say one key when I have three": a fallback key for the
  // provider already selected above adds no reach, and a key for a provider
  // that no longer exists (Cerebras, in old saved settings) adds none either.
  // resolveProviderChain is the same function the run uses.
  const chain = resolveProviderChain({
    providerId: els.provider.value,
    apiKey: els.apiKey.value,
    model: els.modelName.value,
    providerKeys: collectProviderKeys(),
  });
  const names = chainLabels(chain);

  if (!names.length) {
    els.keyStatus.dataset.state = 'missing';
    els.keyStatus.textContent = 'No key';
    els.keyStatus.title = 'Add an API key under AI provider to tailor anything.';
    return;
  }

  els.keyStatus.dataset.state = 'ready';
  // Naming the provider beats a bare count: it is the difference between "1
  // key" (which invites "no I have three") and "Gemini" (which invites "ah,
  // the others are not set").
  els.keyStatus.textContent = names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  els.keyStatus.title = names.length === 1
    ? `Only ${names[0]} is set up. Add another provider's key below so a run can survive a rate limit.`
    : `A run can rotate across ${names.length} providers, in order: ${names.join(' -> ')}.`;
}

async function persistSettings() {
  await setSettings({ ...collectSettings(), theme: currentTheme() });
}

const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;
function schedulePersist() {
  refreshKeyStatus();
  refreshResumeSummary();
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
  if (typeof settings.autoDownloadPdf === 'boolean') els.autoDownloadPdf.checked = settings.autoDownloadPdf;
  applyPreferences(settings.preferences);
  applyProviderKeys(settings.providerKeys);
  applyTheme(settings.theme || 'system');
  refreshKeyStatus();
}

function setStatus(text) {
  els.status.textContent = text;
}

/**
 * A compact timing line, because "it felt slow" is not actionable.
 *
 * The run is up to nine SEQUENTIAL model calls -- resume (2 attempts, each
 * able to trigger a judge call), skills (2), cover letter (3) -- and none of
 * that is visible from the finished document. Showing where the seconds went,
 * and how many calls it took, is what turns "why was that slow" into a
 * question with an answer.
 */
function formatTimings({ timings, llm }) {
  if (!timings || !llm) return '';
  const order = ['resume', 'skills', 'coverLetter', 'render'];
  const parts = order
    .filter((key) => timings[key])
    .map((key) => {
      const { ms, calls } = timings[key];
      const label = key === 'coverLetter' ? 'letter' : key;
      return `${label} ${(ms / 1000).toFixed(1)}s${calls ? ` (${calls} call${calls === 1 ? '' : 's'})` : ''}`;
    });
  if (!parts.length) return '';
  return `
${(llm.ms / 1000).toFixed(0)}s in ${llm.calls} AI call${llm.calls === 1 ? '' : 's'} — ${parts.join(', ')}.`;
}

/** Surface validation findings honestly instead of only reporting success. */
function renderFindings({ resumeStatus, resumeWarnings, resumeErrors, resumeJudge, coverLetter, skills }) {
  const blocks = [];
  // The judge is advisory: its findings are shown so the user can decide,
  // never used to withhold the document.
  if (resumeJudge && !resumeJudge.passed && resumeJudge.issues && resumeJudge.issues.length) {
    blocks.push(
      '<strong>Accuracy review (advisory — nothing was changed):</strong>'
      + `<ul>${resumeJudge.issues.map((i) => `<li>${i}</li>`).join('')}</ul>`,
    );
  }
  if (resumeJudge && resumeJudge.judgeError) {
    blocks.push(`<strong>Accuracy review skipped:</strong><ul><li>${resumeJudge.judgeError}</li></ul>`);
  }
  if (skills && skills.reverted && skills.reverted.length) {
    blocks.push(`<strong>Skills:</strong><ul><li>${skills.reverted.length} line(s) reverted — the rewrite dropped too much of your original list.</li></ul>`);
  }
  // Shown even on an approved run. The repair pass reverts an overreaching
  // bullet to its original and lets the run succeed, so "approved" can still
  // mean "one of your bullets was silently rolled back" -- which the user
  // needs to know, since it is the one part of the document that did not get
  // tailored.
  const resumeIssues = [...(resumeErrors || []), ...(resumeWarnings || [])];
  if (resumeIssues.length) {
    // approved_with_judge_warning is an approved outcome -- the judge is
    // advisory -- so it must not be labelled as though something went wrong.
    const approved = !resumeStatus || resumeStatus.startsWith('approved');
    const label = approved ? 'Resume' : `Resume (${resumeStatus})`;
    blocks.push(`<strong>${label}:</strong><ul>${resumeIssues.map((i) => `<li>${i}</li>`).join('')}</ul>`);
  }
  if (coverLetter) {
    const clIssues = [...(coverLetter.errors || []), ...(coverLetter.warnings || [])];
    if (coverLetter.status !== 'approved' && clIssues.length) {
      blocks.push(`<strong>Cover letter (${coverLetter.status}):</strong><ul>${clIssues.map((i) => `<li>${i}</li>`).join('')}</ul>`);
    }
  }
  els.warnings.innerHTML = blocks.join('');
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
  const autoDownloadPdf = els.autoDownloadPdf.checked;
  const preferences = collectPreferences();
  const providerKeys = collectProviderKeys();

  if (!resumeText) {
    if (!els.status.textContent) setStatus('Paste your resume, upload a file, or pick a saved one first.');
    return;
  }
  if (!jobDescription) { setStatus('Paste the job description first.'); return; }
  if (!apiKey) { setStatus('Enter an API key first (AI provider section).'); return; }

  await persistSettings();

  setBusy(true);
  els.previewBtn.style.display = 'none';
  els.previewClBtn.style.display = 'none';
  // The restored previous run must not linger next to a running one.
  lastResumeHtml = null;
  lastCoverLetterHtml = null;
  lastResumePdf = null;
  lastCoverLetterPdf = null;
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
        includeCoverLetter, useJudge, autoDownloadPdf, preferences,
        providerId, apiKey, modelName, providerKeys, baseUrlOverride,
      },
    });
    els.result.textContent = JSON.stringify(response);

    if (response && response.ok) {
      const files = (response.downloads || []).length;
      setStatus(
        `Done — ${response.wordCount} words, ${files} file${files === 1 ? '' : 's'} in Downloads.`
        + formatTimings(response),
      );
      renderFindings(response);
      lastResumeHtml = response.htmlPreview || null;
      lastCoverLetterHtml = response.coverLetter ? response.coverLetter.htmlPreview : null;
      lastResumePdf = response.resumePdfBase64
        ? { base64: response.resumePdfBase64, filename: response.resumePdfFilename }
        : null;
      lastCoverLetterPdf = response.coverLetter && response.coverLetter.pdfBase64
        ? { base64: response.coverLetter.pdfBase64, filename: response.coverLetter.pdfFilename }
        : null;
      els.previewBtn.style.display = lastResumeHtml ? 'block' : 'none';
      els.previewClBtn.style.display = lastCoverLetterHtml ? 'block' : 'none';
      setHasRun(true);
    } else {
      setStatus(`Failed: ${(response && response.error) || 'unknown error'}`);
    }
  } catch (err) {
    setStatus(`Failed: ${err && err.message ? err.message : err}`);
    els.result.textContent = JSON.stringify({ ok: false, error: String(err) });
  } finally {
    setBusy(false);
  }
}

const LAST_RUN_KEY = 'tailorune_last_run_v1';

/**
 * Put the previous run back on screen when the popup reopens.
 *
 * A browser-action popup is destroyed on focus loss, so glancing at the
 * download shelf after a run was enough to lose the findings and both preview
 * buttons while the .docx files sat in Downloads -- files present, every
 * reason for how they look gone. The service worker now writes the finished
 * result before responding, so this reads it back.
 *
 * Presented as a PREVIOUS run, not as a fresh one. Restoring a "Done —"
 * status silently would make a stale result look like something that just
 * happened, which is a worse bug than the one being fixed.
 */
async function restoreLastRun() {
  let last = null;
  try {
    const bag = await chrome.storage.local.get(LAST_RUN_KEY);
    last = bag && bag[LAST_RUN_KEY];
  } catch { /* nothing stored, or storage unavailable */ }
  if (!last) return;

  lastResumeHtml = last.htmlPreview || null;
  lastCoverLetterHtml = last.coverLetterHtml || null;
  lastResumePdf = last.resumePdfBase64
    ? { base64: last.resumePdfBase64, filename: last.resumePdfFilename }
    : null;
  lastCoverLetterPdf = last.coverLetterPdfBase64
    ? { base64: last.coverLetterPdfBase64, filename: last.coverLetterPdfFilename }
    : null;
  els.previewBtn.style.display = lastResumeHtml ? 'block' : 'none';
  els.previewClBtn.style.display = lastCoverLetterHtml ? 'block' : 'none';
  renderFindings({
    resumeStatus: last.resumeStatus,
    resumeWarnings: last.resumeWarnings,
    resumeErrors: last.resumeErrors,
    resumeJudge: last.resumeJudge,
    skills: last.skills,
    coverLetter: last.coverLetterStatus ? { status: last.coverLetterStatus } : null,
  });

  setHasRun(true);
  const forJob = [last.jobTitle, last.employer].filter(Boolean).join(' at ');
  const files = (last.downloads || []).length;
  setStatus(
    `Previous run${forJob ? ` — ${forJob}` : ''}: ${last.wordCount} words, `
    + `${files} file${files === 1 ? '' : 's'} in Downloads. ${describeAge(last.at)}`,
  );
}

/** "2 minutes ago" beats a timestamp for deciding whether this is still yours. */
function describeAge(at) {
  if (!at) return '';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'Just now.';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago.`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago.`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago.`;
}

/**
 * Start a new application.
 *
 * SCOPE IS THE WHOLE DESIGN HERE. It clears what is cheap to get back -- the
 * job description (pasted, or one click from the page), and the last run
 * (whose documents are already in Downloads) -- and keeps what is expensive:
 * the resume, the API keys, the preferences. Clearing the resume would fight
 * the entire point of the library, which exists because the common case is
 * one resume across many applications.
 *
 * It also deletes the STORED run, so this doubles as the privacy control:
 * it is how a user removes generated resume content from the extension.
 *
 * Two-step, because a stray click on a long pasted job description is the one
 * expensive mistake available. Same four-second arm as the delete button, so
 * there is one confirmation idiom in this popup rather than two.
 */
/**
 * Whether a finished run is on screen, which is what the footer reflects.
 *
 * The CTA and the reset button are a PAIR once a run exists, and each answers
 * a different question: Re-tailor keeps this job and tries again -- a
 * different model, a different roll -- while Reset moves on to a different
 * job. Before the first run there is nothing to move on from, so the reset
 * stays hidden and the CTA keeps the whole width.
 */
/**
 * The CTA's label has ONE source of truth, and this is it.
 *
 * Three states, two writers, and they collided: setBusy captured the label on
 * entry and restored it on exit, while setHasRun set it to "Re-tailor" the
 * moment a run succeeded. The finally block then ran second and put the
 * pre-run text back, so a finished run showed "Tailor resume" -- caught by a
 * test asserting the paired state, not by looking at it, because the window
 * where it is wrong is the one you stop watching.
 *
 * Now nothing writes the label directly: both callers set a flag and this
 * renders from them.
 */
let ctaBusy = false;
let ctaHasRun = false;

function renderCta() {
  if (!els.tailorBtnLabel) return;
  els.tailorBtnLabel.textContent = ctaBusy ? 'Tailoring…'
    : (ctaHasRun ? 'Re-tailor' : 'Tailor resume');
  if (els.footerResetBtn) els.footerResetBtn.hidden = !ctaHasRun || ctaBusy;
}

/**
 * Put the CTA into, or out of, its running state.
 *
 * The button is disabled either way -- a second run while one is in flight
 * would race two pipelines against the same rate limits. What changes is the
 * LOOK: `data-busy` keeps it at full contrast and animates it, because a
 * dimmed grey button reads as "unavailable" when the truth is the opposite,
 * this being the one thing currently happening.
 */
function setBusy(busy) {
  ctaBusy = busy;
  els.tailorBtn.disabled = busy;
  if (busy) els.tailorBtn.dataset.busy = 'true';
  else delete els.tailorBtn.dataset.busy;
  renderCta();
}

function setHasRun(hasRun) {
  ctaHasRun = hasRun;
  renderCta();
}

/**
 * Start a new application.
 *
 * SCOPE IS THE WHOLE DESIGN HERE. It clears what is cheap to get back -- the
 * job description (pasted, or one click from the page), and the last run
 * (whose documents are already in Downloads) -- and keeps what is expensive:
 * the resume, the API keys, the preferences. Clearing the resume would fight
 * the entire point of the library, which exists because the common case is
 * one resume across many applications.
 *
 * It also deletes the STORED run, so this doubles as the privacy control:
 * it is how a user removes generated resume content from the extension.
 *
 * Single click, by request. It was two-step, on the reasoning that a stray
 * click could cost a long pasted job description -- that risk is real and is
 * simply accepted now. What softens it is that the destination is cheap: the
 * documents are already in Downloads, and the resume and keys never move.
 */
async function onResetClick() {
  els.jobDescription.value = '';
  els.jobTitle.value = '';
  els.employer.value = '';
  els.extractHint.textContent = '';

  lastResumeHtml = null;
  lastCoverLetterHtml = null;
  lastResumePdf = null;
  lastCoverLetterPdf = null;
  els.previewBtn.style.display = 'none';
  els.previewClBtn.style.display = 'none';
  els.warnings.innerHTML = '';
  els.result.textContent = '';
  setHasRun(false);

  // The stored run is the point: without this the previous result would come
  // straight back on the next open, and nothing would have been forgotten.
  try {
    await chrome.storage.local.remove(LAST_RUN_KEY);
  } catch { /* nothing stored, or storage unavailable */ }

  setStatus('Cleared. Your resume, keys and preferences are untouched.');
  schedulePersist();
}

els.readPageBtn.addEventListener('click', onReadPageClick);
if (els.resetBtn) els.resetBtn.addEventListener('click', onResetClick);
if (els.footerResetBtn) els.footerResetBtn.addEventListener('click', onResetClick);
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

if (els.themeToggle) {
  els.themeToggle.addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
    applyTheme(next);
    schedulePersist();
  });
}

applyTheme('system');
refreshKeyStatus();
refreshResumeSummary();
syncManageDisclosure();
els.resumeText.addEventListener('input', refreshResumeSummary);
els.resumeName.addEventListener('input', refreshResumeSummary);

// The file input is visually hidden, so this is the control the user actually
// presses; clicking it opens the same OS picker.
els.uploadBtn.addEventListener('click', () => els.resumeFile.click());
restoreLastRun();
restoreSettings();
// Reopening the popup reloads whichever resume was used last, so the common
// case -- one resume, many applications -- needs no interaction at all.
refreshLibrary({ loadText: true }).then(syncManageDisclosure);
