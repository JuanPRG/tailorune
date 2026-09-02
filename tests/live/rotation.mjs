// tests/live/rotation.mjs — does failover actually work against REAL providers?
//
// WHY THIS EXISTS. Rotation had 36 unit tests against a mocked fetch and one
// e2e test against a mock server that failed a single call and checked it
// moved to the fallback. All green. Then a probe of the four configured
// providers found this:
//
//   gemini      200
//   groq        200
//   cerebras    402  persistent -- "payment_required", "param":"quota"
//   openrouter  404  every configured model
//
// Two of four dead, and `npm run test:live` still reported "approved". So
// rotation WAS working -- but that test would have passed identically if
// rotation were broken and Gemini had simply answered. It proved the run
// finished, not that the chain was walked.
//
// This file proves the chain is walked, by FORCING it: the first N entries are
// failed with an injected response and the call must land on entry N+1 with a
// REAL 200 from a REAL provider. The injection is the only synthetic part;
// every non-failed entry is a genuine network call with the genuine request
// shape, which is what catches "this model rejects response_format" before a
// user does.
//
// It ASSERTS rather than reports. A failure exits non-zero.
//
// Not part of `npm test`: it costs real quota and is non-deterministic.
//   npm run test:live:rotation

import {
  loadEnvFiles, buildChain, NO_KEYS_MESSAGE,
} from './liveEnv.mjs';
import {
  chatWithRotation, describeChain, cooldownPolicy,
  resetCooldowns, cooldownState,
} from '../../extension/engine/rotatingClient.js';
import { resetRateWindows } from '../../extension/engine/rateWindow.js';
import { LlmError, resetReasoningEffortSupport } from '../../extension/engine/llm.js';
import { ROUTES } from '../../extension/engine/providers.js';

const envSources = loadEnvFiles();
const chain = buildChain();
if (!chain.length) { console.error(NO_KEYS_MESSAGE); process.exit(1); }

console.log(`keys read from: ${envSources.join(', ') || '(environment only)'}`);
console.log(`providers configured: ${chain.map((c) => c.providerId).join(', ')}\n`);

const line = (k, v) => console.log(`  ${String(k).padEnd(32)} ${v}`);
const fresh = () => { resetCooldowns(); resetRateWindows(); resetReasoningEffortSupport(); };

