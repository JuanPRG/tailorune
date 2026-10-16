// cli.test.mjs — M2 of docs/AGENT_API_PLAN.md: `node server/cli.mjs tailor ...`.
//
// The CLI is the first real consumer of engine/pipeline.js outside Chrome,
// and the first that an agent (or you) can run. What it prints is what an
// agent reads, so it is pinned twice over: it must be small (no file bytes,
// no internals), and it must never contain a key.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliArgs, summarizeRun, UsageError } from '../../server/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'server/cli.mjs');
const RESUME = path.join(ROOT, 'tests/fixtures/resumes/juan-rivera-full.txt');
const FAKE_KEY = 'AIzaFAKE-cli-test-key-0123456789abcdef';

const BASE_ARGS = ['tailor', '--resume', RESUME, '--title', 'Backend Engineer', '--employer', 'Acme Corp'];

// --- argument parsing ----------------------------------------------------------

test('a complete tailor command parses, with PDFs and a cover letter by default', () => {
  const { command, options } = parseCliArgs([...BASE_ARGS, '--job-text', 'Python and AWS.']);
  assert.equal(command, 'tailor');
  assert.equal(options.resume, RESUME);
  assert.equal(options.jobText, 'Python and AWS.');
  assert.equal(options.coverLetter, true);
  assert.equal(options.pdf, true);
  assert.equal(options.judge, false);
});

test('--no-cover, --no-pdf and --judge flip their defaults', () => {
  const { options } = parseCliArgs([...BASE_ARGS, '--job-text', 'x', '--no-cover', '--no-pdf', '--judge']);
  assert.equal(options.coverLetter, false);
  assert.equal(options.pdf, false);
  assert.equal(options.judge, true);
});

test('missing required options are usage errors that name the option', () => {
  for (const drop of ['--resume', '--title', '--employer']) {
    const i = BASE_ARGS.indexOf(drop);
    const argv = [...BASE_ARGS.slice(0, i), ...BASE_ARGS.slice(i + 2), '--job-text', 'x'];
    assert.throws(() => parseCliArgs(argv), (err) => err instanceof UsageError && err.message.includes(drop));
  }
});

test('exactly one job source: text or file', () => {
  assert.throws(() => parseCliArgs(BASE_ARGS), UsageError);
  assert.throws(() => parseCliArgs([...BASE_ARGS, '--job-text', 'x', '--job-file', 'y.txt']), UsageError);
});

test('--job-url says it is not built yet, rather than failing obscurely', () => {
  assert.throws(
    () => parseCliArgs([...BASE_ARGS, '--job-url', 'https://example.com/job']),
    (err) => err instanceof UsageError && /M4/.test(err.message),
  );
});

test('a key is never accepted as an argument -- it would land in shell history', () => {
  assert.throws(
    () => parseCliArgs([...BASE_ARGS, '--job-text', 'x', '--api-key', FAKE_KEY]),
    (err) => err instanceof UsageError && /environment/.test(err.message) && !err.message.includes(FAKE_KEY),
  );
});

test('unknown commands and flags are usage errors', () => {
  assert.throws(() => parseCliArgs(['frobnicate']), UsageError);
  assert.throws(() => parseCliArgs([...BASE_ARGS, '--job-text', 'x', '--bogus']), UsageError);
});

// --- the summary an agent reads ------------------------------------------------

const fakeResult = () => ({
  ok: true,
  outputs: [{ kind: 'resume', filename: 'A_Resume.docx', base64: 'UEsDBA==' }],
  wordCount: 480,
  compactionIterations: 1,
  resumeStatus: 'ok',
  resumeWarnings: ['w1'],
  resumeErrors: [],
  resumeJudge: null,
  skills: { status: 'no_change', attempts: 0, reverted: [] },
  coverLetter: {
    status: 'ok', text: 'Para one.\n\nPara two.', wordCount: 250, warnings: [], errors: [],
    pdfBase64: 'JVBERi0=', pdfFilename: 'A_Cover.pdf',
  },
  // Internals that must not leak into the summary.
  cooldowns: [{ key: `gemini::model::${FAKE_KEY}` }],
  timings: { resume: { ms: 12_340, calls: 2 }, coverLetter: { ms: 2_100, calls: 1 } },
  llm: { calls: 3, ms: 14_440, demotions: [] },
});

test('the summary is small: no file bytes, no cooldown internals', () => {
  const summary = summarizeRun(fakeResult(), {
    job: { title: 'Backend Engineer', employer: 'Acme Corp' },
    files: [{ kind: 'resume', name: 'A_Resume.docx', path: '/out/A_Resume.docx' }],
  });
  assert.equal(summary.status, 'done');
  assert.deepEqual(summary.resume, { status: 'ok', word_count: 480, warnings: ['w1'], errors: [] });
  assert.equal(summary.cover_letter_text, 'Para one.\n\nPara two.');
  assert.deepEqual(summary.llm, { calls: 3, seconds: 14.4 });
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /UEsDBA|JVBERi0/, 'no file bytes');
  assert.doesNotMatch(text, new RegExp(FAKE_KEY), 'no key');
  assert.equal(summary.cooldowns, undefined);
});

test('without a cover letter, the letter fields are null rather than missing', () => {
  const summary = summarizeRun({ ...fakeResult(), coverLetter: null }, { job: {}, files: [] });
  assert.equal(summary.cover_letter, null);
  assert.equal(summary.cover_letter_text, null);
});

// --- the real thing, as a child process -----------------------------------------

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

/** Runs the CLI with a clean environment: no inherited keys, no env files. */
function runCli(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        TAILORUNE_SKIP_ENV_FILES: '1',
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('end to end: four files on disk, a JSON summary on stdout, no key anywhere', async (t) => {
  const mock = await startMockLlm();
  const out = mkdtempSync(path.join(os.tmpdir(), 'tailorune-cli-'));
  t.after(async () => { await mock.close(); rmSync(out, { recursive: true, force: true }); });

  const { code, stdout, stderr } = await runCli(
    [...BASE_ARGS, '--job-text', 'Backend engineer, Python and AWS.', '--out', out],
    { GEMINI_API_KEY: FAKE_KEY, TAILORUNE_LLM_BASE_URL: mock.url },
  );

  assert.equal(code, 0, `stderr: ${stderr}`);
  const summary = JSON.parse(stdout);
  assert.equal(summary.status, 'done');
  assert.equal(summary.files.length, 4);
  assert.deepEqual(readdirSync(out).sort(), summary.files.map((f) => f.name).sort());
  assert.match(summary.cover_letter_text, /^Para one\./);
  assert.doesNotMatch(stdout + stderr, new RegExp(FAKE_KEY));
});

test('constraints come from a JSON file and are validated before any model call', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-cli-c-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'constraints.json');
  writeFileSync(bad, JSON.stringify({ resume_notes: 'ok', invent_things: true }));

  const { code, stderr } = await runCli(
    [...BASE_ARGS, '--job-text', 'x', '--constraints', bad],
    { GEMINI_API_KEY: FAKE_KEY, TAILORUNE_LLM_BASE_URL: 'http://127.0.0.1:9/v1' },
  );
  assert.equal(code, 2);
  assert.match(stderr, /invent_things/);
});

test('no provider key: exit 2 with instructions, not a stack trace', async () => {
  const { code, stdout, stderr } = await runCli([...BASE_ARGS, '--job-text', 'x'], {});
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /GEMINI_API_KEY/);
  assert.doesNotMatch(stderr, /at .*\.mjs:\d+/, 'no stack trace');
});
