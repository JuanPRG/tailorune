// malformedResponse.test.mjs — an unusable LLM answer must never be applied
// as an empty patch.
//
// This is the failure that caused two misdiagnoses. parseLlmJson returns {}
// when it cannot salvage an object, applyTailoredContent then changes
// nothing, and the rendered document comes out byte-identical to the upload.
// That is EXACTLY what a model echoing its input produces, so a truncated
// response was read as a model refusing to rewrite — and two rounds of prompt
// rewording were spent on a problem no prompt could reach.
//
// The two must therefore be distinguishable by their reports, not just by
// their output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { applyTailoredContent } from '../../extension/engine/resumeModel.js';
import { tailorResume, RESUME_MAX_TOKENS } from '../../extension/engine/tailor.js';
import { chat } from '../../extension/engine/llm.js';
import { getProvider } from '../../extension/engine/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');
const provider = getProvider('gemini');

/** A response whose JSON was cut off partway through, as truncation produces. */
const TRUNCATED = '{"summary": "A rewritten summary for the target ro';

function mockRaw(content, { finishReason = 'stop' } = {}) {
  return async () => new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { status: 200 },
  );
}

test('a truncated answer is reported as malformed, not as a model that refused to rewrite', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const result = await tailorResume({
    model,
    jobDescription: 'A role.',
    provider,
    apiKey: 'k',
    modelName: 'gemini-2.5-flash',
    fetchImpl: mockRaw(TRUNCATED, { finishReason: 'length' }),
  });

  assert.equal(result.report.status, 'malformed_response');
  const [error] = result.report.validator.errors;
  assert.match(error, /NOT tailored/i);
  assert.match(error, /ran out of output tokens/i, 'truncation must be named as the cause');
  // Never the misleading message that sent this down the wrong path twice.
  assert.doesNotMatch(error, /nothing was tailored/i);
});

test('an unparseable answer says so, and does not blame the token limit', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const result = await tailorResume({
    model,
    jobDescription: 'A role.',
    provider,
    apiKey: 'k',
    modelName: 'gemini-2.5-flash',
    fetchImpl: mockRaw('I am sorry, I cannot help with that request.'),
  });

  assert.equal(result.report.status, 'malformed_response');
  assert.match(result.report.validator.errors[0], /did not return the requested JSON/i);
});

test('a malformed run still yields the untouched resume, never labelled as tailored', async () => {
  // Failing open keeps the run useful; mislabelling it does not. The user
  // gets their original document and is told plainly it was not tailored.
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const result = await tailorResume({
    model,
    jobDescription: 'A role.',
    provider,
    apiKey: 'k',
    modelName: 'gemini-2.5-flash',
    fetchImpl: mockRaw(TRUNCATED, { finishReason: 'length' }),
  });

  assert.notEqual(result.report.status, 'approved');
  assert.ok(result.wordCount > 0, 'a document should still be produced');
  assert.equal(result.model.name, model.name, 'locked fields intact');
  const experience = result.model.sections.find((s) => s.kind === 'experience');
  assert.ok(experience.entries[0].bullets.length > 0, 'the original bullets should be intact');
});

test('a later attempt that parses cleanly recovers the run', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    const good = JSON.stringify({
      summary: 'A rewritten summary aimed squarely at the target role and its stated priorities.',
      entries: [
        { index: 0, bullets: ['Rebuilt the projects bullet around the posting language.'] },
        { index: 1, bullets: ['Reframed the experience bullet for this posting.'] },
      ],
    });
    const content = call === 1 ? TRUNCATED : good;
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: call === 1 ? 'length' : 'stop' }] }),
      { status: 200 },
    );
  };

  const result = await tailorResume({
    model, jobDescription: 'A role.', provider, apiKey: 'k', modelName: 'gemini-2.5-flash', fetchImpl,
  });

  assert.equal(call, 2, 'the malformed attempt should have been retried');
  assert.notEqual(result.report.status, 'malformed_response');
  assert.match(result.model.summary, /rewritten summary/);
});

// --- the mechanics underneath ----------------------------------------------

test('chat() surfaces finish_reason so truncation is visible to callers', async () => {
  const fetchImpl = mockRaw('{"summary": "x"}', { finishReason: 'length' });
  const response = await chat({ provider, apiKey: 'k', model: 'm', messages: [], fetchImpl });
  assert.equal(response.finishReason, 'length');
});

test('chat() names the token limit when a truncated response carried no content at all', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    { status: 200 },
  );
  await assert.rejects(
    chat({ provider, apiKey: 'k', model: 'm', messages: [], fetchImpl }),
    (err) => err.kind === 'empty_response' && /token limit/i.test(err.message),
  );
});

test('the resume pass asks for more tokens than the smaller passes', () => {
  // It emits the largest JSON of the three, and runs on reasoning models where
  // max_tokens caps thinking and output together.
  assert.ok(RESUME_MAX_TOKENS > 2048, `expected a raised budget, got ${RESUME_MAX_TOKENS}`);
});

test('applyTailoredContent matches an index the model returned as a string', () => {
  // "index": "0" would otherwise miss every lookup and apply nothing — another
  // route to output identical to the input.
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const applied = applyTailoredContent(model, {
    summary: 'A new summary.',
    entries: [{ index: '0', bullets: ['A rewritten bullet.'] }],
  });
  const firstEntry = applied.sections.find((s) => s.entries).entries[0];
  assert.deepEqual(firstEntry.bullets, ['A rewritten bullet.']);
});
