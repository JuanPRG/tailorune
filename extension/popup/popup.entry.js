// popup/popup.entry.js — the whole UI: upload a resume plus a job
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
  chromeStorageAdapter, loadLibrary, saveResume, deleteResume, markUsed,
} from '../engine/resumeLibrary.js';
import { extractDocxText } from '../engine/extractDocxText.js';
import { extractPdfText } from '../engine/extractPdfText.js';
// The same resolver the offscreen document uses to build the run's chain, so
// the header pill and the actual run cannot report different things.
import { resolveProviderChain, chainLabels } from '../engine/providers.js';
import { mergeExtractedJob, cleanJobTitle } from '../engine/jobFields.js';
import { isStampedForThisPage } from '../engine/pageIdentity.js';
import { nextTheme } from '../engine/theme.js';
import {
  HISTORY_KEY, findPriorTailoring, describePriorTailoring,
} from '../engine/jobHistory.js';

const $ = (id) => document.getElementById(id);
const els = {
  resumeText: $('resumeText'),
  resumeFile: $('resumeFile'),
  savedResumes: $('savedResumes'),
  deleteResumeBtn: $('deleteResumeBtn'),
  libraryHint: $('libraryHint'),
  jobDescription: $('jobDescription'),
  readPageBtn: $('readPageBtn'),
  pinBtn: $('pinBtn'),
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
  keyGemini: $('keyGemini'),
  keyGroq: $('keyGroq'),
  keyOpenrouter: $('keyOpenrouter'),
  mainView: $('mainView'),
  appFooter: $('appFooter'),
  settingsView: $('settingsView'),
  settingsBtn: $('settingsBtn'),
  settingsBackBtn: $('settingsBackBtn'),
  tailorBtn: $('tailorBtn'),
  status: $('status'),
  warnings: $('warnings'),
  result: $('result'),
  keyStatus: $('keyStatus'),
  pinAdvanced: $('pinAdvanced'),
  pinHint: $('pinHint'),
  priorTailorNotice: $('priorTailorNotice'),
  clearHistoryBtn: $('clearHistoryBtn'),
  themeToggle: $('themeToggle'),
  resetBtn: $('resetBtn'),
  footerResetBtn: $('footerResetBtn'),
  tailorBtnLabel: $('tailorBtnLabel'),
  resumeEmpty: $('resumeEmpty'),
  resumeMeta: $('resumeMeta'),
  uploadBtn: $('uploadBtn'),
};

const storage = chromeStorageAdapter();

// In-flight file extraction, if any. Clicking "Tailor resume" while a file is
// still being read must WAIT for it, not fail with "paste your resume first"
// -- a large .pdf takes noticeably longer than a .docx (pdf.js has a worker to
// spin up), which is exactly long enough for a user to click through it.
// Disabling the button instead would trade one dead end for another.
let pendingExtraction = null;

/**
 * The name of the resume currently loaded, and the name it will be SAVED
 * under. Held here rather than in an input, because there is no longer an
 * input: a resume arrives as a file, and it keeps that file's name.
 *
 * WITH THE EXTENSION, deliberately. "The same name as the original file" is
 * the literal reading, and it is also the safe one -- saveResume() upserts by
 * name, so stripping the suffix would collapse `resume.pdf` and `resume.docx`
 * into one library entry and silently overwrite whichever was saved first.
 * A user who keeps both formats of the same CV is not unusual.
 */
let loadedResumeName = '';

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
  if (match) loadedResumeName = match.name;
  if (match && loadText) { els.resumeText.value = match.text; refreshResumeSummary(); }
  return library;
}

async function onSelectResume() {
  // Changing the selection cancels an armed delete: the armed id would no
  // longer match, but the trash button must stop looking armed.
  disarmDelete();
  const id = els.savedResumes.value;
  if (!id) return;
  const library = await loadLibrary(storage);
  const match = library.resumes.find((r) => r.id === id);
  if (!match) return;
  els.resumeText.value = match.text;
  loadedResumeName = match.name;
  // Clear any staged upload FIRST: the holder is the source of truth now, and
  // leaving a file selected would both override the resume just chosen and
  // make refreshLibraryControls() read a file that is about to be discarded.
  els.resumeFile.value = '';
  refreshResumeSummary();
  refreshLibraryControls();
  await markUsed(storage, id);
  setLibraryHint(`Loaded "${match.name}".`);
}

/**
 * File the just-read resume in the library, under the name of its file.
 *
 * NO LONGER A BUTTON. Save had nothing left to decide once the name became
 * the filename -- there was no field to fill and no choice to make, and the
 * hint under it told the user to press it. So uploading does both, and the
 * library means "the resumes you have uploaded".
 *
 * TAKES ITS TEXT AS AN ARGUMENT, and that is load-bearing rather than tidy.
 * The old version began with `await ensureResumeText()`, which awaits
 * `pendingExtraction`. This is now called FROM INSIDE that promise, so
 * re-deriving the text that way would make the extraction await itself and
 * hang the popup with no error. It must never call ensureResumeText().
 *
 * BEST-EFFORT, DELIBERATELY. saveResume() throws at MAX_RESUMES, and the one
 * thing that must not happen is a full library making a resume unusable: the
 * text is already in the holder and already tailorable, so a refusal is
 * reported and nothing is undone. The alternative -- evicting the
 * least-recently-used entry to make room -- destroys somebody's saved resume
 * to avoid printing a sentence.
 *
 * @returns {Promise<string>} the hint to show: what happened, in one line.
 */
