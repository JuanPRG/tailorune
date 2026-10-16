// api.test.mjs — M3 of docs/AGENT_API_PLAN.md: the HTTP API core.
//
// Everything goes through the app's one (Request) -> Response handler, the
// same function Vercel will run, with storage in a temp directory. Two kinds
// of pipeline stand behind it:
//
//   - the REAL pipeline against a local OpenAI-compatible mock, for the
//     paths an agent takes end to end (upload, run, poll, download);
//   - a scripted fake, for what a mock model cannot stage on demand: an
//     outage on the first attempt, a run that never finishes, a hard failure.
//
// What is pinned, in contract order: auth (hashed token, kill switch),
// resumes, runs (async, wait, cache, retry), files, audit, retention, rate
// limit -- and that neither the token nor a provider key ever comes back out.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../server/app.mjs';
import { createBlobStore } from '../../server/store/blobStore.mjs';
import { fakeBlobClient } from './helpers/fakeBlobClient.mjs';
import { sha256Hex } from '../../server/http/auth.mjs';
import { LlmError } from '../../extension/engine/llm.js';
import { resetCooldowns } from '../../extension/engine/rotatingClient.js';
import { resetRateWindows } from '../../extension/engine/rateWindow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, '../fixtures/resumes');
const RESUME_TXT = readFileSync(path.join(FIXTURES, 'juan-rivera-full.txt'), 'utf8');
const RESUME_PDF = readFileSync(path.join(FIXTURES, 'juan-rivera.pdf'));

const TOKEN = 'tk_test_0123456789abcdefghijklmnopqrstuvwxyz';
const FAKE_KEY = 'AIzaFAKE-api-test-key-0123456789abcdef';
const BASE = 'https://api.example';
const HOUR = 3_600_000;

beforeEach(() => { resetCooldowns(); resetRateWindows(); });

// --- harness -------------------------------------------------------------------

function startMockLlm() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const isCoverLetter = body.includes('cover letter') || body.includes('no sign-off');
      const content = isCoverLetter
        ? `Para one. ${Array(130).fill('word').join(' ')}\n\nPara two. ${Array(130).fill('word').join(' ')}`
        : JSON.stringify({ summary: 'TAILORED SUMMARY.', entries: [{ index: 0, bullets: ['R1.'] }] });
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

/** A result shaped like runTailorPipeline's, for the scripted fake. */
const fakeResult = () => ({
  ok: true,
  outputs: [
    { kind: 'resume', filename: 'Juan_Rivera_Acme_Resume_1016.docx', base64: Buffer.from('DOCX-BYTES').toString('base64') },
    { kind: 'resume_pdf', filename: 'Juan_Rivera_Acme_Resume_1016.pdf', base64: Buffer.from('%PDF-1.7 fake').toString('base64') },
  ],
  wordCount: 470,
  resumeStatus: 'approved',
  resumeWarnings: [],
  resumeErrors: [],
  resumeJudge: null,
  skills: { status: 'approved' },
  coverLetter: { status: 'approved', text: 'Para one.\n\nPara two.', wordCount: 250, warnings: [], errors: [] },
  cooldowns: [],
  timings: {},
  llm: { calls: 3, ms: 12_000, demotions: [], answers: [{ task: 'resume', providerId: 'gemini', model: 'gemini-x' }] },
});

const unavailable = (retryAfterSeconds = 30) => new LlmError(
  'providers_temporarily_unavailable',
  `Configured LLM providers are temporarily unavailable for this task. Retry in about ${retryAfterSeconds}s.`,
  { attempts: [], retryAfterSeconds },
);

/**
 * Builds an app over a fresh temp directory. `script` replaces the pipeline:
 * an array of (payload) => result | throw, consumed one call at a time.
 */
