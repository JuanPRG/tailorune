// resumeLibrary.test.mjs — the saved-resume store, exercised against an
// in-memory storage adapter rather than chrome.storage.local, so it runs in
// plain Node like the rest of the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, MAX_RESUMES, MAX_TEXT_CHARS,
  loadLibrary, saveResume, deleteResume, markUsed, suggestName,
} from '../../extension/engine/resumeLibrary.js';

function fakeStorage(initial) {
  const map = new Map();
  if (initial !== undefined) map.set(STORAGE_KEY, initial);
  return {
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, value); },
  };
}

// Deterministic ids and clock, so assertions never depend on randomness or
// wall-clock time.
function seq() {
  let n = 0;
  return () => `id-${++n}`;
}
const opts = () => ({ nowFn: () => 1000, idFn: seq() });

test('an empty store yields an empty library rather than throwing', async () => {
  assert.deepEqual(await loadLibrary(fakeStorage()), { resumes: [], lastUsedId: null });
});

test('a corrupt stored value degrades to an empty library instead of bricking the popup', async () => {
  // A half-written or hand-edited blob must not make the extension unusable,
  // since there is no UI to clear it from.
  assert.deepEqual(await loadLibrary(fakeStorage('not an object')), { resumes: [], lastUsedId: null });
  assert.deepEqual(await loadLibrary(fakeStorage({ resumes: 'nope' })), { resumes: [], lastUsedId: null });
});

test('entries missing required fields are dropped, keeping the well-formed ones', async () => {
  const storage = fakeStorage({
    resumes: [
      { id: 'a', name: 'Good', text: 'real text' },
      { id: 'b', name: 'No text field' },
      null,
    ],
    lastUsedId: 'a',
  });
  const library = await loadLibrary(storage);
  assert.deepEqual(library.resumes.map((r) => r.id), ['a']);
  assert.equal(library.lastUsedId, 'a');
});

test('a lastUsedId pointing at a deleted resume is not returned as a live selection', async () => {
  const storage = fakeStorage({ resumes: [{ id: 'a', name: 'A', text: 't' }], lastUsedId: 'gone' });
  assert.equal((await loadLibrary(storage)).lastUsedId, null);
});

test('saving stores the resume and marks it as last used', async () => {
  const storage = fakeStorage();
  const saved = await saveResume(storage, { name: 'Finance CV', text: 'Juan Rivera\nfinance' }, opts());
  const library = await loadLibrary(storage);
  assert.equal(library.resumes.length, 1);
  assert.equal(library.resumes[0].name, 'Finance CV');
  assert.equal(library.lastUsedId, saved.id);
  assert.equal(saved.createdAt, 1000);
});

test('re-saving under an existing name UPDATES that resume instead of adding a duplicate label', async () => {
  // Saving "Finance CV" twice always means "I updated my finance CV". It never
  // means "give me two entries I can no longer tell apart in a dropdown."
  const storage = fakeStorage();
  const options = opts();
  const first = await saveResume(storage, { name: 'Finance CV', text: 'original' }, options);
  const second = await saveResume(storage, { name: 'finance cv', text: 'updated' }, options);

  const library = await loadLibrary(storage);
  assert.equal(library.resumes.length, 1, 'a duplicate entry was created');
  assert.equal(second.id, first.id, 'the update should keep the same id');
  assert.equal(library.resumes[0].text, 'updated');
  assert.equal(library.resumes[0].name, 'finance cv', 'the new capitalization should win');
});

test('saving by explicit id renames rather than creating a new entry', async () => {
  const storage = fakeStorage();
  const options = opts();
  const first = await saveResume(storage, { name: 'Old name', text: 'body' }, options);
  await saveResume(storage, { id: first.id, name: 'New name', text: 'body' }, options);

  const library = await loadLibrary(storage);
  assert.equal(library.resumes.length, 1);
  assert.equal(library.resumes[0].name, 'New name');
});

test('an unnamed save falls back to a name derived from the resume itself', async () => {
  const storage = fakeStorage();
  const saved = await saveResume(storage, { name: '   ', text: 'Juan Rivera\nToronto, ON' }, opts());
  assert.equal(saved.name, 'Juan Rivera');
});

test('suggestName handles leading blank lines and over-long first lines', () => {
  assert.equal(suggestName('\n\n  Ada Lovelace  \nrest'), 'Ada Lovelace');
  assert.equal(suggestName(''), 'Untitled resume');
  assert.equal(suggestName('x'.repeat(200)).length, 60);
});

test('an empty resume is refused rather than stored as a blank dropdown entry', async () => {
  const storage = fakeStorage();
  await assert.rejects(() => saveResume(storage, { name: 'Blank', text: '   ' }, opts()), /empty/i);
  assert.deepEqual((await loadLibrary(storage)).resumes, []);
});

test('an oversized resume is refused with the actual size, not a silent truncation', async () => {
  const storage = fakeStorage();
  await assert.rejects(
    () => saveResume(storage, { name: 'Huge', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, opts()),
    /too large/i,
  );
});

test('the library is capped, and the cap message says what to do about it', async () => {
  const storage = fakeStorage();
  const options = opts();
  for (let i = 0; i < MAX_RESUMES; i++) {
    await saveResume(storage, { name: `Resume ${i}`, text: `body ${i}` }, options);
  }
  await assert.rejects(
    () => saveResume(storage, { name: 'One too many', text: 'body' }, options),
    /Delete one first/,
  );
  // Updating an existing one must still work at the cap: it adds no entry.
  await assert.doesNotReject(() => saveResume(storage, { name: 'Resume 0', text: 'edited' }, options));
});

test('deleting removes the resume and clears the selection when it was the one selected', async () => {
  const storage = fakeStorage();
  const options = opts();
  const a = await saveResume(storage, { name: 'A', text: 'a' }, options);
  const b = await saveResume(storage, { name: 'B', text: 'b' }, options);

  await deleteResume(storage, b.id);
  let library = await loadLibrary(storage);
  assert.deepEqual(library.resumes.map((r) => r.name), ['A']);
  assert.equal(library.lastUsedId, null, 'deleting the selected resume should clear the selection');

  await markUsed(storage, a.id);
  await deleteResume(storage, 'not-a-real-id');
  library = await loadLibrary(storage);
  assert.equal(library.resumes.length, 1, 'deleting an unknown id should be a no-op');
  assert.equal(library.lastUsedId, a.id, 'an unrelated delete must not clear the selection');
});

test('markUsed records the selection so reopening the popup reloads it', async () => {
  const storage = fakeStorage();
  const options = opts();
  const a = await saveResume(storage, { name: 'A', text: 'a' }, options);
  await saveResume(storage, { name: 'B', text: 'b' }, options); // B becomes last-used
  await markUsed(storage, a.id);
  assert.equal((await loadLibrary(storage)).lastUsedId, a.id);
});

test('markUsed ignores an id that is not in the library', async () => {
  const storage = fakeStorage();
  const options = opts();
  const a = await saveResume(storage, { name: 'A', text: 'a' }, options);
  await markUsed(storage, 'ghost');
  assert.equal((await loadLibrary(storage)).lastUsedId, a.id);
});