async function saveLoadedResume({ text, name }) {
  try {
    // NO ID, AND NO LOOKUP HERE. saveResume() upserts by name when it is given
    // no id, which is exactly the behaviour wanted: re-uploading an edited file
    // updates that entry instead of adding a second one the user cannot tell
    // apart. Finding the existing entry here first would restate that rule in
    // a second place, and the two could then disagree about what counts as the
    // same name.
    const saved = await saveResume(storage, { name, text });
    await refreshLibrary({ selectId: saved.id });
    // saveResume() may settle on a different name than we passed (it falls
    // back to the resume's own first line when the name is empty), so the pill
    // takes the SAVED name, not the requested one.
    loadedResumeName = saved.name;
    return `Saved "${saved.name}" to your library.`;
  } catch (err) {
    // Both facts, in one line. "Not saved" alone would read as "not read", and
    // the user would upload again to fix a problem uploading cannot fix.
    return `Read ${name}, but did not save it: ${(err && err.message) || err}`;
  }
}

/**
 * Delete needs a confirmation step, and window.confirm() is unavailable for
 * the same reason prompt() is unavailable: opening a JS dialog dismisses a
 * browser-action popup, so the answer never arrives. It is two-step: the
 * first click arms, a second click within a few seconds commits. Arming is
 * scoped to the id that was selected, so changing the dropdown between clicks
 * cannot delete something the user never armed.
 */
const DELETE_ARM_MS = 4000;
let armedDeleteId = null;
let armedDeleteTimer = null;

const DELETE_LABEL = 'Delete the selected resume';

/**
 * Armed state is an ATTRIBUTE now, not a label swap.
 *
 * This used to set textContent to 'Confirm', which is unavailable to an icon
 * button -- writing text into it would replace the SVG. So the state lives in
 * `data-armed`, the stylesheet turns the button red on it, and the aria-label
 * changes so the arming is not a purely visual signal.
 */
function disarmDelete() {
  armedDeleteId = null;
  if (armedDeleteTimer) { clearTimeout(armedDeleteTimer); armedDeleteTimer = null; }
  delete els.deleteResumeBtn.dataset.armed;
  els.deleteResumeBtn.setAttribute('aria-label', DELETE_LABEL);
  els.deleteResumeBtn.title = DELETE_LABEL;
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
    els.deleteResumeBtn.dataset.armed = 'true';
    const confirmLabel = `Confirm deleting "${match.name}"`;
    els.deleteResumeBtn.setAttribute('aria-label', confirmLabel);
    els.deleteResumeBtn.title = confirmLabel;
    setLibraryHint(`Press the trash again to delete "${match.name}". This cannot be undone.`);
    armedDeleteTimer = setTimeout(() => {
      disarmDelete();
      setLibraryHint('');
    }, DELETE_ARM_MS);
    return;
  }

  disarmDelete();
  await deleteResume(storage, id);
  await refreshLibrary({ selectId: '' });
  loadedResumeName = '';
  refreshResumeSummary();   // .value assignments fire no input event
  refreshLibraryControls(); // nothing is selected now, so the trash goes dead
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
 * Extract the currently selected file into the resume holder. Returns its
 * text, or null.
 */
/**
 * Which extraction is the one the user is waiting for.
 *
 * A PDF is slow enough to click through -- pdf.js has to start a worker --
 * and picking a second file did not cancel the first. Both kept running and
 * whichever PARSED LAST wrote the textarea, so choosing a fast .txt over a
 * slow .pdf put the abandoned PDF back a moment later, under the new file's
 * name, with a hint saying it had just been read. The user would then tailor
 * against a resume they had replaced. The straggler also called setStatus('')
 * unconditionally, which could blank a live "Tailoring..." message.
 */
let extractionSeq = 0;

async function extractSelectedFile() {
  const file = els.resumeFile.files[0];
  if (!file) return null;
  const seq = ++extractionSeq;
  const current = () => seq === extractionSeq;
  setLibraryHint(`Reading ${file.name}...`);

  pendingExtraction = (async () => {
    try {
      const text = await fileToText(file);
      // Superseded while we were parsing: the user has picked another file.
      // Return it to our own caller, but touch nothing on screen.
      if (!current()) return text;
      if (!text || !text.trim()) {
        throw new Error('that file contained no readable text.');
      }
      els.resumeText.value = text;
      els.savedResumes.value = '';
      // UNCONDITIONAL. There used to be a `renameFromFile` flag guarding
      // this, so an implicit extraction would not clobber a name the user had
      // typed. There is no name to type now -- the file's name IS the name --
      // so the flag guarded nothing and is gone.
      loadedResumeName = file.name;
      refreshResumeSummary();

      // AND FILE IT, in the same press. Only the winning extraction gets
      // here -- a superseded one returned above -- so picking a second file
      // while the first is still parsing cannot save the abandoned one.
      // saveLoadedResume() may reset loadedResumeName, so the pill is
      // repainted after it rather than before.
      const hint = await saveLoadedResume({ text, name: file.name });
      refreshResumeSummary();
      refreshLibraryControls();
      setLibraryHint(hint);
      setStatus('');
      return text;
    } catch (err) {
      // Surfaced in BOTH places on purpose. The hint sits under the control
      // that failed, but it is also the line every other library action
      // overwrites -- so a failure could scroll past unnoticed and read as
      // "it just does nothing", which is exactly how this was reported.
      // #status is the durable copy.
      if (!current()) return null;   // an abandoned file's failure is not news
      const message = `Could not read ${file.name}: ${(err && err.message) || err}`;
      setLibraryHint(message);
      setStatus(message, 'file-error');
      return null;
    }
  })();

  const mine = pendingExtraction;
  const text = await mine;
  // Only clear the slot if it is still ours; a later pick owns it now.
  if (pendingExtraction === mine) pendingExtraction = null;
  return text;
}

