// tests/live/smoke.mjs — one real run against a real provider.
//
// Everything else in this repo is mocked, which is correct for a test suite:
// mocks are fast, free and deterministic. But three things this session could
// only be guessed at from mocked runs, and all three turned out to be wrong:
//
//   - whether a truncated response was the model refusing to rewrite, or JSON
//     cut off mid-answer (it was the latter, twice misdiagnosed);
//   - how long the resume pass actually takes (13-25s, vs ~1s for the smaller
//     passes on the same provider);
//   - whether `reasoning_effort` is accepted at all by the provider, and what
//     it does to latency when it is.
//
// This is not part of `npm test`. It costs real quota, it needs a key, and it
// is non-deterministic — so it stays a deliberate, separate command.
//
// THE KEY IS NEVER READ FROM SOURCE, AN ARGUMENT, OR THIS FILE. It comes from
// the environment only, is never printed, and never lands in a commit or a
// transcript:
//
//   PowerShell:  $env:GEMINI_API_KEY = "..."   ; npm run test:live
//   bash:        GEMINI_API_KEY=... npm run test:live
//
// A `.env.local` in the repo root is also read, and is gitignored.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Packer } from 'docx';

import { parseTxt } from '../../extension/engine/parseTxt.js';
import { extractDocxText } from '../../extension/engine/extractDocxText.js';
import { modelWordCount } from '../../extension/engine/resumeModel.js';
import { tailorResume, ONE_PAGE_WORD_BUDGET } from '../../extension/engine/tailor.js';
import { tailorSkills } from '../../extension/engine/tailorSkills.js';
import { generateCoverLetter } from '../../extension/engine/coverLetter.js';
import { judgeTailoredModel } from '../../extension/engine/judge.js';
import { chatWithRotation, cooldownState } from '../../extension/engine/rotatingClient.js';
import { buildResumeDocument } from '../../extension/engine/renderDocx.js';
import { conceptRetentionRatio } from '../../extension/engine/textUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

/** Read KEY=value pairs from a gitignored .env.local, without printing any of them. */
function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvLocal();

const PROVIDER_ENV = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const chain = Object.entries(PROVIDER_ENV)
  .filter(([, envName]) => (process.env[envName] || '').trim())
  .map(([providerId, envName]) => ({ providerId, apiKey: process.env[envName].trim() }));

// LIVE_BASE_URL points every provider at one OpenAI-compatible endpoint. Its
// purpose is to exercise THIS SCRIPT against a local mock, so the harness is
// known to work before a real key is ever involved -- the same escape hatch
// the e2e suite uses, and the same one v4 offered for a self-hosted model.
const baseUrlOverride = process.env.LIVE_BASE_URL || undefined;
if (baseUrlOverride) {
  console.log(`base URL overridden -> ${baseUrlOverride} (harness self-test, not a live provider)`);
  if (!chain.length) chain.push({ providerId: 'gemini', apiKey: 'mock-key' });
}

if (!chain.length) {
  console.error(
    'No provider key found in the environment.\n\n'
    + '  PowerShell:  $env:GEMINI_API_KEY = "your-key"; npm run test:live\n'
    + '  bash:        GEMINI_API_KEY=your-key npm run test:live\n\n'
    + `Or put GEMINI_API_KEY=your-key in ${path.join(ROOT, '.env.local')} (gitignored).\n`
    + 'The key is read from the environment only — never from a command argument,\n'
    + 'which would put it in your shell history.',
  );
  process.exit(1);
}
console.log(`providers configured: ${chain.map((c) => c.providerId).join(', ')}\n`);

// --- inputs -----------------------------------------------------------------

const RESUME_PATH = process.env.LIVE_RESUME
  || path.join(ROOT, 'tests/fixtures/resumes/juan-rivera-tabstops.docx');

const JOB = {
  title: 'IT Support Specialist',
  company: 'Northwind Managed Services',
  description: `We are hiring an IT Support Specialist for a managed services provider serving
small and mid-sized businesses across Ontario. You will be the first point of contact for client
issues, triaging tickets, escalating where needed, and documenting resolutions.

Responsibilities: monitor and respond to alerts; administer Microsoft 365 including Exchange and
SharePoint; manage endpoints; maintain accurate asset and licence records; track incidents against
SLA targets; produce clear written documentation for both clients and internal teams; coordinate
with vendors on procurement and warranty claims.

Requirements: strong written and verbal communication; meticulous record keeping and attention to
detail; comfort working with numbers, budgets and reporting; ability to prioritise a queue under
pressure; bilingual English/Spanish an asset. Experience with financial reporting or audit
processes is valued for our finance-sector clients.`,
};