function makeApp(t, { llmUrl, script, env = {}, maxConcurrent, blob = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: Date.parse('2026-10-16T12:00:00Z') };
  const sleeps = [];
  const logs = [];
  const calls = [];
  const runPipeline = script
    ? async (payload) => {
      calls.push(payload);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      return step(payload);
    }
    : undefined;
  const app = createApp({
    dataDir: dir,
    env: {
      TAILORUNE_API_TOKEN_SHA256: sha256Hex(TOKEN),
      GEMINI_API_KEY: FAKE_KEY,
      ...(llmUrl ? { TAILORUNE_LLM_BASE_URL: llmUrl } : {}),
      ...env,
    },
    now: () => clock.ms,
    sleep: async (ms) => { sleeps.push(ms); },
    log: (entry) => logs.push(JSON.stringify(entry)),
    ...(runPipeline ? { runPipeline } : {}),
    ...(maxConcurrent ? { maxConcurrent } : {}),
    ...(blob ? { store: createBlobStore({ client: fakeBlobClient(clock) }) } : {}),
  });
  const call = async (method, urlPath, { body, token = TOKEN, raw } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.handle(new Request(`${BASE}${urlPath}`, {
      method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
    }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary or empty */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  return { app, call, clock, sleeps, logs, calls, dir };
}

const uploadTxt = (call) => call('POST', '/v1/resumes', { body: { filename: 'juan.txt', text: RESUME_TXT } });
const runBody = (resumeId, extra = {}) => ({
  resume_id: resumeId,
  job_title: 'Backend Engineer',
  employer: 'Acme Corp',
  job_text: 'Backend engineer, Python and AWS.',
  ...extra,
});

// --- auth ----------------------------------------------------------------------

test('the OpenAPI document is public and lists every operation', async (t) => {
  const { call } = makeApp(t);
  const res = await call('GET', '/openapi.json', { token: null });
  assert.equal(res.status, 200);
  assert.equal(res.json.servers[0].url, BASE);
  for (const p of ['/v1/resumes', '/v1/resumes/{resume_id}', '/v1/runs', '/v1/runs/{run_id}',
    '/v1/runs/{run_id}/audit', '/v1/files/{file_token}']) {
    assert.ok(res.json.paths[p], `documents ${p}`);
  }
});

test('the token is checked against its SHA-256 hash: wrong or missing is 401', async (t) => {
  const { call } = makeApp(t);
  assert.equal((await call('GET', '/v1/resumes', { token: null })).status, 401);
  assert.equal((await call('GET', '/v1/resumes', { token: `${TOKEN}x` })).status, 401);
  assert.equal((await call('GET', '/v1/resumes', { token: sha256Hex(TOKEN) })).status, 401, 'the hash itself is not a token');
  assert.equal((await call('GET', '/v1/resumes')).status, 200);
});

test('fails closed: no hash configured, or the kill switch on, is 503', async (t) => {
  const noHash = makeApp(t, { env: { TAILORUNE_API_TOKEN_SHA256: '' } });
  assert.equal((await noHash.call('GET', '/v1/resumes')).status, 503);
  const killed = makeApp(t, { env: { API_DISABLED: '1' } });
  assert.equal((await killed.call('GET', '/v1/resumes')).status, 503);
});

// --- resumes -------------------------------------------------------------------

test('a resume is uploaded once, listed, and deleted', async (t) => {
  const { call } = makeApp(t);
  const up = await uploadTxt(call);
  assert.equal(up.status, 201);
  assert.match(up.json.data.resume_id, /^res_/);
  assert.equal(up.json.data.name, 'juan.txt');
  assert.ok(up.json.data.word_count > 100);

  const list = await call('GET', '/v1/resumes');
  assert.deepEqual(list.json.data.map((r) => r.resume_id), [up.json.data.resume_id]);
  assert.equal(list.json.data[0].text, undefined, 'the list does not carry resume text');

  assert.equal((await call('DELETE', `/v1/resumes/${up.json.data.resume_id}`)).status, 204);
  assert.equal((await call('GET', '/v1/resumes')).json.data.length, 0);
  assert.equal((await call('DELETE', `/v1/resumes/${up.json.data.resume_id}`)).status, 404);
});

test('a PDF resume is read to text at upload', async (t) => {
  const { call } = makeApp(t);
  const up = await call('POST', '/v1/resumes', {
    body: { filename: 'juan.pdf', content_base64: RESUME_PDF.toString('base64') },
  });
  assert.equal(up.status, 201, up.text);
  assert.ok(up.json.data.word_count > 100);
});

test('resume uploads are validated: type, size, emptiness, unknown fields', async (t) => {
  const { call } = makeApp(t);
  const exe = await call('POST', '/v1/resumes', { body: { filename: 'x.exe', content_base64: 'AAAA' } });
  assert.equal(exe.status, 400);
  const big = await call('POST', '/v1/resumes', { body: { filename: 'x.txt', text: 'a '.repeat(1_200_000) } });
  assert.equal(big.status, 413);
  const empty = await call('POST', '/v1/resumes', { body: { filename: 'x.txt', text: '   ' } });
  assert.equal(empty.status, 400);
  const extra = await call('POST', '/v1/resumes', { body: { filename: 'x.txt', text: 'hi', owner: 'me' } });
  assert.equal(extra.status, 400);
  assert.match(extra.json.error, /owner/);
  const notJson = await call('POST', '/v1/resumes', { body: '{nope', raw: true });
  assert.equal(notJson.status, 400);
});

// --- runs ----------------------------------------------------------------------

test('end to end with the real pipeline: 202, poll, done, download', async (t) => {
  const mock = await startMockLlm();
  t.after(() => mock.close());
  const { app, call } = makeApp(t, { llmUrl: mock.url });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;

  const created = await call('POST', '/v1/runs', { body: runBody(resumeId) });
  assert.equal(created.status, 202, created.text);
  assert.match(created.json.data.run_id, /^run_/);
  assert.ok(['queued', 'running'].includes(created.json.data.status));

  await app.runner.idle();
  const done = await call('GET', `/v1/runs/${created.json.data.run_id}`);
  assert.equal(done.json.data.status, 'done', done.text);
  const result = done.json.data.result;
  assert.equal(result.job.employer, 'Acme Corp');
  assert.match(result.cover_letter_text, /^Para one\./);
  assert.equal(result.files.length, 4);
  for (const f of result.files) assert.match(f.url, /^https:\/\/api\.example\/v1\/files\/[A-Za-z0-9_-]{32,}$/);
  assert.equal(result.files[0].content_base64, undefined, 'links by default');

  const resumeFile = result.files.find((f) => f.kind === 'resume');
  const filePath = new URL(resumeFile.url).pathname;
  const dl = await call('GET', filePath);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /officedocument/);
  assert.match(dl.headers.get('content-disposition'), new RegExp(resumeFile.name));
  assert.equal((await call('GET', filePath, { token: null })).status, 401, 'files need the token too');
});

test('wait= returns the finished run inline, and ?inline=base64 carries the bytes', async (t) => {
  const { call } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const res = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.status, 'done');

  const inline = await call('GET', `/v1/runs/${res.json.data.run_id}?inline=base64`);
  const docx = inline.json.data.result.files.find((f) => f.kind === 'resume');
  assert.equal(Buffer.from(docx.content_base64, 'base64').toString(), 'DOCX-BYTES');
});

test('constraints reach the pipeline as validated preferences; unknown keys are 400', async (t) => {
  const { call, calls } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;

  const bad = await call('POST', '/v1/runs', { body: runBody(resumeId, { constraints: { invent_freely: true } }) });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /invent_freely/);

  const ok = await call('POST', '/v1/runs', {
    body: runBody(resumeId, { wait: 30, constraints: { resume_notes: 'Never claim people management.', cover_letter_tone: 'warm' } }),
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(calls.at(-1).preferences.resume_notes, 'Never claim people management.');
  assert.equal(calls.at(-1).preferences.cover_letter_tone, 'warm');
  assert.equal(calls.at(-1).resumeText.includes('Rivera'), true, 'the stored text is what gets tailored');
});

test('run requests are validated: unknown fields, missing resume, job_url not yet', async (t) => {
  const { call } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  assert.equal((await call('POST', '/v1/runs', { body: runBody(resumeId, { model: 'grok' }) })).status, 400);
  assert.equal((await call('POST', '/v1/runs', { body: runBody('res_doesnotexist000') })).status, 404);
  const { job_text: _omit, ...noJob } = runBody(resumeId);
  assert.equal((await call('POST', '/v1/runs', { body: noJob })).status, 400);
  const url = await call('POST', '/v1/runs', { body: { ...noJob, job_url: 'https://jobs.example/1' } });
  assert.equal(url.status, 501);
  assert.equal((await call('GET', '/v1/runs/run_doesnotexist000')).status, 404);
});

test('the same request again returns the cached run, without another pipeline call', async (t) => {
  const { call, calls } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const first = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  const second = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  assert.equal(second.status, 200);
  assert.equal(second.json.data.run_id, first.json.data.run_id);
  assert.equal(second.json.data.result.cached, true);
  assert.equal(calls.length, 1);

  const different = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30, employer: 'Other Co' }) });
  assert.notEqual(different.json.data.run_id, first.json.data.run_id);
  assert.equal(calls.length, 2);
});

