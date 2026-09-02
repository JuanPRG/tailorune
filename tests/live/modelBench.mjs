// tests/live/modelBench.mjs — score candidate models on the REAL workload.
//
// WHY THIS IS A COMMITTED TOOL AND NOT A ONE-OFF SCRIPT. Models churn. Groq
// deprecated qwen/qwen3.6-27b -- second in the resume chain, first in the
// judge chain -- with twelve days' notice. OpenRouter withdrew
// inclusionai/ling-3.0-flash:free from its free tier. Cerebras' catalogue is
// down to two models. Every one of those was discovered by accident.
//
// The rotation is only "battle-tested" for as long as someone re-tests it, so
// the test is the artefact worth keeping.
//
// WHAT IT MEASURES. Not "does the model reply" -- that is what a /models
// listing already tells you. It runs the ACTUAL resume-tailoring pass against
// a real fixture and reports what the pipeline cares about:
//
//   status       what tailorResume concluded (approved / fallback / malformed)
//   seconds      wall clock, which is most of the user's perceived cost
//   retention    concreteness carried over from the original bullets
//   truncated    did it run out of tokens mid-JSON
//
// A model that answers in 400ms but drops every number is worse than one that
// takes four seconds and keeps them, and only the real workload shows that.
//
// Usage:
//   npm run bench:models                 # the default candidate set
//   npm run bench:models -- gemini       # only models on one provider
//   npm run bench:models -- --all-free   # every OpenRouter :free model too

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { loadEnvFiles, buildChain, NO_KEYS_MESSAGE, ROOT } from './liveEnv.mjs';
import { PROVIDERS } from '../../extension/engine/providers.js';
import { chatWithRotation, resetCooldowns } from '../../extension/engine/rotatingClient.js';
import { resetRateWindows } from '../../extension/engine/rateWindow.js';
import { resetReasoningEffortSupport } from '../../extension/engine/llm.js';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { extractDocxText } from '../../extension/engine/extractDocxText.js';
import { tailorResume } from '../../extension/engine/tailor.js';
import { conceptRetentionRatio } from '../../extension/engine/textUtils.js';

loadEnvFiles();
const chain = buildChain();
if (!chain.length) { console.error(NO_KEYS_MESSAGE); process.exit(1); }
const keyFor = Object.fromEntries(chain.map((c) => [c.providerId, c.apiKey]));

// Candidates, by provider. Deliberately a short list rather than every model a
// provider offers: each entry costs a real tailoring pass, and most of a
// catalogue is embeddings, audio and image models that cannot do this job.
const CANDIDATES = {
  gemini: [
    'gemini-3.1-flash-lite',   // current chain leader, the baseline to beat
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-2.5-flash',        // current chain #5
  ],
  groq: [
    'qwen/qwen3.8-27b',        // the replacement for the deprecated qwen3.6-27b
    'openai/gpt-oss-120b',     // current chain #3
    'openai/gpt-oss-20b',      // current chain #6
  ],
  cerebras: [
    'gpt-oss-120b',
    'gemma-4-31b',
  ],
  openrouter: [
    'z-ai/glm-5.2:free',
    'google/gemma-4-31b-it:free',
    'minimax/minimax-m2.7:free',
    'nvidia/nemotron-3.5-lightning:free',
    'inclusionai/ling-3.0-flash-fin:free',
  ],
};

