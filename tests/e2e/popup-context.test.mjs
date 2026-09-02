// popup-context.test.mjs — the flows that only prove anything when run in the
// REAL browser-action popup.
//
// See realPopup.mjs for why this exists: a tab and a popup are different
// rendering contexts, and the difference has already hidden one shipped bug
// (window.prompt) that a full green suite could not see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openRealPopup, readStorage, waitForStorage } from './realPopup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCX_FIXTURE = path.resolve(__dirname, '../fixtures/resumes/juan-rivera-tabstops.docx');

const RESUMES_KEY = 'tailorune_resumes_v1';

test('real popup: uploading a .docx extracts it, all the way through the service worker and offscreen document', async (t) => {
  const { popup } = await openRealPopup(t);

  const dialogs = [];
  popup.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(
    () => document.getElementById('resumeText').value.includes('Juan Rivera'),
    { timeout: 20000 },
  );

  const hint = await popup.textContent('#libraryHint');
  assert.match(hint, /Click Save to keep it/);
  assert.deepEqual(dialogs, [], 'the real popup must never open a JS dialog');
});

test('real popup: the name field takes the uploaded file name, replacing whatever was there', async (t) => {
  const { popup } = await openRealPopup(t);

  // Something already typed in the name field must not survive a new upload:
  // the file the user just picked is what they are naming, and a stale label
  // would silently mislabel what gets saved.
  await popup.fill('#resumeName', '123');
  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  assert.equal(await popup.inputValue('#resumeName'), 'juan-rivera-tabstops');
});

test('real popup: saving actually writes to storage — the flow that silently did nothing before', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await popup.fill('#resumeName', 'Finance CV');
  await popup.click('#saveResumeBtn');
  await popup.waitForFunction(
    () => document.getElementById('libraryHint').textContent.includes('Saved as'),
    { timeout: 5000 },
  );

  // The assertion that matters is in STORAGE, not the DOM. A hint can be
  // written by a handler that never persisted anything.
  const stored = await readStorage(sw, RESUMES_KEY);
  assert.ok(stored, 'nothing was written to chrome.storage.local');
  assert.equal(stored.resumes.length, 1);
  assert.equal(stored.resumes[0].name, 'Finance CV');
  assert.ok(stored.resumes[0].text.includes('Juan Rivera'));
  assert.equal(stored.lastUsedId, stored.resumes[0].id);
});

test('real popup: a selected file with an empty textarea is recovered by Save, not refused', async (t) => {
  // The reported failure state: a file sits in the input, the textarea is
  // empty, and Save answers "nothing to save". Whatever caused the change
  // event to be missed, refusing is the wrong response -- the file is right
  // there. Simulated here by blanking the textarea after extraction, which
  // reproduces the state without needing to reproduce its cause.
  const { popup, sw } = await openRealPopup(t);

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await popup.evaluate(() => { document.getElementById('resumeText').value = ''; });
  await popup.fill('#resumeName', 'Recovered CV');

  await popup.click('#saveResumeBtn');
  await popup.waitForFunction(
    () => document.getElementById('libraryHint').textContent.includes('Saved as'),
    { timeout: 20000 },
  );

  const stored = await readStorage(sw, RESUMES_KEY);
  assert.equal(stored.resumes.length, 1, 'Save should have re-read the selected file');
  assert.equal(stored.resumes[0].name, 'Recovered CV');
  assert.ok(stored.resumes[0].text.includes('Juan Rivera'));
  // And the textarea is repopulated, so the user can see what was saved.
  assert.ok((await popup.inputValue('#resumeText')).includes('Juan Rivera'));
});

test('real popup: settings persist as you type, without needing a tailor run', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.locator('#providerDetails').evaluate((el) => { el.open = true; });
  await popup.fill('#apiKey', 'popup-context-key');

  const settings = await waitForStorage(sw, 'tailorune_settings_v1', (v) => Boolean(v && v.apiKey));
  assert.equal(settings.apiKey, 'popup-context-key');
});

// --- the HirePilot -> Tailorune migration -----------------------------------

test('real popup: a user carried in by auto-update sees what changed, once', async (t) => {
  // This listing replaces HirePilot's, so existing users arrive without
  // choosing to. Three things changed under them: their key did not come
  // across (HirePilot gave it to the local backend, which wrote it to a file
  // an extension cannot read), the backend is now dead weight, and autofill is
  // gone. Discovering that by trial is a bad first impression of a product
  // they already trusted.
  const { popup, sw } = await openRealPopup(t);

  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      tailorune_migration_notice_v1: { fromVersion: '2.2.5', seen: false },
    });
  });
  await popup.reload();

  await popup.waitForFunction(
    () => document.getElementById('migrationNotice')?.style.display === 'block',
    { timeout: 5000 },
  );
  const text = await popup.textContent('#migrationNotice');
  assert.match(text, /Paste your API key/i, 'the actionable step must be stated');
  assert.match(text, /backend is no longer needed/i);
  assert.match(text, /Autofill is not part of this version/i, 'a removed feature must be named');

  // The key field is what they have to act on, so it should not be buried.
  assert.equal(await popup.evaluate(() => document.getElementById('providerDetails').open), true);

  // Dismissed for good: a banner that returns reads as a bug.
  await popup.click('#dismissMigration');
  await popup.waitForFunction(
    () => document.getElementById('migrationNotice')?.style.display === 'none',
  );
  await popup.reload();
  await popup.waitForFunction(() => Boolean(document.getElementById('migrationNotice')));
  assert.equal(
    await popup.evaluate(() => document.getElementById('migrationNotice').style.display),
    'none',
    'the notice must stay dismissed across reopens',
  );
});

test('real popup: a fresh install never sees the migration notice', async (t) => {
  // Someone installing Tailorune for the first time has no HirePilot to be
  // told about.
  const { popup } = await openRealPopup(t);
  await popup.waitForFunction(() => Boolean(document.getElementById('migrationNotice')));
  assert.equal(
    await popup.evaluate(() => document.getElementById('migrationNotice').style.display),
    'none',
  );
});