/**
 * The resume text, extracting a selected-but-unread file if that is what it
 * takes.
 *
 * A file sitting in the file input with an empty holder is a state the user
 * reasonably reads as "my resume is loaded" -- answering that with "upload a
 * resume first" is just wrong, whatever caused the change event to be missed.
 * So Tailor recovers from it instead of refusing.
 *
 * TAILOR IS NOW THE ONLY CALLER that can recover it. Save used to be the
 * other one, and folding Save into Upload removed that second chance -- which
 * is survivable precisely because Tailor calls this BEFORE it checks anything
 * else, so the re-read happens whatever else is missing. Re-reading also
 * files the resume, since extractSelectedFile() saves on success.
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

/** {providerId: key} for every provider the user supplied a fallback key for. */
/**
 * Pull the job posting off the active tab and fill the three job fields.
 *
 * `confidence` comes from the extractor's tier: 'high' means structured
 * JSON-LD data, 'low' means it fell back to stripped body text. A low or
 * partial result is surfaced as a request to review rather than silently
 * trusted, since the body-text fallback always returns *something*.
 */
/**
 * Put an extracted job into the form, and say what was read.
 *
 * The merge rule -- who wins between the page and whatever is already in the
 * fields -- lives in engine/jobFields.js, where it can be tested. See that
 * file for why it had to move out of here.
 */
function applyExtractedJob(job, { overwrite }) {
  const merged = mergeExtractedJob({
    jobDescription: els.jobDescription.value,
    jobTitle: els.jobTitle.value,
    employer: els.employer.value,
  }, job, { overwrite });

  els.jobDescription.value = merged.jobDescription;
  els.jobTitle.value = merged.jobTitle;
  els.employer.value = merged.employer;
  // The pin is DERIVED from the description, and assigning `.value` fires no
  // `input` event -- so the listener that keeps it honest while someone types
  // hears nothing when the extension fills the field itself. Boot survived
  // that by rendering the pin after restoreOrDetect settles; Reset did not,
  // and it is the one path that disables the button first: it emptied the
  // form, greyed the pin out, re-read the page, and left a full form with a
  // dead button still offering to wait for a job.
  //
  // Here rather than at the two call sites because this is the only place the
  // job fields are written from a read -- one rule, where the write is.
  renderJobDerived();
  return merged.note;
}

async function onReadPageClick() {
  els.readPageBtn.disabled = true;
  els.extractHint.textContent = 'Reading this page...';
  try {
    const response = await chrome.runtime.sendMessage({ target: 'sw', type: 'job:extract' });
    if (!response || !response.ok) {
      els.extractHint.textContent = (response && response.error) || 'Could not read this page.';
      return;
    }
    els.extractHint.textContent = applyExtractedJob(response.job, { overwrite: true });
    saveJobDraft();
  } catch (err) {
    els.extractHint.textContent = `Could not read this page: ${(err && err.message) || err}`;
  } finally {
    els.readPageBtn.disabled = false;
  }
}

/**
 * Read the job from the active tab as soon as the popup opens, so the common
 * case -- standing on a posting, wanting it tailored -- needs no click.
 *
 * Matches v4's rule (popup/script.js: "Auto-extract JD if textarea is empty
 * and no active tailoring is happening"), and its silence: a page that is
 * not a job posting stays perfectly usable with pasted details, so a failure
 * here says nothing at all. The user did not ask, so a red error about a
 * page they were only browsing would be noise.
 *
 * ONLY FILLS WHAT IS EMPTY, and only when the description is empty to begin
 * with -- this must never overwrite something typed or pasted. The button
 * remains the way to force a re-read.
 *
 * It works at all because opening the popup from the toolbar is what grants
 * activeTab for that tab; see job-extraction.test.mjs, where the same call
 * from a popup loaded as an ordinary tab is correctly refused.
 */
async function autoDetectJob() {
  if (els.jobDescription.value.trim()) return null;
  els.extractHint.textContent = 'Reading this page...';
  try {
    const response = await chrome.runtime.sendMessage({ target: 'sw', type: 'job:extract' });
    if (!response || !response.ok || !response.job || !response.job.text) {
      els.extractHint.textContent = '';
      return null;
    }
    els.extractHint.textContent = applyExtractedJob(response.job, { overwrite: false });
    return response.job;
  } catch {
    els.extractHint.textContent = '';
    return null;
  }
}

/** {providerId: key} for every provider the user has supplied a key for. */
function collectProviderKeys() {
  return {
    gemini: els.keyGemini.value.trim(),
    groq: els.keyGroq.value.trim(),
    openrouter: els.keyOpenrouter.value.trim(),
  };
}

function applyProviderKeys(keys) {
  if (!keys) return;
  els.keyGemini.value = keys.gemini || '';
  els.keyGroq.value = keys.groq || '';
  els.keyOpenrouter.value = keys.openrouter || '';
}

/** Element id of the box holding a given provider's key. */
const KEY_FIELD = { gemini: 'keyGemini', groq: 'keyGroq', openrouter: 'keyOpenrouter' };

