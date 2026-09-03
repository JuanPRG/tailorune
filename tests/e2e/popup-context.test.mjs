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
import { openResumeManage } from './helpers.mjs';

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

  await openResumeManage(popup);
  assert.equal(await popup.inputValue('#resumeName'), 'juan-rivera-tabstops');
});

test('real popup: saving actually writes to storage — the flow that silently did nothing before', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await openResumeManage(popup);
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
  await openResumeManage(popup);
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
  await openResumeManage(popup);
  assert.ok((await popup.inputValue('#resumeText')).includes('Juan Rivera'));
});

test('real popup: settings persist as you type, without needing a tailor run', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.locator('#providerDetails').evaluate((el) => { el.open = true; });
  await popup.fill('#apiKey', 'popup-context-key');

  const settings = await waitForStorage(sw, 'tailorune_settings_v1', (v) => Boolean(v && v.apiKey));
  assert.equal(settings.apiKey, 'popup-context-key');
});

test('real popup: the resume card stays compact, and says what is loaded', async (t) => {
  // The contract of the compact resume card, which is easy to regress by
  // accident because every piece of it still exists in the DOM.
  //
  //   EMPTY  -- the disclosure is OPEN. Folding the textarea away is the
  //             point of the layout, but in an empty card it is also the only
  //             way to paste a resume; closing it there would hide the
  //             primary input behind a control labelled "Text & library".
  //   LOADED -- the disclosure is CLOSED and a pill states the name and word
  //             count. That pill is the whole argument for the redesign: the
  //             textarea's real job was reassurance, and it cost 110px to do
  //             it badly, showing three lines from wherever the document
  //             happened to be scrolled.
  const { popup } = await openRealPopup(t);
  const cardHeight = () => popup.$eval(
    'main.scroll > section.card:first-of-type',
    (el) => Math.round(el.getBoundingClientRect().height),
  );

  assert.equal(await popup.$eval('#resumeManage', (el) => el.open), true,
    'an empty resume card must leave the paste box reachable');
  assert.equal(await popup.isVisible('#resumeMeta'), false, 'nothing is loaded, so nothing to summarise');

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  assert.equal(await popup.$eval('#resumeManage', (el) => el.open), false,
    'loading a resume must fold the text away -- that is the request this implements');
  assert.match(
    await popup.textContent('#resumeMeta'), /juan-rivera-tabstops · \d+ words/,
    'the pill must name the loaded resume and count its words',
  );

  // A number, so "compact" is a claim the suite can check rather than a
  // matter of opinion. The card was 317px with the textarea exposed.
  const height = await cardHeight();
  assert.ok(height < 170, `the loaded resume card should stay compact, measured ${height}px`);
});
