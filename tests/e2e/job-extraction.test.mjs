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
import { openRealPopup } from './realPopup.mjs';
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

  '/h1only': `<!doctype html><html><head><meta charset="utf-8"><title>Mobile Sales Expert - The Mobile Shop | JobBoard</title>
    <meta property="og:site_name" content="The Mobile Shop" /></head>
    <body><header><h1>Mobile Sales Expert</h1></header>
    <div class="job-description"><p>${JD_TEXT}</p><ul><li>Sell phones</li><li>Serve customers</li></ul></div>
    </body></html>`,
  '/genericheading': `<!doctype html><html><head><meta charset="utf-8"><title>Careers</title></head>
    <body><h1>Careers</h1>
    <div class="job-description"><p>${JD_TEXT}</p><ul><li>Do the work</li><li>Own outcomes</li></ul></div>
    </body></html>`,
  '/ogtitle': `<!doctype html><html><head><meta charset="utf-8"><title>JobBoard</title>
    <meta property="og:title" content="Highway Maintenance Technician" /></head>
    <body><h1>Apply now</h1>
    <div class="job-description"><p>${JD_TEXT}</p><ul><li>Maintain highways</li><li>Report faults</li></ul></div>
    </body></html>`,
  '/indeedhome': `<!doctype html><html><head><meta charset="utf-8"><title>Job Search Canada | Indeed</title>
    <meta property="og:title" content="Job Search Canada | Indeed" /></head>
    <body><h1>Welcome, Juan</h1>
    <main><p>${JD_TEXT}</p><p>Responsibilities include serving customers and meeting sales targets.</p></main>
    </body></html>`,
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

// --- automatic detection on open ----------------------------------------
//
// v4 read the job as soon as the popup opened -- popup/script.js: "Auto-extract
// JD if textarea is empty and no active tailoring is happening" -- so standing
// on a posting and wanting it tailored cost no clicks. Tailorune had the same
// extractor behind a button.
//
// WHAT CAN AND CANNOT BE PROVEN HERE, because the first version of these tests
// got it wrong and passed for the wrong reason.
//
// activeTab is granted by a USER invoking the extension. Opening the popup
// from the toolbar counts; `chrome.action.openPopup()` called from the service
// worker -- the only way a test can open the real popup -- does NOT. So in
// this harness the read always fails with the extension's own "click the
// Tailorune toolbar icon" message, whatever page is in front.
//
// A test asserting "a non-posting page fills nothing" therefore passes on a
// posting too, and proves nothing. What IS provable splits in two:
//
//   1. the WIRING -- the popup asks to read the page on open, with no click.
//      Observed on the service worker, which sees the message either way.
//   2. the FAILURE CONTRACT -- a read that does not succeed says nothing and
//      invents nothing. This is the path the harness produces naturally, and
//      it is the same path a genuine non-posting page takes in production.
//
// The extraction itself is covered by the eight tests above, which reach the
// page through chrome.scripting directly and need no activeTab grant.

test('opening the popup asks to read the page, with no click', async (t) => {
  const server = await startPageServer();
  t.after(() => server.close());

  // Counted on the service worker. An extra onMessage listener that returns
  // undefined does not consume the message, so the real handler still runs.
  const { popup, sw } = await openRealPopup(t, {
    hostUrl: server.url('/jsonld'),
    beforeOpen: async (worker) => {
      await worker.evaluate(() => {
        self.__extractCalls = 0;
        self.__urlCalls = 0;
        chrome.runtime.onMessage.addListener((m) => {
          if (!m || m.target !== 'sw') return;
          if (m.type === 'job:extract') self.__extractCalls += 1;
          if (m.type === 'tab:url') self.__urlCalls += 1;
        });
      });
    },
  });

  await popup.waitForTimeout(2000);
  const calls = await sw.evaluate(() => self.__extractCalls);
  assert.equal(calls, 1, `the popup should ask to read the page exactly once on open, saw ${calls}`);


  // And pressing the button is still a second, separate read -- automatic
  // detection replaces the need to press it, not the ability to.
  await popup.click('#readPageBtn');
  await popup.waitForTimeout(1200);
  assert.equal(await sw.evaluate(() => self.__extractCalls), 2,
    'the button must still trigger its own read');
});

test('a read that finds nothing says nothing, and invents nothing', async (t) => {
  // The silence is the point, and it is why this is not simply the button
  // firing itself. The user did not ask for anything -- they opened the popup
  // while standing on some ordinary page, maybe to paste a description by
  // hand. An error about a page they were only browsing would be noise, and a
  // half-filled form would be worse than an empty one.
  const server = await startPageServer();
  t.after(() => server.close());

  const { popup } = await openRealPopup(t, { hostUrl: server.url('/bare') });
  await popup.waitForTimeout(2500);

  const hint = (await popup.textContent('#extractHint')).trim();
  assert.notEqual(hint, 'Reading this page...', 'the transient notice must be cleared, not left hanging');
  assert.equal(hint, '', `a failed read should report nothing, got: ${hint}`);
  assert.equal(await popup.inputValue('#jobDescription'), '', 'no description should be invented');
  assert.equal(await popup.inputValue('#jobTitle'), '', 'no title should be invented');
  assert.equal(await popup.inputValue('#employer'), '', 'no employer should be invented');
  assert.equal(await popup.isEnabled('#readPageBtn'), true, 'and the button must stay usable');
});

