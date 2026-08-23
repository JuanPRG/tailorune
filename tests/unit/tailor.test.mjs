import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { buildTailorMessages, parseLlmJson, tailorResume, ONE_PAGE_WORD_BUDGET } from '../../extension/engine/tailor.js';
import { getProvider } from '../../extension/engine/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');
const provider = getProvider('gemini');

// --- parseLlmJson: ported brace-slice salvage (hirepilot_v4/tailor.py:167-179) ---

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

test('buildTailorMessages truncates an oversized job description to 6000 chars, matching hirepilot_v4/tailor.py:160', () => {
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
  const longBullet = 'This is a deliberately long bullet point written to push the total word count of the tailored resume well past the one page budget threshold that the compaction logic is supposed to enforce automatically. '.repeat(3);
  const fetchImpl = mockTailoredResponse('A summary.', [
    [longBullet, longBullet, longBullet],
    [longBullet, longBullet, longBullet],
  ]);

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
  await assert.rejects(
    tailorResume({ model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl }),
    (err) => err.kind === 'http_error',
  );
});