test('an outage is retried once after the suggested wait, then succeeds', async (t) => {
  const { call, sleeps, calls } = makeApp(t, {
    script: [() => { throw unavailable(30); }, () => fakeResult()],
  });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const res = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 120 }) });
  assert.equal(res.json.data.status, 'done', res.text);
  assert.equal(res.json.data.attempts, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [30_000]);
});

test('a second outage, or a non-retryable failure, ends the run as failed', async (t) => {
  const twice = makeApp(t, { script: [() => { throw unavailable(5); }] });
  const r1 = (await uploadTxt(twice.call)).json.data.resume_id;
  const failed = await twice.call('POST', '/v1/runs', { body: runBody(r1, { wait: 120 }) });
  assert.equal(failed.json.data.status, 'failed');
  assert.equal(failed.json.data.attempts, 2);
  assert.equal(failed.json.data.error.kind, 'providers_temporarily_unavailable');

  const config = makeApp(t, {
    script: [() => { throw new LlmError('provider_configuration_error', `Providers rejected key ${FAKE_KEY}.`, {}); }],
  });
  const r2 = (await uploadTxt(config.call)).json.data.resume_id;
  const hard = await config.call('POST', '/v1/runs', { body: runBody(r2, { wait: 120 }) });
  assert.equal(hard.json.data.status, 'failed');
  assert.equal(hard.json.data.attempts, 1, 'a bad key is not retried');
  assert.doesNotMatch(hard.text, new RegExp(FAKE_KEY), 'the key is redacted from the error');
  assert.deepEqual(config.sleeps, []);
});

