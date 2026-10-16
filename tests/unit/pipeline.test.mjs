// pipeline.test.mjs — the whole tailoring run, in plain Node, outside Chrome.
//
// M1 of docs/AGENT_API_PLAN.md: the pipeline that used to live inside the
// offscreen document now takes its four platform seams (fonts, base64, PDF
// text, and nothing else) as arguments, so the same code serves the
// extension and the agent API. This is the proof that the Node side works
// end to end: real parse, real tailor, real DOCX and PDF bytes, against a
// local OpenAI-compatible mock -- the same mock shape the e2e suite uses.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

import { runTailorPipeline } from '../../extension/engine/pipeline.js';
import { resetCooldowns } from '../../extension/engine/rotatingClient.js';
import { resetRateWindows } from '../../extension/engine/rateWindow.js';
import { nodePlatform } from '../../server/platform/node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures/resumes');
const RESUME_TEXT = readFileSync(path.join(FIXTURES, 'juan-rivera-full.txt'), 'utf8');

const RESUME_SUMMARY = 'TAILORED SUMMARY for a backend engineering role.';
const CL_PARA_ONE = `BODY PARAGRAPH ONE about the backend role. ${Array(120).fill('word').join(' ')}`;
const CL_PARA_TWO = `BODY PARAGRAPH TWO about transferable experience. ${Array(120).fill('word').join(' ')}`;

// A recognisable fake key, so the leak assertion below can look for it.
const FAKE_KEY = 'AIzaFAKE-pipeline-test-key-0123456789';

/**
 * JSON for the resume pass, prose for the letter -- keyed off the request, not call order.
 * `failLetter` answers every cover-letter request with a 400, so the letter's whole chain fails
 * while the resume passes, as happened in production when Gemini was overloaded.
 */
function startMockLlm({ failLetter = false } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const isCoverLetter = body.includes('cover letter') || body.includes('no sign-off');
      if (isCoverLetter && failLetter) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock: letter requests are refused' } }));
        return;
      }
      const content = isCoverLetter
        ? `${CL_PARA_ONE}\n\n${CL_PARA_TWO}`
        : JSON.stringify({
          summary: RESUME_SUMMARY,
          entries: [{ index: 0, bullets: ['R1.'] }, { index: 1, bullets: ['R2.'] }],
        });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// Rotation state is module-level, exactly as in the offscreen document: a
// model whose output failed validation is held for 30s for that task. The
// mock's canned bullets fail validation on purpose-built fixtures, so without
// a reset each test would inherit the previous one's holds.
beforeEach(() => {
  resetCooldowns();
  resetRateWindows();
});

const docxText = async (base64) => {
  const zip = await JSZip.loadAsync(Buffer.from(base64, 'base64'));
  const xml = await zip.file('word/document.xml').async('string');
  return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
};
const isPdf = (base64) => Buffer.from(base64, 'base64').subarray(0, 5).toString('latin1') === '%PDF-';

test('a full run in Node: resume and cover letter, as DOCX and PDF', async (t) => {
  const mock = await startMockLlm();
  t.after(() => mock.close());

  const result = await runTailorPipeline({
    resumeText: RESUME_TEXT,
    jobDescription: 'Backend engineer, Python and AWS.',
    jobTitle: 'Backend Engineer',
    employer: 'Acme Corp',
    providerId: 'gemini',
    apiKey: FAKE_KEY,
    baseUrlOverride: mock.url,
    includeCoverLetter: true,
    autoDownloadPdf: true,
  }, nodePlatform);

  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  const byKind = Object.fromEntries(result.outputs.map((o) => [o.kind, o]));
  assert.deepEqual(Object.keys(byKind).sort(), ['cover_letter', 'cover_letter_pdf', 'resume', 'resume_pdf']);

  assert.match(byKind.resume.filename, /_Acme_Corp_Resume_\d{4}\.docx$/);
  assert.match(await docxText(byKind.resume.base64), /TAILORED SUMMARY/);
  assert.match(await docxText(byKind.cover_letter.base64), /BODY PARAGRAPH ONE/);
  // The letter's body as plain text, for pasting into application forms.
  assert.equal(result.coverLetter.text, `${CL_PARA_ONE}\n\n${CL_PARA_TWO}`);
  assert.ok(isPdf(byKind.resume_pdf.base64), 'resume PDF has a PDF header');
  assert.ok(isPdf(byKind.cover_letter_pdf.base64), 'cover letter PDF has a PDF header');

  // The one-page check ran against real font metrics, not the word-count fallback.
  assert.equal(typeof result.wordCount, 'number');
  assert.ok(result.llm.calls >= 2, `expected at least resume + letter calls, got ${result.llm.calls}`);
  // Which model wrote what -- names only -- for the API's audit log.
  assert.equal(result.llm.answers.length, result.llm.calls);
  for (const a of result.llm.answers) {
    assert.deepEqual(Object.keys(a).sort(), ['model', 'providerId', 'task']);
    assert.equal(a.providerId, 'gemini');
  }
});