const failures = [];
function check(label, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const MESSAGES = [{ role: 'user', content: 'Reply with the JSON object {"ok":true} and nothing else.' }];

/**
 * Which provider owns a model, resolved from ROUTES.
 *
 * Not by calling describeChain() per provider: for a strict task, a
 * single-provider chain with no eligible model RAISES rather than returning
 * [], which is correct behaviour and crashed the first version of this file.
 */
const providerOf = (model) => {
  for (const route of Object.values(ROUTES)) {
    if (route.models.includes(model)) return route.providerId;
  }
  return null;
};

/**
 * Wrap fetch so specific MODELS fail without touching the network, while every
 * other model goes to its real provider. The failure is synthetic; the
 * survival is not.
 */
function injectFailures(failMap) {
  const attempted = [];
  const impl = async (url, init) => {
    const { model } = JSON.parse(init.body);
    attempted.push(model);
    const injected = failMap[model];
    if (injected) return new Response(injected.body, { status: injected.status, headers: injected.headers || {} });
    return fetch(url, init);
  };
  return { impl, attempted };
}

const RESUME_CHAIN = describeChain(chain, 'resume').map((e) => e.model);
console.log('resolved resume chain:');
RESUME_CHAIN.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
console.log();

// --- 1. live conformance: does each entry accept our real request shape? ----
//
// The most valuable thing a live test can do that a mock cannot. A model that
// rejects `response_format`, or chokes on the Groq reasoning parameters, is
// invisible until a user's run walks far enough down the chain to reach it.

console.log('=== 1. each chain entry, one real JSON-mode call ===');
const conformance = [];
for (const model of RESUME_CHAIN) {
  fresh();
  const owner = providerOf(model);
  const only = chain.filter((c) => c.providerId === owner);
  if (!only.length) { line(model, 'no key for its provider — skipped'); continue; }
  const started = Date.now();
  try {
    const res = await chatWithRotation({
      // Pinned to the one model under test: an unpinned single-provider chain
      // would resolve to every eligible model that provider has, and a
      // fallback success would be misread as this model passing.
      chain: [{ ...only[0], model }],
      messages: MESSAGES, jsonMode: true, maxTokens: 64,
      task: 'resume', reasoningEffort: 'none', sleepImpl: async () => {},
    });
    const ms = Date.now() - started;
    conformance.push({ model, ok: true, ms, mode: res.mode });
    line(model, `OK  ${ms}ms  mode=${res.mode}  ${JSON.stringify(res.content).slice(0, 44)}`);
  } catch (err) {
    const ms = Date.now() - started;
    const type = err instanceof LlmError ? err.kind : 'unknown';
    conformance.push({ model, ok: false, ms, type, message: err.message, detail: err.detail });
    line(model, `${type}  ${ms}ms  ${String(err.message).slice(0, 80)}`);
  }
}
const healthy = conformance.filter((c) => c.ok).map((c) => c.model);
console.log();
check('at least one chain entry answers for real', healthy.length > 0,
  `${healthy.length}/${conformance.length} healthy`);

if (!healthy.length) {
  console.error('\nEvery configured model is failing, so failover cannot be exercised.');
  process.exit(1);
}

// --- 2. forced walk: the chain is actually traversed, in order --------------

console.log('\n=== 2. forced walk — fail the leaders, land on a real provider ===');
for (let depth = 1; depth <= Math.min(3, RESUME_CHAIN.length - 1); depth++) {
  // Fail every entry up to `depth`, plus any that are independently broken, so
  // the expected landing spot is deterministic despite live conditions.
  const failMap = {};
  for (let i = 0; i < depth; i++) {
    failMap[RESUME_CHAIN[i]] = { status: 429, body: 'Rate limit reached for requests per minute' };
  }
  for (const c of conformance) if (!c.ok) failMap[c.model] = { status: 429, body: 'Rate limit reached for requests per minute' };

  const expected = RESUME_CHAIN.find((m, i) => i >= depth && healthy.includes(m));
  if (!expected) { line(`depth ${depth}`, 'no healthy entry beyond this depth — skipped'); continue; }

  fresh();
  const { impl, attempted } = injectFailures(failMap);
  try {
    const res = await chatWithRotation({
      chain, messages: MESSAGES, jsonMode: true, maxTokens: 64,
      task: 'resume', reasoningEffort: 'none', fetchImpl: impl, sleepImpl: async () => {},
    });
    check(
      `failing the first ${depth} lands on ${expected}`,
      res.model === expected,
      `walked ${attempted.length}: ${attempted.join(' -> ')}`,
    );
  } catch (err) {
    check(`failing the first ${depth} lands on ${expected}`, false, err.message);
  }
}

// --- 3. cooldown scope, observed end to end --------------------------------

console.log('\n=== 3. cooldown scope: quota is shared, quality is task-local ===');

fresh();
{
  const leader = RESUME_CHAIN[0];
  const { impl } = injectFailures({
    [leader]: { status: 429, body: 'You exceeded your current quota' },
  });
  await chatWithRotation({
    chain, messages: MESSAGES, jsonMode: true, maxTokens: 64, task: 'resume',
    reasoningEffort: 'none', fetchImpl: impl, sleepImpl: async () => {},
  }).catch(() => {});

  const held = Object.entries(cooldownState()).find(([k]) => k.includes(leader.toLowerCase()));
  check('a quota 429 puts the model on a SHARED hold', Boolean(held) && held[1].scope === 'shared',
    held ? `${held[1].failureType} ${held[1].seconds}s ${held[1].scope}` : 'no hold recorded');
  check('and the hold is long, not a 30-second hiccup', Boolean(held) && held[1].seconds > 600,
    held ? `${held[1].seconds}s` : 'n/a');

  // Shared means every task skips it. Prove it by asking a DIFFERENT task.
  const judgeChain = describeChain(chain, 'judge').map((e) => e.model);
  if (judgeChain.includes(leader)) {
    const { attempted } = injectFailures({});
    const probe = injectFailures({});
    await chatWithRotation({
      chain, messages: MESSAGES, jsonMode: true, maxTokens: 64, task: 'judge',
      reasoningEffort: 'none', fetchImpl: probe.impl, sleepImpl: async () => {},
    }).catch(() => {});
    check('a shared hold also blocks a different task', !probe.attempted.includes(leader),
      `judge attempted: ${probe.attempted.join(' -> ') || 'nothing'}`);
    void attempted;
  } else {
    line('shared hold across tasks', `skipped — ${leader} is not in the judge chain`);
  }
}

fresh();
{
  // A 422 is a QUALITY fault: this model cannot express the schema for THIS
  // task. It must not sideline the model for prose.
  const leader = RESUME_CHAIN[0];
  const { impl } = injectFailures({
    [leader]: { status: 422, body: 'schema not supported for this model' },
  });
  await chatWithRotation({
    chain, messages: MESSAGES, jsonMode: true, maxTokens: 64, task: 'resume',
    reasoningEffort: 'none', fetchImpl: impl, sleepImpl: async () => {},
  }).catch(() => {});

  const held = Object.entries(cooldownState()).find(([k]) => k.includes(leader.toLowerCase()));
  check('a 422 puts the model on a TASK-local hold', Boolean(held) && held[1].scope === 'task',
    held ? `${held[1].failureType} ${held[1].seconds}s ${held[1].scope}` : 'no hold recorded');

  const letterChain = describeChain(chain, 'coverLetter').map((e) => e.model);
  if (letterChain.includes(leader)) {
    // The letter chain stops at its FIRST success, so simply running it proves
    // nothing about whether `leader` was eligible -- it may just never have
    // been needed. Fail everything ahead of it so reaching it is the only way
    // the call can proceed. The first version asserted on an unforced run and
    // reported a scope bug that did not exist.
    const ahead = letterChain.slice(0, letterChain.indexOf(leader));
    const probe = injectFailures(Object.fromEntries(
      ahead.map((m) => [m, { status: 500, body: 'forced' }]),
    ));
    await chatWithRotation({
      chain, messages: MESSAGES, maxTokens: 64, task: 'coverLetter',
      reasoningEffort: 'none', fetchImpl: probe.impl, sleepImpl: async () => {},
    }).catch(() => {});
    check('a resume-task hold leaves the model eligible for prose', probe.attempted.includes(leader),
      `coverLetter attempted: ${probe.attempted.join(' -> ') || 'nothing'}`);
  } else {
    line('task hold across tasks', `skipped — ${leader} is not in the letter chain`);
  }
}

// --- 4. how REAL provider failures classify --------------------------------
//
// Not injected. Whatever the providers are actually doing right now is
// reported and checked for sanity, because a misclassified real failure is
// how a dead credential gets retried every thirty seconds all day.

console.log('\n=== 4. real provider failures, as classified ===');
//
// Read from the attempt trail rotation itself recorded. An earlier version
// re-derived the type by regexing the AGGREGATED error message for an HTTP
// status -- which that message does not contain, so every real failure read as
// `provider_error` and the check reported a bug that did not exist. Ask the
// component what it decided; do not reconstruct it.
for (const c of conformance.filter((x) => !x.ok)) {
  const attempts = (c.detail && c.detail.attempts) || [];
  const attempt = attempts.find((a) => a.model === c.model) || attempts[0];
  if (!attempt) { line(c.model, `${c.type} (no attempt trail)`); continue; }

  const scope = attempt.cooldownScope || cooldownPolicy(attempt.failureType).scope;
  const secs = attempt.retryAfterSeconds ?? Math.round(cooldownPolicy(attempt.failureType).ms / 1000);
  line(c.model, `${attempt.failureType} -> ${scope} ${secs}s`);

  // The failure mode worth catching: a PERSISTENT condition (no credit, model
  // gone) parked on a short task-local hold, so every run burns a wasted call
  // on a credential that cannot succeed today.
  const persistent = /payment|quota|not found|unavailable for free|decommission/i.test(attempt.detail || '');
  check(
    `${c.model}: a persistent failure is not a 30-second retry loop`,
    !(persistent && scope === 'task' && secs <= 30),
    `${attempt.failureType} / ${scope} ${secs}s`,
  );
}
if (!conformance.some((c) => !c.ok)) line('(none)', 'every configured model answered');

// --- 5. total exhaustion is a clear error, not a hang ----------------------

console.log('\n=== 5. everything failing ===');
fresh();
{
  const failMap = Object.fromEntries(
    RESUME_CHAIN.map((m) => [m, { status: 429, body: 'You exceeded your current quota' }]),
  );
  const { impl, attempted } = injectFailures(failMap);
  const err = await chatWithRotation({
    chain, messages: MESSAGES, jsonMode: true, maxTokens: 64, task: 'resume',
    reasoningEffort: 'none', fetchImpl: impl, sleepImpl: async () => {},
  }).then(() => null, (e) => e);

  check('every entry was attempted', attempted.length === RESUME_CHAIN.length,
    `${attempted.length}/${RESUME_CHAIN.length}`);
  check('unanimous quota exhaustion is reported as such', err && err.kind === 'quota_exhausted',
    err ? err.kind : 'the call unexpectedly succeeded');
  check('the caller is told how long to wait', Boolean(err && err.detail && err.detail.retryAfterSeconds),
    err && err.detail ? `${err.detail.retryAfterSeconds}s` : 'no retryAfterSeconds');
}

// --- summary ---------------------------------------------------------------

console.log(`\n${'='.repeat(58)}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nall rotation checks passed against live providers.');
