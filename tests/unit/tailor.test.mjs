import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { buildTailorMessages, parseLlmJson, tailorResume, validateTailoredModel, ONE_PAGE_WORD_BUDGET } from '../../extension/engine/tailor.js';
import { validatePreferences } from '../../extension/engine/preferences.js';
import { getProvider } from '../../extension/engine/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');
const provider = getProvider('gemini');

// --- parseLlmJson: ported brace-slice salvage (v4/tailor.py:167-179) ---

test('parseLlmJson parses clean JSON directly', () => {
  assert.deepEqual(parseLlmJson('{"summary": "ok"}'), { summary: 'ok' });
});

test('parseLlmJson strips a markdown code fence before parsing', () => {
  assert.deepEqual(parseLlmJson('```json\n{"summary": "ok"}\n```'), { summary: 'ok' });
});

test('parseLlmJson salvages a JSON object surrounded by prose the model added despite instructions', () => {
  const raw = 'Sure, here you go:\n{"summary": "ok", "entries": []}\nHope that helps!';
  assert.deepEqual(parseLlmJson(raw), { summary: 'ok', entries: [] });
});

test('parseLlmJson returns {} rather than throwing on total garbage', () => {
  assert.deepEqual(parseLlmJson('not json and no braces either'), {});
});

// --- buildTailorMessages: locked fields must never appear in the prompt ---

test('buildTailorMessages never includes locked fields (name, contact, titles, dates, education)', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const messages = buildTailorMessages(model, 'Some job description.');
  const combined = messages.map((m) => m.content).join('\n');
  assert.ok(!combined.includes(model.name), 'name leaked into the prompt');
  assert.ok(!combined.includes('647-555-0142'), 'phone number leaked into the prompt');
  assert.ok(!combined.includes('j.rivera@example.com'), 'email leaked into the prompt');
  const edu = model.sections.find((s) => s.kind === 'education');
  for (const line of edu.lines) {
    assert.ok(!combined.includes(line), `education line leaked into the prompt: ${line}`);
  }
  // dates are locked -- they must not appear either
  assert.ok(!combined.includes('May 2025 - Jan 2026'));
});

test('buildTailorMessages includes the job description and current bullets, keyed by index', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const messages = buildTailorMessages(model, 'Looking for a backend engineer with Python experience.');
  const userMsg = messages.find((m) => m.role === 'user').content;
  assert.ok(userMsg.includes('backend engineer with Python experience'));
  assert.ok(userMsg.includes('"index": 0'));
  assert.ok(userMsg.includes('"index": 1'));
});

test('buildTailorMessages truncates an oversized job description to 6000 chars, matching v4/tailor.py:160', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const hugeJd = 'z'.repeat(10_000);
  const messages = buildTailorMessages(model, hugeJd);
  const userMsg = messages.find((m) => m.role === 'user').content;
  const jdSegment = userMsg.split('JOB DESCRIPTION:\n')[1].split('\n\n')[0];
  assert.equal(jdSegment.length, 6000);
});

// --- tailorResume: full pipeline with a mocked LLM ---

function mockTailoredResponse(summary, entryBullets) {
  const body = { summary, entries: entryBullets.map((bullets, index) => ({ index, bullets })) };
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] }), { status: 200 });
}

test('tailorResume applies the mocked LLM output and leaves locked fields untouched end to end', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const fetchImpl = mockTailoredResponse('A summary rewritten for the target role.', [
    ['Rewrote the projects bullet to mention the target stack.', 'Second rewritten bullet.'],
    ['Rewrote the experience bullet for the job description.', 'Second rewritten experience bullet.'],
  ]);

  const result = await tailorResume({
    model,
    jobDescription: 'A backend role requiring Python and AWS.',
    provider,
    apiKey: 'test-key',
    modelName: 'gemini-2.5-flash',
    fetchImpl,
  });

  assert.equal(result.model.name, model.name);
  assert.equal(result.model.contact, model.contact);
  assert.equal(result.model.summary, 'A summary rewritten for the target role.');

  const projectEntry = result.model.sections.find((s) => s.kind === 'projects').entries[0];
  assert.deepEqual(projectEntry.bullets, [
    'Rewrote the projects bullet to mention the target stack.',
    'Second rewritten bullet.',
  ]);
  // locked title/meta on that same entry: untouched
  assert.match(projectEntry.title, /AI-Powered Job Automation Engine/);

  const expEntry = result.model.sections.find((s) => s.kind === 'experience').entries[0];
  assert.equal(expEntry.meta, 'May 2025 - Jan 2026'); // locked date survives real LLM round-trip

  assert.ok(result.wordCount > 0);
});

