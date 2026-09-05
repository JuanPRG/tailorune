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
  '/indeedpane': `<!doctype html><html><head><meta charset="utf-8"><title>Job Search Canada | Indeed</title>
    <meta property="og:title" content="Job Search Canada | Indeed" /></head>
    <body>
      <h1>Welcome, Juan</h1>
      <div class="jobsearch-JobComponent">
        <div class="jobsearch-HeaderContainer"><div class="jobsearch-InfoHeaderContainer">
          <div class="jobsearch-JobInfoHeader-title-container">
            <h2 class="jobsearch-JobInfoHeader-title" data-testid="jobsearch-JobInfoHeader-title">Wireless Sales Representative - job post</h2>
          </div>
          <div data-testid="jobsearch-CompanyInfoContainer">
            <span data-testid="inlineHeader-companyName"><a href="/cmp/The-Mobile-Shop">The Mobile Shop</a></span>
          </div>
        </div></div>
        <div id="jobDescriptionText"><p>${JD_TEXT}</p><ul><li>Sell wireless plans</li><li>Serve customers in store</li></ul></div>
      </div>
    </body></html>`,
  '/greenhouse': `<!doctype html><html><head><meta charset="utf-8">
    <title>Job Application for Department Executive Assistant at The New York Times</title>
    <meta property="og:title" content="Department Executive Assistant, NYT Wirecutter" /></head>
    <body>
      <div class="job-post-container">
        <div class="job__header">
          <div class="job__title"><h1>Department Executive Assistant, NYT Wirecutter</h1>
            <div class="job__location">New York, NY</div></div>
        </div>
        <div class="company-name">The New York Times</div>
        <div class="job__description"><p>${JD_TEXT}</p><ul><li>Manage calendars</li><li>Coordinate travel</li></ul></div>
      </div>
    </body></html>`,
  // A modern SPA: every class hashed, no known container, the description in
  // link-free prose and the chrome in link-dense blocks. Copied in shape from
  // a signed-in LinkedIn posting.
  '/hashedspa': `<!doctype html><html><head><meta charset="utf-8">
    <title>Senior Back-End Developer | Eugeria | LinkedIn</title></head>
    <body><main>
      <nav class="_0c4f8c26"><a href="/a">Home</a><a href="/b">My Network</a><a href="/c">Jobs</a>
        <a href="/d">Messaging</a><a href="/e">Notifications</a><a href="/f">Me</a><a href="/g">Business</a></nav>
      <div class="_5bf80336 _455432d1"><div class="_46f248c1"><h2>About the job</h2></div>
        <div class="_799d43a3">${JD_TEXT} ${JD_TEXT} ${JD_TEXT} ${JD_TEXT} ${JD_TEXT}</div></div>
      <div class="_1b608c33"><h2>More jobs</h2>
        <a href="/1">Job one</a><a href="/2">Job two</a><a href="/3">Job three</a><a href="/4">Job four</a>
        <a href="/5">Job five</a><a href="/6">Job six</a><a href="/7">Job seven</a><a href="/8">Job eight</a></div>
    </main></body></html>`,
  // LinkedIn signed out: a clean title in .topcard__title, and an og:title
  // that carries the company and the location too.
  '/linkedinout': `<!doctype html><html><head><meta charset="utf-8">
    <title>Senior Back-End Developer at Eugeria — Montreal, Quebec, Canada | LinkedIn Jobs</title>
    <meta property="og:title" content="Senior Back-End Developer at Eugeria — Montreal, Quebec, Canada | LinkedIn Jobs" /></head>
    <body>
      <h2 class="topcard__title">Senior Back-End Developer</h2>
      <a class="topcard__org-name-link" href="/company/eugeria">Eugeria</a>
      <div class="show-more-less-html__markup"><p>${JD_TEXT}</p><ul><li>Build APIs</li><li>Own reliability</li></ul></div>
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

test('indeed: the selected job pane yields its title, not the page greeting', async (t) => {
  // COPIED FROM THE LIVE PAGE, ca.indeed.com/?vjk=dedf2818f6008655, read
  // through the signed-in session that produced the report. Everything the
  // extractor used to look for is absent there: no viewjob-main-content, no
  // vj-job-title, no company-info-title-row. What exists is
  // jobsearch-JobInfoHeader-title inside .jobsearch-JobComponent -- and
  // inlineHeader-companyName, which WAS on the employer list, which is
  // exactly why the company resolved while the title came back empty.
  //
  // SERVED UNDER THE REAL HOSTNAME. _isIndeedPage() reads location.hostname,
  // so the same markup on 127.0.0.1 takes the generic path instead and this
  // test proves nothing -- the first version of it returned the og:title,
  // "Job Search Canada | Indeed", which is the site and not the job.
  //
  // Two earlier fixes were reasoned from invented fixtures that behaved.
  // This one is the page.
  const server = await startPageServer();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();

  const markup = await (await fetch(server.url('/indeedpane'))).text();
  await page.route('https://ca.indeed.com/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: markup,
  }));
  await page.goto('https://ca.indeed.com/?vjk=dedf2818f6008655');

  const result = await runExtractor(page);
  assert.equal(result.source, 'indeed_selected_pane', 'the Indeed adapter must be the one answering');
  assert.equal(result.jobTitle, 'Wireless Sales Representative',
    'the pane title, with the Indeed suffix stripped');
  assert.equal(result.employer, 'The Mobile Shop');
  assert.notEqual(result.jobTitle, 'Welcome, Juan', 'the greeting h1 must never win');
  assert.match(result.text, /Sell wireless plans/, 'and the description comes from the pane, not the page');
});

test('greenhouse: the description container is job__description, with two underscores', async (t) => {
  // MEASURED ON LIVE POSTINGS. Greenhouse emits no JSON-LD at all, and its
  // container is `.job__description` -- a DOUBLE underscore. The selector
  // list had `.job-description`, hyphenated, which is a different class.
  //
  // That one character was the whole failure, and it cost the title too: no
  // container matched, so the description fell back to body text, which
  // scores `low`, and a low-confidence description gates the page-level title
  // tiers on purpose. So a Greenhouse posting produced NO title even though
  // its h1 and og:title both carry it exactly.
  //
  // Verified after the fix on two live New York Times postings: title,
  // employer, ~8.5k chars, job_container, high.
  const { result } = await titleOf(t, '/greenhouse');

  assert.equal(result.source, 'job_container', 'the container must be found, not fallen back from');
  assert.notEqual(result.confidence, 'low', 'and a found container is what un-gates the title');
  assert.equal(result.jobTitle, 'Department Executive Assistant, NYT Wirecutter');
  assert.equal(result.employer, 'The New York Times');
  assert.match(result.text, /Manage calendars/, 'the description comes from the container');
  assert.doesNotMatch(result.jobTitle, /New York, NY/, 'the location must not ride along on the title');
});

test('a page with only hashed class names still yields its description', async (t) => {
  // MEASURED ON A SIGNED-IN LINKEDIN POSTING. Its description sits in
  // `_5bf80336 _455432d1` -- names that change on deploy, so hardcoding one
  // buys nothing. What does not change is the SHAPE: a job description is
  // long prose with almost no links, while navigation and "More jobs" are
  // short and link-dense. On the live page the description scored 7528 chars
  // against 0 links and won outright.
  const { result } = await titleOf(t, '/hashedspa');

  assert.equal(result.source, 'dense_prose_block', 'the prose block must be found by shape');
  assert.notEqual(result.confidence, 'low', 'finding a container is what un-gates the title');
  assert.ok(result.text.length > 1200, `expected the description, got ${result.text.length} chars`);
  assert.doesNotMatch(result.text, /My Network|Notifications/, 'the nav must not be swept in');
  assert.doesNotMatch(result.text, /Job seven|Job eight/, 'nor the related-jobs list');

  // And with the description found, the tab title supplies both fields.
  assert.equal(result.jobTitle, 'Senior Back-End Developer');
  assert.equal(result.employer, 'Eugeria');
});

test('linkedin: the clean topcard title beats a polluted og:title', async (t) => {
  // Signed out, LinkedIn og:title reads
  // "<role> at <Company> - <City>, <Region> | LinkedIn Jobs" -- measured on a
  // live posting, where the whole string was landing in the job title field.
  // Employer had a platform selector list all along; title never did.
  const { result } = await titleOf(t, '/linkedinout');

  assert.equal(result.jobTitle, 'Senior Back-End Developer');
  assert.equal(result.employer, 'Eugeria');
  assert.doesNotMatch(result.jobTitle, /LinkedIn|Montreal/, 'no company, location or board name');
});

test('employer: a hyphen inside a word is not a separator', async (t) => {
  // "Developpeur(se) Back-End Senior(e) | Eugeria | LinkedIn" returned the
  // employer "End Senior(e)": the pattern treated the hyphen in "Back-End" as
  // a title/company divider. Separators have spaces around them.
  const { result } = await titleOf(t, '/hashedspa');
  assert.equal(result.employer, 'Eugeria');
  assert.doesNotMatch(result.employer, /End|Back/, 'the title must not be split mid-word');
});

test('employer: " at " outranks a plain separator', async (t) => {
  // Greenhouse titles read "<role> - <arrangement> at <Company>". Taking the
  // segment after the first separator returned the ARRANGEMENT: a live
  // posting came back with the employer "Temp to Perm".
  const { result } = await titleOf(t, '/greenhouse');
  assert.equal(result.employer, 'The New York Times');
});
