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
