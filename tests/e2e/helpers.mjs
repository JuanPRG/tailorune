// helpers.mjs — shared e2e plumbing.
//
// Two non-obvious workarounds live here, both confirmed by direct
// experiment rather than documentation:
//   1. context.waitForEvent('download') never fires for a download an
//      extension triggers via chrome.downloads.download() (as opposed to a
//      page navigation/click) -- worked around by polling
//      chrome.downloads.search() from the service worker itself.
//   2. context.route() does not intercept fetches made from an offscreen
//      document -- worked around in mockLlmServer.mjs with a real local
//      HTTP server instead of network mocking.

import JSZip from 'jszip';

export async function getExtensionServiceWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return sw;
}

export async function docxTextOf(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

export async function waitForCompletedDownload(sw, downloadId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [item] = await sw.evaluate((id) => chrome.downloads.search({ id }), downloadId);
    if (item && item.state === 'complete') return item;
    if (item && item.state === 'interrupted') throw new Error(`Download interrupted: ${item.error}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Download ${downloadId} did not complete within ${timeoutMs}ms`);
}

/** Open the settings view (provider and tailoring preferences). */
export async function openSettings(page) {
  if (await page.locator('#settingsView').evaluate((el) => el.hidden)) {
    await page.click('#settingsBtn');
  }
  await page.waitForSelector('#keyGemini', { state: 'visible' });
}

/** Return to the tailoring view. */
export async function closeSettings(page) {
  if (!await page.locator('#settingsView').evaluate((el) => el.hidden)) {
    await page.click('#settingsBackBtn');
  }
  await page.waitForSelector('#tailorBtn', { state: 'visible' });
}

/**
 * Put a key in, then come back.
 *
 * The API key field lives in the settings view behind the header's gear, so
 * this is the same two clicks a user makes. It RETURNS to the tailoring view
 * on purpose: the settings view hides main and the footer, so a test that
 * left it open would find neither the resume field nor the CTA.
 *
 * popup.js opens settings by itself when no key is stored, which is the
 * common case in a fresh profile -- but a test should not depend on that
 * timing, so this checks rather than assumes.
 */
/**
 * Configure the provider in ONE settings visit.
 *
 * Provider and keys all live behind the gear, and the settings view hides the
 * tailoring view -- so doing them one at a time meant opening and closing it
 * around each field. This is a single trip.
 *
 * THERE IS NO PRIMARY KEY FIELD any more: there is one box per provider, and
 * the dropdown only decides which is tried first. So `apiKey` here goes into
 * the box for `provider`, and `fallbacks` names the others by provider id
 * rather than by CSS selector.
 *
 * @param {object} opts
 * @param {string} [opts.provider]  value for #provider, default gemini
 * @param {string} [opts.apiKey]    key for that provider
 * @param {Record<string,string>} [opts.fallbacks]  provider id -> key, e.g. { groq: 'k' }
 */
export const KEY_FIELD = {
  gemini: '#keyGemini', groq: '#keyGroq', openrouter: '#keyOpenrouter',
};

/**
 * The provider selector lives inside a collapsed <details> now, so it is not
 * actionable and selectOption would time out. Opened via the DOM rather than
 * by clicking the summary: this is setup, not the behaviour under test, and a
 * click there would make every test that configures a provider depend on the
 * disclosure's hit box.
 */
async function openPinAdvanced(page) {
  await page.evaluate(() => {
    const d = document.getElementById('pinAdvanced');
    if (d) d.open = true;
  });
}

export async function configureProvider(page, {
  provider = 'gemini', apiKey = 'test-key-not-real', fallbacks = {},
} = {}) {
  await openSettings(page);
  await openPinAdvanced(page);
  await page.selectOption('#provider', provider);
  await page.fill(KEY_FIELD[provider], apiKey);
  for (const [id, key] of Object.entries(fallbacks)) {
    await page.fill(KEY_FIELD[id] || id, key);
  }
  await closeSettings(page);
}

/** Fill the key for whichever provider is currently selected. */
export async function fillApiKey(page, key = 'test-key-not-real') {
  await openSettings(page);
  const provider = await page.inputValue('#provider');
  await page.fill(KEY_FIELD[provider] || '#keyGemini', key);
  await closeSettings(page);
}

/**
 * Wait for a download the USER triggered from the popup, where the test never
 * sees the id.
 *
 * The "Save as PDF" buttons hand their bytes to the service worker, which
 * calls chrome.downloads.download() and keeps the id to itself, so
 * waitForCompletedDownload has nothing to be given.
 *
 * MATCHED ON MIME, NOT ON FILENAME, and that is not a style choice: under
 * Playwright every download lands as a GUID in a playwright-artifacts-*
 * directory with NO EXTENSION AT ALL --
 *
 *   C:\...\playwright-artifacts-fosrbG\80eedb1e-6442-4fe8-ad75-83e1b674a5c6
 *
 * -- so `filename.endsWith('.pdf')` never matches anything here, however
 * correct the extension's own `filename` argument was. The requested name is
 * simply not what reaches disk in this harness, which also means a test
 * cannot assert it.
 */
export async function waitForNewestDownload(sw, mime, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let seen = null;
  while (Date.now() < deadline) {
    const items = await sw.evaluate(
      () => chrome.downloads.search({ orderBy: ['-startTime'], limit: 20 }),
    );
    const matching = (items || []).filter((i) => i.mime === mime);
    seen = matching[0] || seen;
    const done = matching.find((i) => i.state === 'complete');
    if (done) return done;
    const broken = matching.find((i) => i.state === 'interrupted');
    if (broken) throw new Error(`Download interrupted: ${broken.error}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `No completed "${mime}" download within ${timeoutMs}ms`
    + (seen ? ` (one was ${seen.state})` : ' (none started)'),
  );
}

/** The text of a PDF on disk, for asserting what actually reached the user. */
export async function pdfTextOf(filePath) {
  const { readFileSync } = await import('node:fs');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(filePath)), useSystemFonts: true,
  }).promise;
  let out = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    out += (await page.getTextContent()).items.map((i) => i.str).join(' ') + ' ';
  }
  return out.replace(/\s+/g, ' ');
}

// openResumeManage() used to live here, and every test that touched Save,
// Delete or the name field had to call it first. It is gone with the paste
// box: the disclosure now holds only Save and Delete, and opens itself
// exactly when a loaded resume is not yet in the library -- which is the one
// moment a test wants to press Save. Nothing has to reach past it any more.