// --- instrumented caller ----------------------------------------------------

const llm = { calls: 0, ms: 0, finishReasons: [], models: [] };
const callLlm = async (opts) => {
  const started = Date.now();
  try {
    const response = await chatWithRotation({ chain, baseUrlOverride, ...opts });
    llm.finishReasons.push(response.finishReason || 'stop');
    llm.models.push(response.model);
    return response;
  } finally {
    llm.calls += 1;
    llm.ms += Date.now() - started;
  }
};

const timings = {};
async function timed(label, fn) {
  const started = Date.now();
  const before = llm.calls;
  try {
    return await fn();
  } finally {
    timings[label] = { ms: Date.now() - started, calls: llm.calls - before };
  }
}

// --- run --------------------------------------------------------------------

const source = RESUME_PATH.endsWith('.docx')
  ? await extractDocxText(readFileSync(RESUME_PATH))
  : readFileSync(RESUME_PATH, 'utf8');
const model = parseTxt(source);
console.log(`resume: ${path.basename(RESUME_PATH)} — ${modelWordCount(model)} words, `
  + `${model.sections.filter((s) => s.entries).flatMap((s) => s.entries).length} roles\n`);

const runStarted = Date.now();

const resume = await timed('resume', () => tailorResume({
  model,
  jobDescription: JOB.description,
  callLlm,
  judge: (args) => judgeTailoredModel({ ...args, callLlm }),
  job: JOB,
}));

let skills = { status: 'no_change', reverted: [] };
if (resume.model.skills && resume.model.skills.lines.length) {
  const out = await timed('skills', () => tailorSkills({
    skillsLines: resume.model.skills.lines, job: JOB, callLlm,
  }));
  resume.model.skills = { ...resume.model.skills, lines: out.lines };
  skills = out.report;
}

const letter = await timed('letter', () => generateCoverLetter({
  model: resume.model, job: JOB, callLlm,
}));

const docx = await Packer.toBuffer(buildResumeDocument(resume.model));
const outPath = path.join(ROOT, 'tests/live/last-run.docx');
writeFileSync(outPath, docx);

const totalMs = Date.now() - runStarted;

// --- report -----------------------------------------------------------------

const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
console.log('=== timing ===');
line('total', `${(totalMs / 1000).toFixed(1)}s`);
line('in LLM calls', `${(llm.ms / 1000).toFixed(1)}s across ${llm.calls} calls`);
for (const [k, v] of Object.entries(timings)) {
  line(k, `${(v.ms / 1000).toFixed(1)}s (${v.calls} call${v.calls === 1 ? '' : 's'})`);
}

console.log('\n=== the questions mocks could not answer ===');
line('finish reasons', llm.finishReasons.join(', ') || '(none)');
line('any truncation?', llm.finishReasons.includes('length') ? 'YES — raise the ceiling' : 'no');
line('models used', [...new Set(llm.models)].join(', '));
line('cooldowns triggered', Object.keys(cooldownState()).join(', ') || 'none');

console.log('\n=== output quality ===');
line('resume status', resume.report.status);
line('word count', `${resume.wordCount} (budget ${ONE_PAGE_WORD_BUDGET})`);
line('compaction iterations', resume.compactionIterations);
line('skills status', skills.status);
line('cover letter status', letter.report.status);

const before = model.sections.filter((s) => s.entries).flatMap((s) => s.entries);
const after = resume.model.sections.filter((s) => s.entries).flatMap((s) => s.entries);
line('concreteness retention', before.map((e, i) => {
  const r = conceptRetentionRatio(e.bullets.join(' '), (after[i]?.bullets || []).join(' '));
  return `${Math.round(r * 100)}%`;
}).join(' '));

const issues = [
  ...(resume.report.validator?.errors || []).map((e) => `ERROR  ${e}`),
  ...(resume.report.validator?.warnings || []).map((w) => `warn   ${w}`),
  ...(resume.report.judge?.issues || []).map((j) => `judge  ${j}`),
];
if (issues.length) {
  console.log('\n=== findings ===');
  for (const i of issues) console.log(`  ${i}`);
}

console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
