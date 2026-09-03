// job-extraction.test.mjs — tests "Read job from this page".
//
// Split deliberately into two halves, because one part of this feature is
// not automatable:
//
//   1. The EXTRACTION LOGIC (all four tiers) is tested by injecting
//      content/extractJob.js into real pages served over HTTP, using the
//      same execution shape Chrome uses (non-module script, result is the
//      value of the last expression). This is where the substance is, and
//      it gets full coverage.
//
//   2. The activeTab GRANT PATH cannot be automated. `activeTab` is granted
//      only when the user *invokes* the extension on a tab -- clicking its
//      toolbar icon -- and Playwright cannot click the browser's own
//      toolbar. Attempting it from a popup opened as an ordinary tab fails
//      with "Extension manifest must request permission to access the
//      respective host", which is correct Chrome behaviour, not a bug.
//      What IS tested here is that the service worker turns that failure
//      into an actionable message instead of leaking Chrome's raw error.
//      The happy path through a real toolbar click needs manual
//      verification; noted in docs/STATUS.md rather than silently skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BROWSER } from './browser.mjs';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { getExtensionServiceWorker } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const EXTRACTOR_SRC = readFileSync(path.join(EXTENSION_PATH, 'content/extractJob.js'), 'utf8');

const JD_TEXT = 'We are hiring a Senior Backend Engineer to build and operate distributed services. '
  + 'You will design APIs, own reliability, and work with Python, AWS, and Kubernetes every day. '
  + 'Five years of professional backend experience is expected for this position.';

const PAGES = {
  '/jsonld': `<!doctype html><html><head><meta charset="utf-8"><title>Careers</title>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Senior Backend Engineer',
      hiringOrganization: { '@type': 'Organization', name: 'Northwind Systems' },
      description: `<p>${JD_TEXT}</p><ul><li>Design APIs</li><li>Own reliability</li></ul>`,
    })}</script></head><body><h1>Careers</h1></body></html>`,

  '/graph': `<!doctype html><html><head><meta charset="utf-8"><title>Jobs</title>
    <script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Some Board' },
        {
          '@type': ['JobPosting'],
          title: 'Platform Engineer',
          hiringOrganization: 'Graph Corp',
          description: `<p>${JD_TEXT}</p>`,
        },
      ],
    })}</script></head><body></body></html>`,

  '/async': `<!doctype html><html><head><meta charset="utf-8"><title>Backend Engineer at Lateload Inc</title>
    <meta property="og:site_name" content="Lateload Inc"></head>
    <body><div id="root"></div><script>
      setTimeout(() => {
        const d = document.createElement('div');
        d.className = 'job-description';
        d.textContent = ${JSON.stringify(JD_TEXT)};
        document.getElementById('root').appendChild(d);
      }, 350);
    </script></body></html>`,

  '/bare': `<!doctype html><html><head><meta charset="utf-8"><title>Some Page</title></head>
    <body><nav>ignore this nav</nav><main><p>${JD_TEXT}</p></main><footer>ignore this footer</footer></body></html>`,

  // A job board masquerading as the employer via og:site_name -- the
  // extractor must reject the board name and fall back to the title.
  '/board': `<!doctype html><html><head><meta charset="utf-8">
    <title>Data Engineer at Realcorp Ltd</title>
    <meta property="og:site_name" content="LinkedIn"></head>
    <body><div class="job-description">${JD_TEXT}</div></body></html>`,

  '/malformed': `<!doctype html><html><head><meta charset="utf-8"><title>Broken</title>
    <script type="application/ld+json">{ this is not valid json at all }</script></head>
    <body><div class="job-description">${JD_TEXT}</div></body></html>`,
};