/**
 * The key belonging to whichever provider the pin selector names.
 *
 * NOT "the one tried first", which is what this said and what the dropdown
 * was believed to control. resolveProviderChain does put it first in the
 * array, but buildChainEntries reads that array only as a providerId -> key
 * lookup and takes the ORDER from TASK_CHAINS, deliberately. So with no model
 * pinned this choice reaches the run in exactly one way: it decides which
 * entry carries the `model` field -- and with no model there is none.
 *
 * It still matters for a pin, because that entry is the only one a pinned
 * run uses.
 */
function primaryApiKey() {
  return collectProviderKeys()[els.provider.value] || '';
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
    apiKey: primaryApiKey(),
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
  'provider', 'modelName', 'includeCoverLetter', 'useJudge', 'autoDownloadPdf',
  'resumeDensity', 'keywordAlignment', 'coverLetterLength', 'coverLetterTone',
  'preservePoints', 'resumeNotes', 'coverLetterNotes',
  'keyGemini', 'keyGroq', 'keyOpenrouter',
];

/**
 * The header pill.
 *
 * There is no backend to be connected to, so the question worth answering is
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
 * MUST BE CALLED AFTER loadedResumeName is set, never before. Three call
 * sites had it the other way round. That cost nothing while this function
 * only toggled a mascot, and would have quietly dropped the name from the
 * pill.
 */
/**
 * Grey out the trash when there is nothing selected to throw away.
 *
 * An icon carries no words, so a live-looking button that answers a press
 * with a one-line hint reads as broken; being visibly unavailable is the
 * version of "not yet" that an icon can actually deliver.
 *
 * This governed Save too until Save was folded into Upload. Upload itself is
 * never disabled -- it is the only way a resume gets in, and there is no
 * state in which offering it is wrong.
 */
function refreshLibraryControls() {
  if (els.deleteResumeBtn) els.deleteResumeBtn.disabled = !els.savedResumes.value;
}

function refreshResumeSummary() {
  if (!els.resumeEmpty) return;
  const text = els.resumeText.value.trim();
  els.resumeEmpty.hidden = Boolean(text);

  if (!els.resumeMeta) return;
  els.resumeMeta.hidden = !text;
  if (!text) return;
  const words = text.split(/\s+/).filter(Boolean).length;
  const name = loadedResumeName.trim();
  els.resumeMeta.textContent = name ? `${name} · ${words} words` : `${words} words`;
  els.resumeMeta.title = els.resumeMeta.textContent;
}

/**
 * Swap between the tailoring view and settings.
 *
 * Two siblings and one [hidden] each, rather than a modal: at 600px tall an
 * overlay would have had less room than the view beneath it. The footer goes
 * with them -- leaving "Tailor resume" under a settings page invites running
 * a job from a screen that is not about jobs.
 */
function showSettings(show) {
  if (!els.settingsView || !els.mainView) return;
  els.settingsView.hidden = !show;
  els.mainView.hidden = show;
  if (els.appFooter) els.appFooter.hidden = show;
  if (els.settingsBtn) els.settingsBtn.setAttribute('aria-expanded', String(Boolean(show)));
  // Return focus to something meaningful in the view just opened, so the
  // gear is not still focused while its panel is what changed.
  const target = show ? els.settingsBackBtn : els.settingsBtn;
  if (target) target.focus({ preventScroll: true });
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
    apiKey: primaryApiKey(),
    model: els.modelName.value,
    providerKeys: collectProviderKeys(),
  });
  const names = chainLabels(chain);

  if (!names.length) {
    els.keyStatus.dataset.state = 'missing';
    els.keyStatus.textContent = 'No key';
    els.keyStatus.title = 'Add an API key in Settings to tailor anything — click here, or the gear above.';
    return;
  }

  els.keyStatus.dataset.state = 'ready';
  // Naming the provider beats a bare count: it is the difference between "1
  // key" (which invites "no I have three") and "Gemini" (which invites "ah,
  // the others are not set").
  els.keyStatus.textContent = names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
  // NO ORDER IS PROMISED HERE. This used to read "in order: A -> B", naming
  // the order of the chain array -- which buildChainEntries deliberately
  // discards in favour of the curated per-task chain. The set is the true
  // part, so the set is what it says.
  els.keyStatus.title = names.length === 1
    ? `Only ${names[0]} is set up. Add another provider's key in Settings so a run can survive a rate limit.`
    : `A run can rotate across ${names.length} providers: ${names.join(', ')}. `
      + 'Which one each step tries first is chosen per task.';
}

/** The display name of one provider, without importing the whole table. */
const providerLabel = (id) => chainLabels([{ providerId: id }])[0] || id;

/**
 * State the pin's ACTUAL effect, recomputed from the live fields.
 *
 * Three outcomes, and the third is why this element exists: a model pinned on
 * a provider whose key box is empty produces no chain entry, so nothing
 * carries the pin and the curated rotation quietly stays on. That was
 * unobservable -- the field looked set and behaved as though it were not.
 */
function renderPinHint() {
  if (!els.pinHint) return;
  const model = els.modelName.value.trim();
  const providerId = els.provider.value;
  const label = providerLabel(providerId);

  if (!model) {
    els.pinHint.textContent = 'Rotation on. Provider is only used to say whose '
      + 'catalogue a pinned model comes from, so it has no effect while this is empty.';
    els.pinHint.dataset.state = 'off';
    return;
  }
  if (!collectProviderKeys()[providerId]) {
    els.pinHint.textContent = `No ${label} key is set, so this pin does nothing `
      + `and rotation stays on. Add a ${label} key above, or clear the model.`;
    els.pinHint.dataset.state = 'broken';
    return;
  }
  els.pinHint.textContent = `Rotation off. Every call goes to ${model} on ${label}, `
    + 'with no fallback if it rate-limits or refuses.';
  els.pinHint.dataset.state = 'on';
}