test('a stored run makes the popup check which page it is on', async (t) => {
  // The staleness wiring. Without it a finished run followed the user to the
  // next posting: stale "Re-tailor", stale findings, stale save-as-PDF
  // buttons, and a job description that never updated until Reset.
  //
  // ONLY THE WIRING is provable here. Reading a tab's URL needs an activeTab
  // grant, which comes from a user clicking the toolbar and never from the
  // programmatic openPopup() a test must use -- measured: chrome.tabs.query
  // returns url `undefined`, so the popup sees no page and takes the
  // fail-open path whatever posting is in front. The decision itself is
  // covered by tests/unit/pageIdentity.test.mjs.
  //
  // Note the popup asks ONLY when there is a run to compare against: with
  // nothing stored there is no question to answer, which is why the test
  // above deliberately does not expect this call.
  const server = await startPageServer();
  t.after(() => server.close());

  const { popup, sw } = await openRealPopup(t, {
    hostUrl: server.url('/jsonld'),
    beforeOpen: async (worker) => {
      await worker.evaluate(() => {
        self.__urlCalls = 0;
        chrome.runtime.onMessage.addListener((m) => {
          if (m && m.target === 'sw' && m.type === 'tab:url') self.__urlCalls += 1;
        });
        return chrome.storage.local.set({
          tailorune_last_run_v1: {
            at: Date.now(),
            jobTitle: 'Backend Engineer',
            employer: 'Acme Corp',
            pageUrl: 'https://example.test/a-completely-different-posting',
            wordCount: 431,
            downloads: ['a.docx'],
            htmlPreview: '<h1>preview</h1>',
            resumeStatus: 'approved',
            resumeWarnings: [],
            resumeErrors: [],
          },
        });
      });
    },
  });

  await popup.waitForTimeout(2000);
  assert.ok(
    await sw.evaluate(() => self.__urlCalls) >= 1,
    'with a run stored, the popup must establish which page it is open over',
  );
});

// --- the title has tiers now, like the description always did -------------
//
// Reported after the greeting fix: "now there's no job title". The guard was
// not rejecting real titles -- JSON-LD was the ONLY place a title could come
// from, so a posting without it had never produced one. The stale greeting
// had been hiding that, because an automatic read never overwrites.

async function titleOf(t, route) {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url(route));
  return { page, result: await runExtractor(page) };
}

test('title: falls back to the page heading when there is no JSON-LD', async (t) => {
  const { result } = await titleOf(t, '/h1only');
  assert.equal(result.jobTitle, 'Mobile Sales Expert');
  assert.equal(result.employer, 'The Mobile Shop', 'and the employer still comes from its own source');
});

test('title: a section heading is not a job title', async (t) => {
  // "Careers" as a whole string is a banner. "Careers Advisor" is a real job,
  // which is why that match is anchored at both ends.
  const { result } = await titleOf(t, '/genericheading');
  assert.equal(result.jobTitle, '');
});

test('title: prefers og:title over a heading that says "Apply now"', async (t) => {
  // Also the regression guard for the missing word boundary: "Highway" starts
  // with "hi" and was being discarded as a greeting.
  const { result } = await titleOf(t, '/ogtitle');
  assert.equal(result.jobTitle, 'Highway Maintenance Technician');
});

test('title: a greeting is refused whichever tier offers it', async (t) => {
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(server.url('/bare'));
  await page.evaluate(() => {
    const h = document.createElement('h1');
    h.textContent = 'Welcome, Juan';
    document.body.prepend(h);
  });
  assert.equal((await runExtractor(page)).jobTitle, '',
    'the reported string must never reach the field');
});

test('title: a job board home page supplies no title, from any tier', async (t) => {
  // THE REPORTED PAGE: ca.indeed.com/?vjk=... is the HOME page with the job
  // in a side pane, not /viewjob. Measured on the real one -- signed out, its
  // og:title and document.title both read "Job Search Canada | Indeed", and
  // signed in its h1 is the greeting that started this.
  //
  // Every page-level tier here is describing the SITE. The description falls
  // back to body text, which is precisely the signal that no job container
  // was found, so none of them may be trusted. Better no title than a
  // confident wrong one on someone's cover letter.
  const { result } = await titleOf(t, '/indeedhome');
  assert.equal(result.confidence, 'low', 'precondition: this page has no job container');
  assert.equal(result.jobTitle, '',
    'neither the greeting nor the site name may become the job title');
});