function startPageServer() {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    if (!body) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: (p) => `http://127.0.0.1:${server.address().port}${p}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

/**
 * Run the extractor exactly as chrome.scripting.executeScript does: a
 * non-module script whose completion value is the last expression --
 * extractJob.js ends with `extractJobContext()`, so that promise is the
 * result. Playwright awaits it for us.
 */
async function runExtractor(page) {
  return page.evaluate(EXTRACTOR_SRC);
}

// ── 1. Extraction logic, against real pages ───────────────────────────────

test('extraction: JSON-LD posting yields high confidence with title, employer, and plain-text body', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/jsonld'));

  const job = await runExtractor(page);
  assert.equal(job.source, 'json_ld');
  assert.equal(job.confidence, 'high');
  assert.equal(job.jobTitle, 'Senior Backend Engineer');
  assert.equal(job.employer, 'Northwind Systems');
  assert.ok(job.text.includes('distributed services'));
  // JobPosting.description is authored as HTML; it must arrive readable.
  assert.ok(!job.text.includes('<p>'), 'HTML should be converted to plain text');
  assert.ok(job.text.includes('Design APIs'), 'list items should survive conversion');
});

test('extraction: finds a JobPosting nested in an @graph array, with a string hiringOrganization', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/graph'));

  const job = await runExtractor(page);
  assert.equal(job.jobTitle, 'Platform Engineer');
  assert.equal(job.employer, 'Graph Corp');
});

test('extraction: waits for an asynchronously injected description container', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/async'));

  // The container appears ~350ms after load. A synchronous read would have
  // fallen through to the body-text tier -- this is what _waitForDom exists
  // for, and split-view job boards behave exactly this way.
  const job = await runExtractor(page);
  assert.equal(job.source, 'job_container');
  assert.ok(job.text.includes('distributed services'));
  assert.equal(job.employer, 'Lateload Inc');
});

test('extraction: falls back to stripped body text at low confidence, dropping nav and footer', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/bare'));

  const job = await runExtractor(page);
  assert.equal(job.source, 'body_fallback');
  // Low confidence is what makes the popup ask the user to review rather
  // than silently trusting a body dump.
  assert.equal(job.confidence, 'low');
  assert.ok(job.text.includes('distributed services'));
  assert.ok(!job.text.includes('ignore this nav'));
  assert.ok(!job.text.includes('ignore this footer'));
});

test('extraction: rejects a job-board name from og:site_name and uses the page title instead', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/board'));

  const job = await runExtractor(page);
  assert.ok(!/linkedin/i.test(job.employer), `board name leaked as employer: ${job.employer}`);
  assert.equal(job.employer, 'Realcorp Ltd');
});

test('extraction: survives malformed JSON-LD and falls through to the container tier', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/malformed'));

  const job = await runExtractor(page);
  assert.equal(job.source, 'job_container');
  assert.ok(job.text.includes('distributed services'));
});

test('extraction: re-injecting into the same page does not throw on redeclared top-level bindings', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/jsonld'));

  // extractJob.js uses `var` at top level precisely so a second injection
  // into the same world re-declares instead of throwing "Identifier has
  // already been declared". Clicking the button twice must just work.
  await runExtractor(page);
  const second = await runExtractor(page);
  assert.equal(second.jobTitle, 'Senior Backend Engineer');
});

// ── 2. Service-worker error handling (the grant path itself is manual) ────

test('service worker returns an actionable message when activeTab was never granted', async (t) => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-jd-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
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

  const server = await startPageServer();
  t.after(() => server.close());

  const sw = await getExtensionServiceWorker(context);
  const extensionId = sw.url().split('/')[2];

  const jobPage = await context.newPage();
  await jobPage.goto(server.url('/jsonld'));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await jobPage.bringToFront();

  const result = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ target: 'sw', type: 'job:extract' }));

  // No toolbar click happened, so activeTab was never granted. The point of
  // this test is that the user is told what to do, not shown Chrome's raw
  // "Extension manifest must request permission..." string.
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /manifest must request permission/i,
    'raw Chrome error leaked to the user');
  assert.match(result.error, /toolbar icon|normal tab|cannot be read/i,
    `expected actionable guidance, got: ${result.error}`);
});