async function persistSettings() {
  await setSettings({ ...collectSettings(), theme: currentTheme() });
}

const PERSIST_DEBOUNCE_MS = 250;
let persistTimer = null;
function schedulePersist() {
  refreshKeyStatus();
  renderPinHint();
  refreshResumeSummary();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistSettings(); }, PERSIST_DEBOUNCE_MS);
}

async function restoreSettings() {
  const settings = await getSettings();
  // A first run does NOT jump into settings. The old layout expanded the
  // provider <details> in place, which was unobtrusive; doing the equivalent
  // now would mean replacing the whole first screen with a settings page,
  // and greeting someone with configuration is a worse trade than one click.
  // The amber "No key" pill is the way in instead, and it is a button.
  if (!settings) return;
  if (settings.provider) els.provider.value = settings.provider;
  if (settings.model) els.modelName.value = settings.model;
  // A PIN MUST NOT BE INVISIBLE. It suppresses the whole rotation, so folding
  // it away while it is set would hide the reason a run only ever reaches one
  // model. Collapsed is the right default only for the empty case.
  if (settings.model && els.pinAdvanced) els.pinAdvanced.open = true;
  // MIGRATION. Until 2.3.0 the key lived in one unlabelled box, saved as
  // `apiKey`, and the per-provider boxes were optional extras. Anyone who has
  // already entered a key has it in `apiKey` and nothing in the box that now
  // replaces it -- so without this, their key silently vanishes on update.
  // 2.3.0 is published, so those users exist.
  if (settings.apiKey) {
    const forProvider = settings.provider || 'gemini';
    const el = els[KEY_FIELD[forProvider]];
    const alreadyHasOne = Boolean((settings.providerKeys || {})[forProvider]);
    if (el && !el.value.trim() && !alreadyHasOne) el.value = settings.apiKey;
  }
  if (typeof settings.includeCoverLetter === 'boolean') els.includeCoverLetter.checked = settings.includeCoverLetter;
  if (typeof settings.useJudge === 'boolean') els.useJudge.checked = settings.useJudge;
  if (typeof settings.autoDownloadPdf === 'boolean') els.autoDownloadPdf.checked = settings.autoDownloadPdf;
  applyPreferences(settings.preferences);
  applyProviderKeys(settings.providerKeys);
  applyTheme(settings.theme || 'system');
  refreshKeyStatus();
  renderPinHint();
}

/**
 * The one status line, and what it is currently saying.
 *
 * The kind matters because ONE message must not be overwritten: a file that
 * failed to extract. Everything else -- "Locked.", "Cleared.", "Previous run
 * -- ..." -- is fair game, and treating them all as precious is what made the
 * Tailor button do nothing at all. See onTailorClick.
 */