test('at most N runs execute at once; the rest wait their turn', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let active = 0;
  let peak = 0;
  const { app, call } = makeApp(t, {
    maxConcurrent: 2,
    script: [async () => {
      active += 1; peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return fakeResult();
    }],
  });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const ids = [];
  for (const employer of ['A', 'B', 'C']) {
    ids.push((await call('POST', '/v1/runs', { body: runBody(resumeId, { employer }) })).json.data.run_id);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal((await call('GET', `/v1/runs/${ids[2]}`)).json.data.status, 'queued');
  release();
  await app.runner.idle();
  assert.equal(peak, 2);
  for (const id of ids) assert.equal((await call('GET', `/v1/runs/${id}`)).json.data.status, 'done');
});

test('runs per day are capped; cached answers do not count', async (t) => {
  const { call } = makeApp(t, { script: [() => fakeResult()], env: { TAILORUNE_MAX_RUNS_PER_DAY: '2' } });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  assert.equal((await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30, employer: 'A' }) })).status, 200);
  assert.equal((await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30, employer: 'B' }) })).status, 200);
  assert.equal((await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30, employer: 'A' }) })).status, 200, 'cached');
  const over = await call('POST', '/v1/runs', { body: runBody(resumeId, { employer: 'C' }) });
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
});

// --- audit and retention --------------------------------------------------------