test('a run result never carries the provider key', async (t) => {
  const mock = await startMockLlm();
  t.after(() => mock.close());

  const result = await runTailorPipeline({
    resumeText: RESUME_TEXT,
    jobDescription: 'Backend engineer, Python and AWS.',
    jobTitle: 'Backend Engineer',
    employer: 'Acme Corp',
    providerId: 'gemini',
    apiKey: FAKE_KEY,
    baseUrlOverride: mock.url,
    includeCoverLetter: false,
  }, nodePlatform);

  // The API will return (a summary of) this object over the network, so the
  // whole thing is output -- cooldowns, timings and demotions included.
  const withoutFiles = { ...result, outputs: result.outputs.map(({ base64, ...rest }) => rest) };
  assert.doesNotMatch(JSON.stringify(withoutFiles), new RegExp(FAKE_KEY));
});

test('the Node seams: fonts load, base64 round-trips, a real PDF resume reads', async () => {
  const fonts = await nodePlatform.loadFonts();
  for (const face of ['regular', 'bold', 'italic']) {
    assert.ok(fonts[face] instanceof Uint8Array && fonts[face].length > 10_000, `${face} font loaded`);
  }

  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(new Uint8Array(Buffer.from(await nodePlatform.toBase64(bytes), 'base64')), bytes);

  const pdf = new Uint8Array(readFileSync(path.join(FIXTURES, 'juan-rivera.pdf')));
  const text = await nodePlatform.extractPdfText(pdf);
  assert.match(text, /Rivera/);
  assert.ok(text.split(/\s+/).length > 100, 'extracted a real amount of text');
});

test('a PDF resume goes through the pipeline via the injected extractor', async (t) => {
  const mock = await startMockLlm();
  t.after(() => mock.close());

  const pdf = readFileSync(path.join(FIXTURES, 'juan-rivera.pdf'));
  const result = await runTailorPipeline({
    resumeFileBase64: pdf.toString('base64'),
    resumeFileExt: '.pdf',
    jobDescription: 'Backend engineer, Python and AWS.',
    jobTitle: 'Backend Engineer',
    employer: 'Acme Corp',
    providerId: 'gemini',
    apiKey: FAKE_KEY,
    baseUrlOverride: mock.url,
  }, nodePlatform);

  assert.equal(result.ok, true);
  assert.match(await docxText(result.outputs[0].base64), /Rivera/);
});

// --- a letter that fails must not take the resume with it (opt-in) ---------------

const letterRun = (mock, extra = {}) => runTailorPipeline({
  resumeText: RESUME_TEXT,
  jobDescription: 'Backend engineer, Python and AWS.',
  jobTitle: 'Backend Engineer',
  employer: 'Acme Corp',
  providerId: 'gemini',
  apiKey: FAKE_KEY,
  baseUrlOverride: mock.url,
  includeCoverLetter: true,
  autoDownloadPdf: true,
  ...extra,
}, nodePlatform);

test('by default a failed letter still fails the run -- the extension is unchanged', async (t) => {
  const mock = await startMockLlm({ failLetter: true });
  t.after(() => mock.close());
  await assert.rejects(() => letterRun(mock), (err) => typeof err.kind === 'string');
});

test('keepResumeIfLetterFails: the resume comes back and the letter is marked failed', async (t) => {
  const mock = await startMockLlm({ failLetter: true });
  t.after(() => mock.close());
  const result = await letterRun(mock, { keepResumeIfLetterFails: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outputs.map((o) => o.kind).sort(), ['resume', 'resume_pdf']);
  assert.match(await docxText(result.outputs.find((o) => o.kind === 'resume').base64), /TAILORED SUMMARY/);
  assert.equal(result.coverLetter.status, 'failed');
  assert.equal(result.coverLetter.text, null);
  assert.equal(typeof result.coverLetter.failure.kind, 'string');
  assert.match(result.coverLetter.failure.message, /\S/);
  assert.doesNotMatch(JSON.stringify(result.coverLetter), new RegExp(FAKE_KEY));
});
