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

/**
 * The API key input lives inside a collapsed <details>, which Playwright
 * cannot fill. popup.js auto-expands it when no key is stored, but a test
 * shouldn't depend on that timing -- force it open, then fill.
 */
export async function fillApiKey(page, key = 'test-key-not-real') {
  await page.locator('#providerDetails').evaluate((el) => { el.open = true; });
  await page.fill('#apiKey', key);
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

/**
 * Open the resume card's "Text & library" disclosure.
 *
 * The textarea, the name field and Save/Delete live behind it: the point of
 * that layout is that a loaded resume shows a name and a word count rather
 * than 110px of scrolled document. It opens itself while the card is empty
 * and closes when a resume arrives, so any test that drives those controls
 * AFTER loading one has to open it -- the same click a user makes, and the
 * same reason fillApiKey() forces #providerDetails open.
 */
export async function openResumeManage(page) {
  await page.locator('#resumeManage').evaluate((el) => { el.open = true; });
}
