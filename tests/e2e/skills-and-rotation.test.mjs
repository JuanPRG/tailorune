// skills-and-rotation.test.mjs — proves, through the real extension, that
//   (a) the skills section is genuinely tailored by its own second pass, and
//   (b) a rate-limited primary provider fails over to a fallback key instead
//       of failing the whole run.
//
// Both were gaps versus v4 and both are the kind of thing that can
// look wired up in unit tests while being disconnected in the real pipeline,
// so they get a real-browser check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BROWSER } from './browser.mjs';
import http from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { getExtensionServiceWorker, docxTextOf, waitForCompletedDownload, fillApiKey, configureProvider } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');
const FIXTURE = readFileSync(path.resolve(__dirname, '../fixtures/resumes/juan-rivera-full.txt'), 'utf8');

const TAILORED_SUMMARY = 'TAILORED SUMMARY for the backend role.';
// The fixture's skills lines are "- Languages: Java, JavaScript (Node.js), ..."
// and "- Cloud & DevOps: Amazon Web Services (AWS), Docker, ...". Keeping
// "Java" and "Docker" respectively puts both rewrites over the 20% floor.
const SKILLS_REWRITE = {
  0: '- Languages: Java, Python, Go',
  1: '- Cloud & DevOps: Docker, Kubernetes, Terraform',
};

/**
 * A mock that classifies each request by content and can be told to reject
 * the first N requests with a 429, to force provider failover.
 */
function startMock({ rateLimitFirst = 0 } = {}) {
  const calls = [];
  let rejected = 0;
  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const auth = req.headers.authorization || '';
      let kind = 'resume';
      if (body.includes('SKILLS/COMPETENCIES BLOCKS')) kind = 'skills';
      else if (body.includes('no sign-off')) kind = 'cover_letter';

      if (rejected < rateLimitFirst) {
        rejected += 1;
        calls.push({ kind, auth, status: 429 });
        res.writeHead(429, { ...cors, 'Content-Type': 'application/json' });
        res.end('Too many requests, slow down');
        return;
      }

      calls.push({ kind, auth, status: 200 });
      const content = kind === 'skills'
        ? JSON.stringify(SKILLS_REWRITE)
        : JSON.stringify({ summary: TAILORED_SUMMARY, entries: [{ index: 0, bullets: ['B1.'] }, { index: 1, bullets: ['B2.'] }] });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((r) => server.close(r)),
      calls: () => [...calls],
    }));
  });
}

async function launch(t, mockUrl) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-sr-'));
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
  const extensionId = sw.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html?llmBaseUrlOverride=${encodeURIComponent(mockUrl)}`);
  return { context, sw, page };
}

async function waitForResult(page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('result');
    return el && el.textContent && el.textContent.length > 0;
  }, { timeout: 30000 });
  return JSON.parse(await page.textContent('#result'));
}

test('skills are tailored by a real second pass and land in the rendered DOCX', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { sw, page } = await launch(t, mock.url);

  await page.fill('#resumeText', FIXTURE);
  await page.fill('#jobDescription', 'Backend engineer: Python, AWS, Kubernetes.');
  await page.uncheck('#includeCoverLetter');
  await fillApiKey(page);
  await page.click('#tailorBtn');

  const result = await waitForResult(page);
  assert.equal(result.ok, true, JSON.stringify(result));

  // A distinct skills call really happened.
  const kinds = mock.calls().map((c) => c.kind);
  assert.ok(kinds.includes('skills'), `no skills call observed: ${JSON.stringify(kinds)}`);
  assert.equal(result.skills.status, 'approved', JSON.stringify(result.skills));

  // And its output reached the actual document.
  const download = result.downloads.find((d) => d.kind === 'resume');
  const item = await waitForCompletedDownload(sw, download.downloadId);
  const text = await docxTextOf(readFileSync(item.filename));

  assert.ok(text.includes('Kubernetes'), 'tailored skills text missing from the rendered docx');
  assert.ok(text.includes('Go'), 'tailored skills text missing from the rendered docx');
  // Retention guard: the items kept verbatim must still be there.
  assert.ok(text.includes('Java'), 'retained skill item missing');
  assert.ok(text.includes('Docker'), 'retained skill item missing');
});

test('a rate-limited primary provider fails over to a fallback key instead of failing the run', async (t) => {
  // Reject the very first request, so the resume pass has to rotate.
  const mock = await startMock({ rateLimitFirst: 1 });
  t.after(() => mock.close());
  const { page } = await launch(t, mock.url);

  await page.fill('#resumeText', FIXTURE);
  await page.fill('#jobDescription', 'Backend engineer.');
  await page.uncheck('#includeCoverLetter');
  // One settings visit for both keys. The Groq fallback is what gives the
  // chain somewhere to rotate to when the primary is rate limited.
  await configureProvider(page, {
    apiKey: 'primary-gemini-key',
    fallbacks: { '#fallbackGroq': 'fallback-groq-key' },
  });
  await page.click('#tailorBtn');

  const result = await waitForResult(page);
  assert.equal(result.ok, true, `run should survive a rate-limited primary: ${JSON.stringify(result)}`);

  const calls = mock.calls();
  assert.equal(calls[0].status, 429, 'first call should have been rate-limited');
  assert.match(calls[0].auth, /primary-gemini-key/, 'first call should have used the primary key');

  // The retry must have used the FALLBACK key, proving real rotation rather
  // than just a same-provider retry.
  const fallbackCall = calls.find((c) => c.auth.includes('fallback-groq-key'));
  assert.ok(fallbackCall, `no call used the fallback key: ${JSON.stringify(calls.map((c) => c.auth))}`);
  assert.equal(fallbackCall.status, 200);

  // The throttled model is recorded as cooling, on the SHARED scope -- a rate
  // limit is a fact about that credential everywhere, not just for this task.
  //
  // Asserted on the recorded values rather than the key string: the key is an
  // internal (baseUrl, model, apiKey) triple, and an earlier version of this
  // test broke on its shape while the behaviour was entirely correct.
  const cooldowns = result.cooldowns || {};
  const throttled = Object.entries(cooldowns)
    .find(([key]) => key.includes('gemini-3.1-flash-lite'));
  assert.ok(throttled, `expected the gemini model to be cooling, got ${JSON.stringify(cooldowns)}`);
  assert.equal(throttled[1].failureType, 'rate_limited');
  assert.equal(throttled[1].scope, 'shared');

  // No entry is held for a provider that never failed. The fallback answered,
  // so nothing about Groq should be on the SHARED scope -- a task-scoped hold
  // from a validation retry is a different thing and is allowed here.
  const groqShared = Object.entries(cooldowns)
    .filter(([key, v]) => key.includes('api.groq.com') && v.scope === 'shared');
  assert.deepEqual(groqShared, [], 'a provider that answered must not be sidelined');
});