test('the audit record keeps what was generated, from what, by which model', async (t) => {
  const { call } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const runId = (await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) })).json.data.run_id;

  const audit = await call('GET', `/v1/runs/${runId}/audit`);
  assert.equal(audit.status, 200);
  const a = audit.json.data;
  assert.equal(a.inputs.resume_id, resumeId);
  assert.match(a.inputs.resume_sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.inputs.job_text, 'Backend engineer, Python and AWS.');
  assert.equal(a.outputs.cover_letter_text, 'Para one.\n\nPara two.');
  assert.equal(Buffer.from(a.outputs.files[0].content_base64, 'base64').toString(), 'DOCX-BYTES');
  assert.deepEqual(a.models, [{ task: 'resume', providerId: 'gemini', model: 'gemini-x' }]);
  assert.equal(a.reports.resume.status, 'approved');
  assert.equal(Date.parse(a.expires_at) - Date.parse(a.created_at), 365 * 24 * HOUR);
});

test('deleting a resume deletes its audit records too', async (t) => {
  const { call } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const runId = (await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) })).json.data.run_id;
  await call('DELETE', `/v1/resumes/${resumeId}`);
  assert.equal((await call('GET', `/v1/runs/${runId}/audit`)).status, 404);
});

test('files expire after 24 hours; a fresh run is made rather than a dead cache hit', async (t) => {
  const { call, clock, calls } = makeApp(t, { script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const run = (await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) })).json.data;
  const filePath = new URL(run.result.files[0].url).pathname;

  clock.ms += 25 * HOUR;
  assert.equal((await call('GET', filePath)).status, 404);
  const again = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  assert.notEqual(again.json.data.run_id, run.run_id);
  assert.equal(calls.length, 2);
});

test('the API runs unchanged on the Blob store: upload, run, cache, download, delete', async (t) => {
  const { call } = makeApp(t, { blob: true, script: [() => fakeResult()] });
  const resumeId = (await uploadTxt(call)).json.data.resume_id;
  const run = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  assert.equal(run.json.data.status, 'done', run.text);
  const again = await call('POST', '/v1/runs', { body: runBody(resumeId, { wait: 30 }) });
  assert.equal(again.json.data.result.cached, true);

  const filePath = new URL(run.json.data.result.files[0].url).pathname;
  const dl = await call('GET', filePath);
  assert.equal(dl.status, 200);
  assert.equal(dl.text, 'DOCX-BYTES');

  assert.equal((await call('DELETE', `/v1/resumes/${resumeId}`)).status, 204);
  assert.equal((await call('GET', filePath)).status, 404, 'the files went with the resume');
});

// --- nothing secret comes back out ------------------------------------------------

test('no response, audit record or log line contains the token or a provider key', async (t) => {
  const mock = await startMockLlm();
  t.after(() => mock.close());
  const { app, call, logs, dir } = makeApp(t, { llmUrl: mock.url });
  const bodies = [];
  const record = async (...args) => { const r = await call(...args); bodies.push(r.text); return r; };

  const resumeId = (await record('POST', '/v1/resumes', { body: { filename: 'j.txt', text: RESUME_TXT } })).json.data.resume_id;
  const runId = (await record('POST', '/v1/runs', { body: runBody(resumeId) })).json.data.run_id;
  await app.runner.idle();
  await record('GET', `/v1/runs/${runId}`);
  await record('GET', `/v1/runs/${runId}/audit`);
  await record('GET', '/v1/resumes');
  await record('GET', '/v1/nope');

  const everything = [...bodies, ...logs].join('\n');
  for (const secret of [TOKEN, FAKE_KEY]) assert.doesNotMatch(everything, new RegExp(secret));
  assert.ok(logs.length >= 6, 'requests are logged');
  for (const line of logs) assert.doesNotMatch(line, /Backend engineer, Python/, 'no job text in logs');

  // And nothing on disk holds them either.
  const { readdirSync, statSync } = await import('node:fs');
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = path.join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'latin1');
    assert.ok(!text.includes(TOKEN) && !text.includes(FAKE_KEY), `${path.basename(file)} holds no secret`);
  }
});