let statusKind = '';
function setStatus(text, kind = '') {
  els.status.textContent = text;
  statusKind = text ? kind : '';
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
/**
 * Findings go through innerHTML, and some of them are written by a language
 * model -- the second-opinion review's issues are its own prose. Unescaped, a
 * model that emitted a tag would have it parsed as markup inside the popup.
 * Nothing has, but "nothing has yet" is not a security property.
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Show what the run wants the user to know, one collapsible group per source.
 *
 * These can run long -- a vocabulary note lists every word it wants kept --
 * and they live in the footer, above the CTA, so a five-line finding pushes
 * the work off screen every time the popup opens. Collapsed, a group is one
 * line that still says what it is and how many notes it holds.
 *
 * OPEN AFTER A RUN, CLOSED WHEN RESTORING ONE. A finding you have not seen
 * should be readable without a click; the same finding on the fourth reopen
 * should not cost the same space as the resume card.
 */
function renderFindings({ resumeStatus, resumeWarnings, resumeErrors, resumeJudge, coverLetter, skills },
  { collapsed = false } = {}) {
  const groups = [];

  // The judge is advisory: its findings are shown so the user can decide,
  // never used to withhold the document.
  if (resumeJudge && !resumeJudge.passed && resumeJudge.issues && resumeJudge.issues.length) {
    groups.push({
      label: 'Second-opinion AI review — advisory, nothing was changed',
      items: resumeJudge.issues,
    });
  }
  if (resumeJudge && resumeJudge.judgeError) {
    groups.push({ label: 'Second-opinion AI review skipped', items: [resumeJudge.judgeError] });
  }
  if (skills && skills.reverted && skills.reverted.length) {
    groups.push({
      label: 'Skills',
      items: [`${skills.reverted.length} line(s) reverted — the rewrite dropped or invented a skill.`],
    });
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
    //
    // LABELLED "automatic" because these are the checks that always run, and
    // saying so is the other half of the fix that renamed the AI reviewer.
    // A bare "Resume" heading over "claims a professional identity absent
    // from the source resume" is indistinguishable from an AI accuracy
    // verdict, which is how an unticked box came to look like it had been
    // ignored. These cost no AI call and cannot be switched off.
    const approved = !resumeStatus || resumeStatus.startsWith('approved');
    groups.push({
      label: approved
        ? 'Resume checks — automatic, no AI call'
        : `Resume (${resumeStatus})`,
      items: resumeIssues,
    });
  }
  if (coverLetter) {
    const clIssues = [...(coverLetter.errors || []), ...(coverLetter.warnings || [])];
    if (coverLetter.status !== 'approved' && clIssues.length) {
      groups.push({ label: `Cover letter (${coverLetter.status})`, items: clIssues });
    }
  }

  els.warnings.innerHTML = groups.map((group) => {
    const count = group.items.length;
    return `<details class="finding"${collapsed ? '' : ' open'}>`
      + `<summary>${escapeHtml(group.label)}`
      + `<span class="finding-count">${count} note${count === 1 ? '' : 's'}</span></summary>`
      + `<ul>${group.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      + '</details>';
  }).join('');
}

async function onTailorClick() {
  // One holder is the single source of truth for the resume. An uploaded file
  // is extracted into it the moment it is selected (onResumeFileChange), so
  // there is no second, competing input here and no "which one wins" question
  // at run time -- but that extraction may still be running.
  const resumeText = await ensureResumeText();
  const jobDescription = els.jobDescription.value.trim();
  const providerId = els.provider.value;
  const modelName = els.modelName.value.trim();
  const apiKey = primaryApiKey();
  const includeCoverLetter = els.includeCoverLetter.checked;
  const useJudge = els.useJudge.checked;
  const autoDownloadPdf = els.autoDownloadPdf.checked;
  const preferences = collectPreferences();
  const providerKeys = collectProviderKeys();

  if (!resumeText) {
    // Suppressed ONLY against a file that failed to read, which is the more
    // specific thing to say and the reason this check existed. It used to
    // skip whenever #status held anything at all -- so pressing Tailor after
    // locking a job, after Reset, or with a previous run restored produced no
    // message, no run, and no visible change whatsoever.
    if (statusKind !== 'file-error') {
      setStatus('Upload a resume, or pick a saved one, first.');
    }
    return;
  }
  if (!jobDescription) { setStatus('Paste the job description first.'); return; }
  // --- A: ASK THE SAME QUESTION THE RUN ASKS -------------------------------
  // This checked the primary key field alone, while the header pill checked
  // resolveProviderChain -- which is satisfied by a FALLBACK key on its own.
  // Put a key in only the Groq box and the pill turned green and said "Groq",
  // the run would have worked, and this refused it with "Enter an API key
  // first" while the user looked straight at the key they had entered.
  if (!resolveProviderChain({
    providerId, apiKey, model: modelName, providerKeys,
  }).length) {
    setStatus('Enter an API key first — the gear icon, top right.');
    return;
  }

  await persistSettings();

  setBusy(true);
  // The restored previous run must not linger next to a running one.
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
/** The page the popup is open over, or '' if it cannot be read. */
async function currentPageUrl() {
  try {
    const response = await chrome.runtime.sendMessage({ target: 'sw', type: 'tab:url' });
    return (response && response.ok && response.url) || '';
  } catch {
    return '';
  }
}

const JOB_DRAFT_KEY = 'tailorune_job_draft_v1';

/**
 * Whether this job is pinned, and to which page.
 *
 * Everything else in the popup follows the tab in front of it: the job is
 * read on open, and one belonging to a different posting is put away. That is
 * right by default and wrong in two ordinary cases -- comparing two postings
 * in adjacent tabs, and drafting against a description pasted out of an email
 * while the tab shows something else entirely.
 *
 * A pin turns the AUTOMATIC behaviour off for one job. It never overrides an
 * explicit action: Read this page still re-reads, Reset still clears.
 *
 * The page is remembered alongside the flag so a finished run can still be
 * matched to the pinned job, and so unpinning lands somewhere sensible.
 */
let jobPinned = false;
let jobPinnedPageUrl = '';

const JOB_FIELDS = ['jobDescription', 'jobTitle', 'employer'];

async function readJobDraft() {
  try {
    const bag = await chrome.storage.local.get(JOB_DRAFT_KEY);
    return (bag && bag[JOB_DRAFT_KEY]) || null;
  } catch {
    return null;
  }
}

function applyJobDraft(draft) {
  jobPinned = Boolean(draft.pinned);
  jobPinnedPageUrl = jobPinned ? (draft.pageUrl || '') : '';
  for (const id of JOB_FIELDS) {
    if (draft[id]) els[id].value = draft[id];
  }
  // A draft saved before the title check existed can still be carrying a
  // greeting; restoring is a way INTO the field like any other.
  els.jobTitle.value = cleanJobTitle(els.jobTitle.value);
  if (draft.extractHint) els.extractHint.textContent = draft.extractHint;
}

async function saveJobDraft() {
  // While pinned the draft keeps the page it was pinned ON. Re-stamping it to
  // whatever tab is in front would make the pin travel with the user, which
  // is the exact opposite of fixing a job in place.
  const draft = {
    at: Date.now(),
    pageUrl: jobPinned ? jobPinnedPageUrl : await currentPageUrl(),
    pinned: jobPinned,
  };
  for (const id of JOB_FIELDS) draft[id] = els[id].value;
  draft.extractHint = els.extractHint.textContent || '';
  // Nothing typed and nothing read: no draft worth keeping, and storing an
  // empty one would only give a later open something useless to restore.
  const empty = JOB_FIELDS.every((id) => !draft[id].trim());
  try {
    if (empty) await chrome.storage.local.remove(JOB_DRAFT_KEY);
    else await chrome.storage.local.set({ [JOB_DRAFT_KEY]: draft });
  } catch { /* storage unavailable */ }
}

const JOB_DRAFT_DEBOUNCE_MS = 400;
let jobDraftTimer = null;
function scheduleJobDraftSave() {
  if (jobDraftTimer) clearTimeout(jobDraftTimer);
  jobDraftTimer = setTimeout(() => { jobDraftTimer = null; saveJobDraft(); }, JOB_DRAFT_DEBOUNCE_MS);
}

async function readLastRun() {
  try {
    const bag = await chrome.storage.local.get(LAST_RUN_KEY);
    return (bag && bag[LAST_RUN_KEY]) || null;
  } catch {
    return null; // nothing stored, or storage unavailable
  }
}

/** Put a finished run back on screen: previews, findings, and the job itself. */
function applyLastRun(last) {
  // The job this run was for, into whatever is still empty. Only empty
  // fields, so a draft for this page -- the user's own later edits, applied
  // before this -- wins over the snapshot taken when the run happened.
  for (const id of JOB_FIELDS) {
    if (last[id] && !els[id].value.trim()) els[id].value = last[id];
  }
  els.jobTitle.value = cleanJobTitle(els.jobTitle.value);

  renderFindings({
    resumeStatus: last.resumeStatus,
    resumeWarnings: last.resumeWarnings,
    resumeErrors: last.resumeErrors,
    resumeJudge: last.resumeJudge,
    skills: last.skills,
    coverLetter: last.coverLetterStatus ? { status: last.coverLetterStatus } : null,
  }, { collapsed: true });

  setHasRun(true);
  const forJob = [last.jobTitle, last.employer].filter(Boolean).join(' at ');
  const files = (last.downloads || []).length;
  setStatus(
    `Previous run${forJob ? ` — ${forJob}` : ''}: ${last.wordCount} words, `
    + `${files} file${files === 1 ? '' : 's'} in Downloads. ${describeAge(last.at)}`,
  );
}

/**
 * Decide what the popup shows on open. Exactly one of three things.
 *
 *   SAME POSTING as the stored run -> put the run back. Reading the page
 *   again would fill the job description underneath its own finished output.
 *
 *   A DIFFERENT POSTING -> a fresh start, with this page's job read in. This
 *   is the reported bug: a finished run used to follow the user to the next
 *   job, offering "Re-tailor" for a posting they had left, showing its
 *   findings and its save-as-PDF buttons, and never updating the job
 *   description until Reset was pressed.
 *
 *   NOT A POSTING AT ALL -> put the run back after all. Switching to a mail
 *   tab and reopening the popup should not cost the user their findings, and
 *   an empty form is no use on a page with no job on it. This is the case a
 *   plain URL comparison gets wrong: it treats "somewhere else" and "another
 *   job" as the same thing, and only one of them means the run is stale.
 *
 * The stored run is never deleted here, so returning to its posting brings it
 * back -- and the files were in Downloads the whole time regardless.
 */
async function restoreOrDetect() {
  const [draft, last] = await Promise.all([readJobDraft(), readLastRun()]);

  // A PINNED job short-circuits every page check below. That is the whole
  // feature: the popup stops caring which tab is in front.
  if (draft && draft.pinned) {
    // The page the job was pinned ON, not the tab in front -- that is the
    // whole point of the pin, and it is also the right identity to match a
    // previous run against.
    herePageUrl = draft.pageUrl || '';
    applyJobDraft(draft);
    if (last && isStampedForThisPage(last, draft.pageUrl)) applyLastRun(last);
    renderJobDerived();
    return;
  }

  const here = await currentPageUrl();
  herePageUrl = here;
  const draftIsHere = Boolean(draft) && isStampedForThisPage(draft, here);
  const runIsHere = Boolean(last) && isStampedForThisPage(last, here);

  // The user's own words first, and before anything reads the page: a draft
  // fills the description, which is precisely what stops the automatic read
  // below from replacing it.
  if (draftIsHere) applyJobDraft(draft);
  if (runIsHere) {
    applyLastRun(last);
    // A run stored before runs carried their job description has nothing to
    // put back, so fall through to the page rather than leaving the user
    // offered a re-tailor with nothing to tailor.
    if (!els.jobDescription.value.trim()) await autoDetectJob();
    return;
  }

  // A draft for this page means the user was already working here, so there
  // is nothing to detect and no reason to reach for another job's run.
  if (draftIsHere) return;

  const job = await autoDetectJob();
  if (job) { saveJobDraft(); return; }

  // This page has no job on it, so nothing here supersedes what the user
  // already had. Their own words first, then the last run.
  //
  // This is what keeps a description pasted out of an email from being lost
  // by wandering: pasted on one mail message, reopened on another, the stamps
  // do not match -- but neither page is a posting, so there is nothing to
  // prefer over the paste. A real posting DOES supersede it, above, because
  // moving to a new job is the case this whole change exists to fix.
  if (draft) applyJobDraft(draft);
  if (last) applyLastRun(last);
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

/**
 * Every job tailored for before, read once when the popup opens.
 *
 * Cached rather than re-read per render: it only ever changes when a run
 * finishes, and a browser-action popup is destroyed on focus loss anyway, so
 * "once per open" is already "every time it could have changed".
 */
let tailoringHistory = [];

/** The page this popup is open over, as far as it was able to find out. */
let herePageUrl = '';

async function loadTailoringHistory() {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    tailoringHistory = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  } catch {
    tailoringHistory = [];   // nothing stored, or storage unavailable
  }
}

/**
 * Say so when this job has been tailored for before.
 *
 * SILENT while a finished run is on screen. That case is already covered --
 * the status line reads "Previous run -- Backend Engineer at Acme" or "Done
 * -- 393 words" -- and the job it covers is the job that would match here, so
 * the notice would be a second voice saying the same thing. What it is for is
 * the case nothing else covers: tailor this posting, tailor five others so
 * the single last-run slot has moved on, then come back.
 */
function renderPriorNotice() {
  const el = els.priorTailorNotice;
  if (!el) return;

  const match = ctaHasRun ? null : findPriorTailoring(tailoringHistory, {
    pageUrl: herePageUrl,
    employer: els.employer.value,
    jobTitle: els.jobTitle.value,
  });

  el.hidden = !match;
  // textContent, not innerHTML: employer and title come off a web page.
  el.textContent = match ? describePriorTailoring(match, describeAge(match.at)) : '';
}

/** The pin and the prior-run notice are both derived from the job fields. */
function renderJobDerived() {
  renderPin();
  renderPriorNotice();
}

function renderPin() {
  if (!els.pinBtn) return;
  const hasJob = Boolean(els.jobDescription.value.trim());
  els.pinBtn.disabled = !hasJob && !jobPinned;
  els.pinBtn.setAttribute('aria-pressed', String(jobPinned));
  els.pinBtn.title = jobPinned
    ? 'Locked. This job stays put while you switch tabs — click to unlock.'
    : (hasJob
      ? 'Lock this job so switching tabs does not change it'
      : 'Nothing to lock yet — read or paste a job first');
}

async function onPinClick() {
  jobPinned = !jobPinned;
  jobPinnedPageUrl = jobPinned ? await currentPageUrl() : '';
  renderJobDerived();
  await saveJobDraft();
  setStatus(jobPinned
    ? 'Locked. This job stays put until you unlock it.'
    : 'Unlocked. The job will follow the tab again.');
}

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
  // The notice stays quiet while a run is on screen, so this flag is one of
  // its inputs -- and Reset flips it back with the job still in the form.
  renderPriorNotice();
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
  // Reset discards the job, so there is nothing left to hold in place.
  jobPinned = false;
  jobPinnedPageUrl = '';
  renderJobDerived();

  els.warnings.innerHTML = '';
  els.result.textContent = '';
  setHasRun(false);

  // The stored run is the point: without this the previous result would come
  // straight back on the next open, and nothing would have been forgotten.
  try {
    await chrome.storage.local.remove([LAST_RUN_KEY, JOB_DRAFT_KEY]);
  } catch { /* nothing stored, or storage unavailable */ }

  setStatus('Cleared. Resume and keys kept.');
  schedulePersist();

  // ...and read this page, because "start a new application" means ready to
  // work on the posting in front of you, not an empty form with a button to
  // press. The clearing above is what lets this fill anything: the automatic
  // read only ever touches empty fields.
  //
  //
  // NOTE, since this is now the only way reset can lose work: on a page with
  // no readable job -- a description assembled out of an email or a PDF --
  // clearing finds nothing to replace it with, and that text is gone. An undo
  // for exactly that case was built and then removed as clutter, the
  // judgement being that reset gets pressed when moving to a new posting,
  // where the re-read gives you what you wanted anyway.
  if (await autoDetectJob()) await saveJobDraft();
}

els.readPageBtn.addEventListener('click', onReadPageClick);
// Typing in any job field keeps the draft, so losing popup focus mid-paste
// costs nothing. Debounced: a long description is a lot of keystrokes.
for (const id of JOB_FIELDS) els[id].addEventListener('input', scheduleJobDraftSave);
// Every job field, not just the description: the pin follows the
// description, and the prior-run notice is matched on employer and title.
for (const id of JOB_FIELDS) els[id].addEventListener('input', renderJobDerived);
els.pinBtn.addEventListener('click', onPinClick);
if (els.clearHistoryBtn) {
  els.clearHistoryBtn.addEventListener('click', async () => {
    try {
      await chrome.storage.local.remove(HISTORY_KEY);
    } catch { /* nothing stored, or storage unavailable */ }
    tailoringHistory = [];
    renderPriorNotice();
    setStatus('Tailoring history cleared.');
  });
}
if (els.resetBtn) els.resetBtn.addEventListener('click', onResetClick);
if (els.footerResetBtn) els.footerResetBtn.addEventListener('click', onResetClick);
els.tailorBtn.addEventListener('click', onTailorClick);
els.savedResumes.addEventListener('change', onSelectResume);
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
    // The machine is asked EVERY press rather than read once at startup: a
    // popup can outlive an OS theme change, and a stale answer here is the
    // dead press all over again.
    const systemIsDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(nextTheme(currentTheme(), systemIsDark));
    schedulePersist();
  });
}

applyTheme('system');
refreshKeyStatus();
renderPinHint();
refreshResumeSummary();
refreshLibraryControls();
// KEPT even though the textarea is no longer user-editable: assigning
// .value in code fires no input event, but the e2e suite sets the resume
// by filling this holder directly -- which IS an input event, and is what
// keeps #resumeMeta honest in those tests.
els.resumeText.addEventListener('input', refreshResumeSummary);

// The file input is visually hidden, so this is the control the user actually
// presses; clicking it opens the same OS picker.
els.uploadBtn.addEventListener('click', () => els.resumeFile.click());
els.settingsBtn.addEventListener('click', () => showSettings(els.mainView.hidden === false));
els.settingsBackBtn.addEventListener('click', () => showSettings(false));
// The pill reports the key, and the key lives in settings, so it goes there.
els.keyStatus.addEventListener('click', () => showSettings(true));
loadTailoringHistory()
  .then(restoreOrDetect)
  .then(renderJobDerived);
restoreSettings();
// Reopening the popup reloads whichever resume was used last, so the common
// case -- one resume, many applications -- needs no interaction at all.
refreshLibrary({ loadText: true }).then(refreshLibraryControls);