test('tailorResume compacts to the one-page word budget when the mocked response is too long', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  // Over budget by VOLUME rather than by any one bullet ballooning: many
  // ordinary-length bullets, none of which trips MAX_BULLET_LENGTH_RATIO.
  //
  // This mattered once the repair pass landed. A mock built from one enormous
  // repeated bullet — what this test used to do — is now reverted to the
  // original before the compactor ever sees it, so it stopped testing
  // compaction at all. The two guards are complementary: per-bullet length
  // stops one bullet padding into a paragraph, the word budget stops an
  // aggregate that is merely long. This test is about the second.
  const bullet = 'Delivered a measurable improvement to the monthly reporting process for the finance team and its stakeholders.';
  const manyBullets = Array.from({ length: 20 }, () => bullet);
  const fetchImpl = mockTailoredResponse('A summary.', [manyBullets, manyBullets]);

  const result = await tailorResume({
    model,
    jobDescription: 'A role.',
    provider,
    apiKey: 'test-key',
    modelName: 'gemini-2.5-flash',
    fetchImpl,
  });

  assert.ok(result.wordCount <= ONE_PAGE_WORD_BUDGET, `expected <= ${ONE_PAGE_WORD_BUDGET}, got ${result.wordCount}`);
  assert.ok(result.compactionIterations > 0);
});

test('tailorResume surfaces an LlmError from the underlying chat call rather than swallowing it', async () => {
  const model = parseTxt(fixture('taylor-reed-sparse.txt'));
  const fetchImpl = async () => new Response('quota exceeded', { status: 429 });
  // 429 is retryable by design (see llm.test.mjs) -- disable retries here so
  // this test isn't paying real backoff delay just to prove error surfacing.
  await assert.rejects(
    tailorResume({ model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, maxRetries: 0 }),
    (err) => err.kind === 'http_error',
  );
});

// --- validateTailoredModel: the anti-fabrication checks ---

test('validateTailoredModel flags a professional identity the source resume never claimed', () => {
  const original = parseTxt(fixture('juan-rivera-full.txt'));
  const tailored = structuredClone(original);
  // The real resume says "Software Developer"; claiming Product Manager is
  // an identity change, not a transferable-skills reframing.
  tailored.summary = 'Product Manager with 4 years of experience leading roadmaps.';
  const v = validateTailoredModel(original, tailored);
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /professional identity/.test(e) && /product manager/.test(e)));
});

test('validateTailoredModel allows a role title the source resume genuinely contains', () => {
  const original = parseTxt(fixture('juan-rivera-full.txt'));
  const tailored = structuredClone(original);
  // "Software Developer" is in the real summary already.
  tailored.summary = 'Software Developer focused on backend APIs and cloud deployment work.';
  const v = validateTailoredModel(original, tailored);
  assert.ok(!v.errors.some((e) => /professional identity/.test(e)), JSON.stringify(v.errors));
});

test('validateTailoredModel errors when an entry loses every bullet (content dropped, not tailored)', () => {
  const original = parseTxt(fixture('juan-rivera-full.txt'));
  const tailored = structuredClone(original);
  tailored.sections.find((s) => s.kind === 'experience').entries[0].bullets = [];
  const v = validateTailoredModel(original, tailored);
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /lost all of its bullet points/.test(e)));
});

test('validateTailoredModel warns on a too-short summary without failing the whole run', () => {
  const original = parseTxt(fixture('juan-rivera-full.txt'));
  const tailored = structuredClone(original);
  tailored.summary = 'Short summary.';
  const v = validateTailoredModel(original, tailored);
  assert.equal(v.passed, true, 'a short summary is a warning, not an error');
  assert.ok(v.warnings.some((w) => /only 2 words/.test(w)));
});

// --- retry + preferences wiring ---

test('tailorResume retries with the validation errors fed back, then reports the passing attempt', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const bad = { summary: 'Product Manager with deep roadmap ownership across many teams and years.', entries: [] };
  const good = { summary: 'Software Developer building backend services with Python and AWS at scale daily.', entries: [] };
  const bodies = [JSON.stringify(bad), JSON.stringify(good)];
  let call = 0;
  const fetchImpl = async () => {
    const content = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl,
  });
  assert.equal(result.report.status, 'approved');
  assert.equal(result.report.attempts, 2);
});

test('tailorResume reports fallback_after_validation rather than a false approved when every attempt fails', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const bad = JSON.stringify({ summary: 'Product Manager owning the roadmap for several separate product lines.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: bad } }] }), { status: 200 });
  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl,
  });
  assert.equal(result.report.status, 'fallback_after_validation');
  assert.ok(result.report.validator.errors.length > 0);
  assert.ok(result.model, 'must still return a usable model');
});

test('tailorResume sanitizes em dashes and smart quotes out of the model output', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const body = JSON.stringify({
    summary: 'Software Developer — building APIs with “quoted” terms and solid backend delivery work.',
    entries: [{ index: 0, bullets: ['Did a thing — with dashes.'] }],
  });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  const result = await tailorResume({ model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.ok(!result.model.summary.includes('—'), 'em dash should be sanitized');
  assert.ok(!result.model.summary.includes('“'), 'smart quote should be sanitized');
});

test('buildTailorMessages injects the user preference section, including free-text notes', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const prefs = validatePreferences({ resume_density: 'concise', resume_notes: 'Emphasize the AWS work.' });
  const system = buildTailorMessages(model, 'jd', prefs).find((m) => m.role === 'system').content;
  assert.match(system, /Resume density: concise/);
  assert.match(system, /Emphasize the AWS work\./);
  assert.match(system, /scope="style_only"/);
});