const args = process.argv.slice(2);
const wantAllFree = args.includes('--all-free');
// Retention varies run to run -- these are language models, not pure
// functions. Reordering a battle-tested chain on ONE sample is how you mistake
// noise for a finding, so the tool can repeat and report the spread.
const repeatArg = args.find((a) => a.startsWith('--repeat='));
const REPEATS = repeatArg ? Math.max(1, Number(repeatArg.split('=')[1]) || 1) : 1;
const onlyArg = args.find((a) => a.startsWith('--models='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',').map((m) => m.trim()) : null;
const providerFilter = args.filter((a) => !a.startsWith('--'));

const FIXTURE = path.join(ROOT, 'tests/fixtures/resumes/juan-rivera-tabstops.docx');
const JOB = 'Senior Financial Analyst. You will own budgeting, forecasting and month-end close, '
  + 'build cash-flow models, and report under IFRS. Strong Excel required; experience coordinating '
  + 'cross-functional teams and improving reporting cycle times is valued.';

const resumeText = await extractDocxText(readFileSync(FIXTURE));
const baseModel = parseTxt(resumeText);
const originalBullets = (baseModel.sections || [])
  .flatMap((s) => (s.entries || []).flatMap((e) => e.bullets || []));

if (wantAllFree && keyFor.openrouter) {
  const r = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${keyFor.openrouter}` },
  });
  const { data } = await r.json();
  CANDIDATES.openrouter = data.filter((m) => m.id.endsWith(':free')).map((m) => m.id).sort();
}

const targets = Object.entries(CANDIDATES)
  .filter(([id]) => keyFor[id] && (!providerFilter.length || providerFilter.includes(id)))
  .flatMap(([id, models]) => models.map((model) => ({ providerId: id, model })))
  .filter((t) => !ONLY || ONLY.includes(t.model));

if (!targets.length) {
  console.error(`No candidates. Configured providers: ${Object.keys(keyFor).join(', ') || 'none'}`);
  process.exit(1);
}

console.log(`benchmarking ${targets.length} models on the real resume pass`);
console.log(`fixture: ${path.basename(FIXTURE)} — ${originalBullets.length} bullets\n`);
console.log(`  ${'model'.padEnd(40)} ${'status'.padEnd(24)} ${'secs'.padStart(6)} ${'keep'.padStart(5)}  notes`);
console.log(`  ${'-'.repeat(40)} ${'-'.repeat(24)} ${'-'.repeat(6)} ${'-'.repeat(5)}  -----`);

const results = [];
for (const { providerId, model } of targets) {
 for (let run = 0; run < REPEATS; run++) {
  resetCooldowns(); resetRateWindows(); resetReasoningEffortSupport();

  // Pinned to exactly this model: no fallback, so a failure is attributable.
  const pinned = [{ providerId, apiKey: keyFor[providerId], model }];
  const notes = [];
  let truncated = false;

  const callLlm = async (opts) => {
    const res = await chatWithRotation({
      ...opts, chain: pinned, task: 'resume', sleepImpl: async () => {},
    });
    if (res.finishReason === 'length') truncated = true;
    return res;
  };

  const started = Date.now();
  let status = 'error';
  let retention = null;
  try {
    const out = await tailorResume({
      model: structuredClone(baseModel),
      jobDescription: JOB,
      callLlm,
      maxAttempts: 1,          // one shot: measuring the model, not the retry loop
      job: { title: 'Senior Financial Analyst', company: 'Acme', description: JOB },
    });
    status = out.report ? out.report.status : 'no report';
    const after = (out.model.sections || [])
      .flatMap((s) => (s.entries || []).flatMap((e) => e.bullets || []));
    if (after.length) {
      retention = conceptRetentionRatio(originalBullets.join(' '), after.join(' '));
    }
    if (out.report && out.report.validator && out.report.validator.errors) {
      notes.push(...out.report.validator.errors.slice(0, 1));
    }
  } catch (err) {
    status = (err && err.kind) || 'error';
    notes.push(String(err && err.message || err).slice(0, 60));
  }
  const secs = (Date.now() - started) / 1000;
  if (truncated) notes.unshift('TRUNCATED');

  results.push({ providerId, model, status, secs, retention, truncated });
  const keep = retention == null ? '  —  ' : `${Math.round(retention * 100)}%`.padStart(5);
  const tag = REPEATS > 1 ? ` #${run + 1}` : '';
  console.log(`  ${(model + tag).padEnd(40)} ${status.padEnd(24)} ${secs.toFixed(1).padStart(6)} ${keep}  ${notes.join('; ').slice(0, 52)}`);
 }
}

// --- verdict ---------------------------------------------------------------

const GOOD = new Set(['approved', 'approved_with_judge_warning', 'approved_with_warning']);
const usable = results.filter((r) => GOOD.has(r.status) && !r.truncated);

console.log(`\n${'='.repeat(92)}`);
console.log(`\n${usable.length}/${results.length} produced a usable resume.\n`);

if (usable.length) {
  // Grouped per model, so repeats collapse into a mean and a spread. Ranked by
  // retention first, then speed: a fast model that drops the numbers is not a
  // cheaper option, it is a worse resume.
  const byModel = new Map();
  for (const r of usable) {
    if (!byModel.has(r.model)) byModel.set(r.model, { ...r, keeps: [], times: [] });
    byModel.get(r.model).keeps.push(r.retention);
    byModel.get(r.model).times.push(r.secs);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ranked = [...byModel.values()]
    .map((r) => ({
      ...r,
      keep: mean(r.keeps),
      avgSecs: mean(r.times),
      lo: Math.min(...r.keeps),
      hi: Math.max(...r.keeps),
      runs: r.keeps.length,
    }))
    .sort((a, b) => (b.keep - a.keep) || (a.avgSecs - b.avgSecs));

  console.log(`ranked by concreteness kept, then speed${REPEATS > 1 ? ` (mean of ${REPEATS})` : ''}:\n`);
  for (const [i, r] of ranked.entries()) {
    // The spread is printed, not hidden behind an average: a model that swings
    // 40 points between runs is not the same bet as one that holds steady,
    // even when their means match.
    const spread = r.runs > 1
      ? `  (${Math.round(r.lo * 100)}-${Math.round(r.hi * 100)}%, n=${r.runs})`
      : '';
    console.log(`  ${String(i + 1).padStart(2)}. ${r.model.padEnd(40)} ${String(Math.round(r.keep * 100) + '%').padStart(4)}${spread.padEnd(20)} ${r.avgSecs.toFixed(1)}s  [${r.providerId}]`);
  }
}

const failed = results.filter((r) => !usable.includes(r));
if (failed.length) {
  console.log('\nnot usable:\n');
  for (const r of failed) console.log(`  ${r.model.padEnd(40)} ${r.status}${r.truncated ? ' (truncated)' : ''}`);
}

console.log('\nProviders reachable this run: '
  + Object.keys(keyFor).filter((id) => results.some((r) => r.providerId === id && GOOD.has(r.status))).join(', '));
void PROVIDERS;
