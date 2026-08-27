// resumeLibrary.js — named resumes persisted in chrome.storage.local.
//
// v4 kept a resume library server-side (multiple resumes, a default, archive,
// rename, revisions). This is the backend-free equivalent, and it is
// deliberately smaller: named resumes, one of them remembered as the last
// used, and nothing else. Archive and revisions are filing-cabinet features
// for a database; a dropdown with twenty entries does not need them.
//
// What gets stored is the EXTRACTED TEXT, not the original file bytes. That
// choice matters:
//   - text is what the pipeline consumes anyway (parseTxt), so nothing is
//     re-derived on each run and a saved resume can never drift from what the
//     tailorer actually sees;
//   - it is ~5KB rather than ~20KB, which keeps twenty resumes far inside
//     chrome.storage.local's 10MB quota;
//   - the library becomes format-agnostic: a .docx uploaded once is, from
//     then on, just a saved resume.
//
// The `storage` adapter is injected rather than reaching for
// chrome.storage.local directly, so all of this is unit-testable in plain
// Node — the same test-double idiom the LLM client uses for fetch and sleep.

export const STORAGE_KEY = 'tailorune_resumes_v1';

/** Twenty named resumes is far past the point of a usable dropdown. */
export const MAX_RESUMES = 20;

/** ~100KB of plain text is several times the longest real resume. */
export const MAX_TEXT_CHARS = 100000;

const EMPTY = { resumes: [], lastUsedId: null };

/** chrome.storage.local as a {get,set} adapter. Extension contexts only. */
export function chromeStorageAdapter() {
  return {
    async get(key) {
      const result = await chrome.storage.local.get(key);
      return result[key];
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
  };
}

/**
 * Read the library, tolerating anything the stored value might have decayed
 * into. A corrupt or half-written blob must not brick the popup, so anything
 * unrecognizable degrades to an empty library rather than throwing.
 */
export async function loadLibrary(storage) {
  const raw = await storage.get(STORAGE_KEY);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.resumes)) return { ...EMPTY };
  const resumes = raw.resumes.filter(
    (r) => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.text === 'string',
  );
  const lastUsedId = resumes.some((r) => r.id === raw.lastUsedId) ? raw.lastUsedId : null;
  return { resumes, lastUsedId };
}

/**
 * Derive a name from the resume itself when the user doesn't supply one.
 * The first non-empty line of a resume is, essentially always, the person's
 * name — which is a poor label when every resume shares it, so it is only a
 * fallback.
 */
export function suggestName(text) {
  const firstLine = String(text || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!firstLine) return 'Untitled resume';
  return firstLine.slice(0, 60);
}

/**
 * Insert or update a resume, keyed by NAME rather than id when no id is given.
 *
 * Saving "Finance CV" twice means "I updated my finance CV" every time; it
 * never means "give me two entries with identical labels that I now cannot
 * tell apart." Name-keyed upsert is what makes re-saving an edited resume
 * work without a separate rename/replace flow.
 */
export async function saveResume(storage, { id, name, text }, { nowFn = Date.now, idFn = defaultId } = {}) {
  const trimmedText = String(text || '').trim();
  if (!trimmedText) throw new Error('Cannot save an empty resume.');
  if (trimmedText.length > MAX_TEXT_CHARS) {
    throw new Error(`That resume is too large to save (${trimmedText.length} characters, limit ${MAX_TEXT_CHARS}).`);
  }

  const library = await loadLibrary(storage);
  const finalName = String(name || '').trim() || suggestName(trimmedText);
  const now = nowFn();

  const existing = id
    ? library.resumes.find((r) => r.id === id)
    : library.resumes.find((r) => r.name.toLowerCase() === finalName.toLowerCase());

  let saved;
  let resumes;
  if (existing) {
    saved = { ...existing, name: finalName, text: trimmedText, updatedAt: now };
    resumes = library.resumes.map((r) => (r.id === existing.id ? saved : r));
  } else {
    if (library.resumes.length >= MAX_RESUMES) {
      throw new Error(`You already have ${MAX_RESUMES} saved resumes. Delete one first.`);
    }
    saved = { id: idFn(), name: finalName, text: trimmedText, createdAt: now, updatedAt: now };
    resumes = [...library.resumes, saved];
  }

  await storage.set(STORAGE_KEY, { resumes, lastUsedId: saved.id });
  return saved;
}

export async function deleteResume(storage, id) {
  const library = await loadLibrary(storage);
  const resumes = library.resumes.filter((r) => r.id !== id);
  const lastUsedId = library.lastUsedId === id ? null : library.lastUsedId;
  await storage.set(STORAGE_KEY, { resumes, lastUsedId });
  return { resumes, lastUsedId };
}

/**
 * Remember which resume was last used, so reopening the popup reloads it.
 *
 * This is the whole point of the feature: the common case is one resume used
 * over and over, and that case should cost zero clicks.
 */
export async function markUsed(storage, id) {
  const library = await loadLibrary(storage);
  if (!library.resumes.some((r) => r.id === id)) return library;
  const next = { resumes: library.resumes, lastUsedId: id };
  await storage.set(STORAGE_KEY, next);
  return next;
}

function defaultId() {
  // crypto.randomUUID exists in both extension contexts and modern Node.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `r_${Math.random().toString(36).slice(2)}`;
}
