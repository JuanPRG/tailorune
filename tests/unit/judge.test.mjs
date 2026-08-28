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

test('a judge finding does NOT cost a retry — it is reported and accepted', async () => {
  // v4's validation_mode "lenient" (tailor.py:494, 508-512). Retrying on a
  // judge finding feeds "you drifted from the original" back into the next
  // prompt, which asks the model to be MORE literal — the opposite of the
  // aggressive tailoring this tool exists to do. The check meant to protect
  // the resume was quietly sanding down its main feature.
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const body = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  };
  const judge = async () => ({ passed: false, issues: ['ROLE 1: different activity than the original'] });

  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, judge, job: JOB,
  });

  assert.equal(calls, 1, 'a judge finding must not trigger another tailoring call');
  assert.equal(result.report.attempts, 1);
  assert.equal(result.report.status, 'approved_with_judge_warning', 'v4 reports this status by name');
  assert.equal(result.report.judge.passed, false, 'the finding is still reported, not suppressed');
  assert.deepEqual(result.report.judge.issues, ['ROLE 1: different activity than the original']);
});

test('a judge finding never withholds the document', async () => {
  // Whether an aggressive reframing is acceptable is the candidate's call.
  // Surfacing the finding respects that; withholding the file would not.
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const body = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  const judge = async () => ({ passed: false, issues: ['still drifting'] });

  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, judge, job: JOB,
  });

  assert.ok(result.model, 'a flagged run must still return a usable document');
  assert.match(result.model.summary, /rewritten professional summary/, 'the aggressive rewrite is kept, not reverted');
  assert.ok(result.wordCount > 0);
});

test('the deterministic validator DOES still earn a retry', async () => {
  // The distinction that matters: validator failures are objective and
  // fixable (a dropped quantity, hollowed-out vocabulary, an unchanged
  // answer), so naming them gives the model something concrete to correct.
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const bad = JSON.stringify({ summary: 'Product Manager owning the roadmap across several teams.', entries: [] });
  const good = JSON.stringify({ summary: 'A perfectly reasonable rewritten professional summary here.', entries: [] });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: calls === 1 ? bad : good } }] }),
      { status: 200 },
    );
  };

  const result = await tailorResume({
    model, jobDescription: 'x', provider, apiKey: 'k', modelName: 'm', fetchImpl, job: JOB,
  });

  assert.equal(calls, 2, 'a validator failure should still trigger a retry');
  assert.equal(result.report.status, 'approved');
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
