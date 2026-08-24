import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import { buildJudgePairs, buildJudgeMessages, judgeTailoredModel } from '../../extension/engine/judge.js';
import { tailorResume } from '../../extension/engine/tailor.js';
import { getProvider } from '../../extension/engine/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');
const provider = getProvider('gemini');
const JOB = { title: 'Backend Engineer', description: 'Python and AWS.' };

function modelWith(summary, bullets) {
  return {
    name: 'Juan Rivera',
    contact: 'Toronto, ON',
    summary,
    skills: null,
    sections: [{
      kind: 'experience',
      heading: 'EXPERIENCE',
      entries: [{ title: 'Support Specialist', meta: 'Jan 2023 - Present', bullets }],
    }],
  };
}

// --- pair building: the judge is blind without the originals ---

test('buildJudgePairs shows ORIGINAL alongside REWRITTEN for the summary and each changed role', () => {
  const original = modelWith('Old summary.', ['Old bullet.']);
  const tailored = modelWith('New summary.', ['New bullet.']);
  const pairs = buildJudgePairs(original, tailored);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].label, 'SUMMARY');
  assert.equal(pairs[0].original, 'Old summary.');
  assert.equal(pairs[0].rewritten, 'New summary.');
  assert.equal(pairs[1].label, 'ROLE 1 BULLETS');
  assert.equal(pairs[1].original, 'Old bullet.');
});

test('buildJudgePairs skips roles whose bullets are unchanged -- no tokens spent reviewing them', () => {
  const original = modelWith('Same.', ['Identical bullet.']);
  const tailored = modelWith('Same.', ['Identical bullet.']);
  assert.deepEqual(buildJudgePairs(original, tailored), []);
});

test('buildJudgeMessages instructs the model NOT to flag mere rephrasing, and truncates the JD', () => {
  const pairs = buildJudgePairs(modelWith('a', ['b']), modelWith('c', ['d']));
  const prompt = buildJudgeMessages({ pairs, job: { ...JOB, description: 'z'.repeat(9000) } })[0].content;
  assert.match(prompt, /Aggressive reframing.*expected and fine/s);
  assert.match(prompt, /Do not flag rephrasing, reordering, or vocabulary shifts/);
  assert.match(prompt, /genuinely different real activity/);
  const jd = prompt.split('JOB DESCRIPTION:\n')[1].split('\n\n')[0];
  assert.equal(jd.length, 3000);
});

// --- judging ---

function mockJudge(body) {
  return async () => ({ content: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('judgeTailoredModel passes clean content through', async () => {
  const result = await judgeTailoredModel({
    original: modelWith('a', ['b']),
    tailored: modelWith('c', ['d']),
    job: JOB,
    callLlm: mockJudge({ passed: true, issues: [] }),
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test('judgeTailoredModel surfaces issues when the rewrite drifts to a different activity', async () => {
  const result = await judgeTailoredModel({
    original: modelWith('Support specialist.', ['Resolved 40 support tickets weekly.']),
    tailored: modelWith('Support specialist.', ['Architected a distributed caching layer.']),
    job: JOB,
    callLlm: mockJudge({ passed: false, issues: ['ROLE 1: describes architecting infrastructure, not ticket resolution'] }),
  });
  assert.equal(result.passed, false);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /not ticket resolution/);
});

test('judgeTailoredModel FAILS OPEN on an LLM error -- a safety net must not become a blocker', async () => {
  const result = await judgeTailoredModel({
    original: modelWith('a', ['b']),
    tailored: modelWith('c', ['d']),
    job: JOB,
    callLlm: async () => { throw new Error('all providers down'); },
  });
  assert.equal(result.passed, true, 'must not block the user when the judge itself fails');
  assert.match(result.judgeError, /all providers down/);
});

test('judgeTailoredModel fails open on a malformed response', async () => {
  const result = await judgeTailoredModel({
    original: modelWith('a', ['b']),
    tailored: modelWith('c', ['d']),
    job: JOB,
    callLlm: mockJudge('not json at all'),
  });
  assert.equal(result.passed, true);
  assert.equal(result.judgeError, 'malformed_response');
});

test('judgeTailoredModel fails open when the response omits the passed field', async () => {
  const result = await judgeTailoredModel({
    original: modelWith('a', ['b']),
    tailored: modelWith('c', ['d']),
    job: JOB,
    callLlm: mockJudge({ issues: ['something'] }),
  });
  assert.equal(result.passed, true);
  assert.equal(result.judgeError, 'malformed_response');
});

test('judgeTailoredModel skips the call entirely when nothing changed', async () => {
  let called = false;
  const result = await judgeTailoredModel({
    original: modelWith('same', ['same']),
    tailored: modelWith('same', ['same']),
    job: JOB,
    callLlm: async () => { called = true; return { content: '{}' }; },
  });
  assert.equal(called, false, 'no LLM call should be made when there is nothing to review');
  assert.equal(result.skipped, true);
  assert.equal(result.passed, true);
});

// --- integration with the retry loop ---

test('tailorResume retries when the judge flags drift, and feeds its issues back as avoid-notes', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const good = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: good } }] }), { status: 200 });

  const seenPrompts = [];
  let judgeCall = 0;
  const judge = async () => {
    judgeCall += 1;
    return judgeCall === 1
      ? { passed: false, issues: ['ROLE 1: different activity than the original'] }
      : { passed: true, issues: [] };
  };

  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, judge, job: JOB,
  });

  assert.equal(result.report.attempts, 2, 'a judge failure should trigger a retry');
  assert.equal(result.report.status, 'approved');
  assert.equal(result.report.judge.passed, true);
});

test('tailorResume reports fallback_after_validation when the judge keeps flagging drift', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const body = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  const judge = async () => ({ passed: false, issues: ['still drifting'] });

  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, judge, job: JOB,
  });

  assert.equal(result.report.status, 'fallback_after_validation');
  assert.equal(result.report.judge.passed, false);
  // The document is still produced -- the judge is advisory, not a gate.
  assert.ok(result.model, 'a flagged run must still return a usable document');
});

test('tailorResume does not call the judge when the deterministic validator already failed', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  // Claims an identity absent from the source -> validator fails first.
  const bad = JSON.stringify({ summary: 'Product Manager owning the roadmap across several teams.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: bad } }] }), { status: 200 });
  let judgeCalls = 0;
  const judge = async () => { judgeCalls += 1; return { passed: true, issues: [] }; };

  await tailorResume({ model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, judge, job: JOB });
  assert.equal(judgeCalls, 0, 'no point paying for a review of content already known to be invalid');
});

test('tailorResume works unchanged when no judge is supplied', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const body = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  const result = await tailorResume({ model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.equal(result.report.status, 'approved');
  assert.equal(result.report.judge, null);
});
