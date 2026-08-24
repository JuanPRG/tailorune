import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSkillItems, skillsRetentionRatio, buildSkillsMessages, tailorSkills,
  MIN_SKILLS_RETENTION_RATIO,
} from '../../extension/engine/tailorSkills.js';
import { getProvider } from '../../extension/engine/providers.js';

const provider = getProvider('gemini');
const JOB = { title: 'Backend Engineer', description: 'Python, AWS, Kubernetes.' };

// --- splitSkillItems / retention math ---

test('splitSkillItems drops the category label so it is never counted as an item', () => {
  assert.deepEqual(splitSkillItems('Languages: Java, Python, SQL'), ['Java', 'Python', 'SQL']);
});

test('splitSkillItems handles a line with no label at all', () => {
  assert.deepEqual(splitSkillItems('Java, Python'), ['Java', 'Python']);
});

test('splitSkillItems ignores a colon too far in to be a label (>40 chars)', () => {
  const line = `${'x'.repeat(45)}: Java, Python`;
  // The whole string is treated as the item list, not label + items.
  assert.ok(splitSkillItems(line)[0].startsWith('x'.repeat(45)));
});

test('skillsRetentionRatio measures verbatim survivors, case-insensitively', () => {
  assert.equal(skillsRetentionRatio('Tools: A, B, C, D', 'Tools: a, b, X, Y'), 0.5);
  assert.equal(skillsRetentionRatio('Tools: A, B', 'Tools: A, B'), 1);
  assert.equal(skillsRetentionRatio('Tools: A, B', 'Tools: X, Y'), 0);
});

test('skillsRetentionRatio treats an empty original as fully retained (nothing to lose)', () => {
  assert.equal(skillsRetentionRatio('Tools:', 'Tools: A, B'), 1);
});

// --- prompt ---

test('buildSkillsMessages states the retention ground rule as a hard percentage', () => {
  const system = buildSkillsMessages({ lines: ['Tools: A'], indices: [0], job: JOB })
    .find((m) => m.role === 'system').content;
  assert.match(system, /keep at least 20% of its original items completely unchanged/);
  assert.match(system, /Category labels/);
});

test('buildSkillsMessages numbers blocks by their real index so answers can be matched back', () => {
  const user = buildSkillsMessages({ lines: ['Tools: A', 'Langs: B'], indices: [1, 3], job: JOB })
    .find((m) => m.role === 'user').content;
  assert.match(user, /\[1\] Tools: A/);
  assert.match(user, /\[3\] Langs: B/);
});

test('buildSkillsMessages truncates the job description to 4000 chars', () => {
  const user = buildSkillsMessages({ lines: ['Tools: A'], indices: [0], job: { ...JOB, description: 'z'.repeat(9000) } })
    .find((m) => m.role === 'user').content;
  const jd = user.split('JOB DESCRIPTION:\n')[1].split('\n\n')[0];
  assert.equal(jd.length, 4000);
});

// --- tailorSkills: the deterministic guard ---

function mockLlm(responsesInOrder) {
  let call = 0;
  return async () => {
    const content = responsesInOrder[Math.min(call, responsesInOrder.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
}

test('tailorSkills accepts a rewrite that keeps enough original items', async () => {
  const lines = ['Languages: Java, Python, SQL, C++'];
  // Keeps Java + Python (50%), adds Go -- comfortably over the 20% floor.
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Languages: Java, Python, Go' })]);
  const { lines: out, report } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.equal(out[0], 'Languages: Java, Python, Go');
  assert.equal(report.status, 'approved');
});

test('tailorSkills REVERTS a wholesale replacement that drops every original item', async () => {
  const lines = ['Languages: Java, Python, SQL, C++'];
  // Nothing from the original survives -- a wish list, not a tailoring.
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Languages: Kubernetes, Terraform, Rust' })]);
  const { lines: out, report } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.equal(out[0], lines[0], 'must revert to the original line, not accept the replacement');
  assert.equal(report.status, 'no_change');
  assert.ok(report.reverted.some((r) => /retention_0%_below_20%/.test(r)));
});

test('tailorSkills allows ADDING plausible new skills, unlike the bullet pass', async () => {
  const lines = ['Cloud: AWS, Docker'];
  // Keeps both originals (100%) and adds Kubernetes -- explicitly permitted here.
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Cloud: AWS, Docker, Kubernetes' })]);
  const { lines: out } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.match(out[0], /Kubernetes/);
});

test('tailorSkills retries only the lines that failed, keeping the ones that passed', async () => {
  const lines = ['Languages: Java, Python', 'Cloud: AWS, Docker'];
  const first = JSON.stringify({ 0: 'Languages: Java, Go', 1: 'Cloud: Rust, Terraform' }); // line 1 fails
  const second = JSON.stringify({ 1: 'Cloud: AWS, Kubernetes' }); // line 1 now retains AWS
  const fetchImpl = mockLlm([first, second]);
  const { lines: out, report } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.equal(out[0], 'Languages: Java, Go', 'the line that passed on attempt 1 must be kept');
  assert.equal(out[1], 'Cloud: AWS, Kubernetes', 'the retried line must be accepted once it passes');
  assert.equal(report.attempts, 2);
  assert.equal(report.status, 'approved');
});

test('tailorSkills gives up after maxAttempts and leaves failing lines untouched', async () => {
  const lines = ['Languages: Java, Python'];
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Languages: Rust, Go' })]);
  const { lines: out, report } = await tailorSkills({
    skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl, maxAttempts: 2,
  });
  assert.equal(out[0], lines[0]);
  assert.equal(report.attempts, 2);
  assert.equal(report.status, 'no_change');
});

test('tailorSkills sanitizes em dashes out of the proposed skills text', async () => {
  const lines = ['Tools: Git, Docker'];
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Tools: Git, Docker — and CI' })]);
  const { lines: out } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.ok(!out[0].includes('—'));
});

test('tailorSkills no-ops cleanly on a resume with no skills section', async () => {
  const { lines, report } = await tailorSkills({ skillsLines: [], job: JOB, provider, apiKey: 'k', modelName: 'm' });
  assert.deepEqual(lines, []);
  assert.equal(report.attempts, 0);
  assert.equal(report.status, 'no_change');
});

test('tailorSkills leaves a line alone when the model omits it from the response', async () => {
  const lines = ['Tools: Git', 'Cloud: AWS'];
  const fetchImpl = mockLlm([JSON.stringify({ 0: 'Tools: Git, Jenkins' })]); // index 1 missing
  const { lines: out } = await tailorSkills({ skillsLines: lines, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl });
  assert.equal(out[0], 'Tools: Git, Jenkins');
  assert.equal(out[1], 'Cloud: AWS', 'an omitted line must keep its original text');
});

test('MIN_SKILLS_RETENTION_RATIO matches v4 (20%)', () => {
  assert.equal(MIN_SKILLS_RETENTION_RATIO, 0.20);
});
