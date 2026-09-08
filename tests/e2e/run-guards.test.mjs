// run-guards.test.mjs — the checks that stand between a click and a run.
//
// Every one of these is a REGRESSION. They were found in a pre-release review
// pass, and each had the same shape: a guard that asked a slightly different
// question from the one the rest of the popup was asking, so the user was
// told "no" in a situation where the answer was plainly yes, or told nothing
// at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BROWSER } from './browser.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { getExtensionServiceWorker, openSettings, closeSettings } from './helpers.mjs';
import { startMockLlmServer } from './mockLlmServer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

const RESUME = 'Ada Lovelace\nToronto, ON\n\nEXPERIENCE\nAnalyst, Difference Engine Co.\n- Did the work.';
const JOB = 'We need a backend engineer with Python and AWS experience.';

async function launch(t) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-guards-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
    ],
  });
  t.after(async () => {
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });
  const sw = await getExtensionServiceWorker(context);
  return { context, sw, extensionId: sw.url().split('/')[2] };
}

const openPopup = async (context, extensionId, mockUrl) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`
    + `?llmBaseUrlOverride=${encodeURIComponent(mockUrl)}`);
  return page;
};

const status = (page) => page.textContent('#status');

// --- the key the popup could see but would not use -------------------------

test('a key in a fallback box alone is enough to start a run', async (t) => {
  // The header pill and the Tailor button disagreed. The pill is built from
  // resolveProviderChain, which a FALLBACK key satisfies on its own; the
  // button checked the primary field. So a key pasted into the Groq box lit
  // the pill green, named "Groq", and then refused the run with "Enter an API
  // key first" while the user looked straight at the key they had entered.
  // The run itself would have worked -- the offscreen pipeline is handed the
  // same providerKeys and resolves the same chain.
  const mockLlm = await startMockLlmServer(() => ({
    choices: [{ message: { content: JSON.stringify({ summary: 'Tailored.', entries: [] }) } }],
  }));
  t.after(async () => { await mockLlm.close(); });

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);

  await page.fill('#resumeText', RESUME);
  await page.fill('#jobDescription', JOB);

  // Primary deliberately empty; the key goes only in a fallback box.
  await openSettings(page);
  // Gemini stays selected and its box stays EMPTY; the key goes only in the
  // Groq box. That is the case the header pill accepted and the button did
  // not -- and with one box per provider it is now the ordinary way to use a
  // single key for a provider you did not pick in the dropdown.
  await page.fill('#keyGemini', '');
  await page.fill('#keyGroq', 'test-key-not-real');
  await closeSettings(page);
  await page.waitForTimeout(500);

  assert.notEqual(await page.textContent('#keyStatus'), 'No key',
    'precondition: the pill can see the fallback key');

  await page.uncheck('#includeCoverLetter');
  await page.click('#tailorBtn');
  await page.waitForTimeout(1200);

  assert.doesNotMatch(await status(page), /Enter an API key first/i,
    'the run must not refuse a key the pill is already reporting as usable');
});

// --- the key an existing user already typed --------------------------------

test('a key saved by the old single-box layout survives the update', async (t) => {
  // 2.3.0 shipped ONE unlabelled key box, saved as `apiKey`, with the
  // per-provider boxes as optional extras. This version replaces that box with
  // three, one per provider. Anyone who already entered a key has it in
  // `apiKey` and nothing in the box that now replaces it -- so without a
  // migration their key silently disappears on update, the pill reads "No
  // key", and a working install stops working for no visible reason.
  //
  // 2.3.0 is published. Those users exist.
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(async () => { await mockLlm.close(); });

  const { context, extensionId } = await launch(t);
  const seeded = await context.newPage();
  await seeded.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await seeded.evaluate(() => chrome.storage.local.set({
    tailorune_settings_v1: { provider: 'groq', apiKey: 'key-from-the-old-layout' },
  }));
  await seeded.close();

  const page = await openPopup(context, extensionId, mockLlm.url);
  await page.waitForTimeout(1200);
  await openSettings(page);

  assert.equal(await page.inputValue('#keyGroq'), 'key-from-the-old-layout',
    'the old key must land in the box for the provider it was saved against');
  assert.equal(await page.inputValue('#keyGemini'), '',
    'and must not be copied into providers it was never for');
  assert.notEqual(await page.textContent('#keyStatus'), 'No key',
    'so the install still reports itself as usable');
});

// --- the button that did nothing at all ------------------------------------

test('Tailor always says why it will not run', async (t) => {
  // The missing-resume message was suppressed whenever #status held ANY text,
  // to avoid clobbering a file-extraction error. But every other message
  // suppressed it too -- so on a fresh install: paste a job, click the lock
  // (which sets a status), press Tailor, and absolutely nothing happened. No
  // run, no message, no change. Same after Reset and after a restored run.
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(async () => { await mockLlm.close(); });

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);

  await page.fill('#jobDescription', JOB);   // a job, but no resume
  await page.waitForTimeout(600);
  await page.click('#pinBtn');               // any action that writes #status
  await page.waitForTimeout(600);
  assert.ok((await status(page)).length > 0, 'precondition: the status line is occupied');

  await page.click('#tailorBtn');
  await page.waitForTimeout(600);

  assert.match(await status(page), /resume/i,
    'pressing Tailor with no resume must say so, whatever the status line held');
});

test('...but a file that failed to read keeps its message', async (t) => {
  // The one message the guard above must NOT overwrite: it is more specific,
  // and it is the reason there is no resume in the first place.
  const mockLlm = await startMockLlmServer(() => ({ choices: [{ message: { content: '{}' } }] }));
  t.after(async () => { await mockLlm.close(); });

  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);

  await page.fill('#jobDescription', JOB);
  await page.setInputFiles('#resumeFile', {
    name: 'broken.txt', mimeType: 'text/plain', buffer: Buffer.from('   '),
  });
  await page.waitForTimeout(900);
  assert.match(await status(page), /Could not read broken\.txt/i, 'precondition: the read failed');

  await page.click('#tailorBtn');
  await page.waitForTimeout(600);

  assert.match(await status(page), /Could not read broken\.txt/i,
    'the specific failure must survive the generic "paste your resume" message');
});

// --- one run at a time, across a popup that does not survive ---------------

test('a second run is refused while the first is still going', async (t) => {
  // The popup is destroyed on focus loss, which is the ordinary thing to do
  // while waiting a minute or two for a run -- so its own busy flag was gone
  // and reopening showed an idle "Tailor resume" over a run still in flight.
  // Pressing it started a SECOND pipeline: the key billed and rate-limited
  // twice, two sets of files in Downloads, and whichever finished last
  // overwrote the other's stored result.
  //
  // Driven through the service worker directly, because that is where the
  // guard has to live: it is the only part of this that outlives the popup.
  let release;
  const held = new Promise((r) => { release = r; });
  const mockLlm = await startMockLlmServer(async () => {
    await held;   // keep run #1 in flight until we say so
    return { choices: [{ message: { content: JSON.stringify({ summary: 'x', entries: [] }) } }] };
  });
  t.after(async () => { release(); await mockLlm.close(); });

  // Sent from an extension PAGE, not from the service worker: a worker's own
  // chrome.runtime.sendMessage is not delivered to its own onMessage listener.
  const { context, extensionId } = await launch(t);
  const page = await openPopup(context, extensionId, mockLlm.url);

  const payload = {
    resumeText: RESUME,
    jobDescription: JOB,
    providerId: 'groq',
    apiKey: 'test-key-not-real',
    includeCoverLetter: false,
    useJudge: false,
    autoDownloadPdf: false,
    baseUrlOverride: mockLlm.url,
  };

  const send = (p) => page.evaluate(
    (arg) => chrome.runtime.sendMessage({ target: 'sw', type: 'tailor:run', payload: arg }), p,
  );

  const first = send(payload);
  await new Promise((r) => setTimeout(r, 1500));   // let run #1 reach the LLM
  const second = await send(payload);

  assert.equal(second.ok, false, 'the second run must be refused, not started');
  assert.match(second.error, /already going/i, `got: ${second.error}`);

  release();
  await first.catch(() => {});
});
