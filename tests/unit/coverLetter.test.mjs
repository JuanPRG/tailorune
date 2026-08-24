import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTxt } from '../../extension/engine/parseTxt.js';
import {
  validateCoverLetter, buildCoverLetterMessages, generateCoverLetter,
  renderCoverLetterHtml, MIN_BODY_PARAGRAPHS,
} from '../../extension/engine/coverLetter.js';
import { getProvider } from '../../extension/engine/providers.js';
import { factoryPreferences } from '../../extension/engine/preferences.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(__dirname, '../fixtures/resumes', name), 'utf8');
const provider = getProvider('gemini');
const JOB = { title: 'Backend Engineer', company: 'Acme Corp', description: 'Python and AWS required.' };

function paragraphsOfLength(totalWords, count = 2) {
  const perPara = Math.floor(totalWords / count);
  return Array.from({ length: count }, () => Array(perPara).fill('word').join(' '));
}

// --- validateCoverLetter ---

test('validateCoverLetter passes a well-formed body inside the word and paragraph bounds', () => {
  const v = validateCoverLetter(paragraphsOfLength(250, 3), { minWords: 225, maxWords: 275 });
  assert.equal(v.passed, true, JSON.stringify(v.errors));
  assert.equal(v.paragraphCount, 3);
});

test('validateCoverLetter rejects a body below the minimum word floor', () => {
  const v = validateCoverLetter(paragraphsOfLength(50, 2), { minWords: 225, maxWords: 275 });
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /below minimum/.test(e)));
});

test('validateCoverLetter allows a 5% under-target body as a WARNING, not an error (normal mode tolerance)', () => {
  // 220 words against a 225 minimum is within the 5% tolerance band.
  const v = validateCoverLetter(paragraphsOfLength(220, 2), { minWords: 225, maxWords: 275, mode: 'normal' });
  assert.equal(v.passed, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.some((w) => /slightly below/.test(w)));
});

test('validateCoverLetter rejects too few or too many paragraphs', () => {
  const tooFew = validateCoverLetter(paragraphsOfLength(250, 1), { minWords: 225, maxWords: 275 });
  assert.ok(tooFew.errors.some((e) => /body paragraphs/.test(e)));
  const tooMany = validateCoverLetter(paragraphsOfLength(250, 6), { minWords: 225, maxWords: 275 });
  assert.ok(tooMany.errors.some((e) => /body paragraphs/.test(e)));
});

test('validateCoverLetter treats AI-cliche phrases as a warning normally but an error in strict mode', () => {
  const body = paragraphsOfLength(250, 2);
  body[0] = `I am passionate about this ${body[0]}`;
  const normal = validateCoverLetter(body, { minWords: 225, maxWords: 275, mode: 'normal' });
  assert.ok(normal.warnings.some((w) => /AI-cliche/.test(w)));
  const strict = validateCoverLetter(body, { minWords: 225, maxWords: 275, mode: 'strict' });
  assert.ok(strict.errors.some((e) => /AI-cliche/.test(e)));
});

test('validateCoverLetter rejects an em dash or en dash outright', () => {
  const body = paragraphsOfLength(250, 2);
  body[0] = `Something — else ${body[0]}`;
  const v = validateCoverLetter(body, { minWords: 225, maxWords: 275 });
  assert.ok(v.errors.some((e) => /em dash/.test(e)));
});

test('validateCoverLetter flags a watchlisted skill the resume never claimed (anti-fabrication)', () => {
  const body = paragraphsOfLength(250, 2);
  body[0] = `My Kubernetes and Terraform expertise ${body[0]}`;
  const skillsBoundary = new Set(['python', 'sql']); // neither kubernetes nor terraform
  const v = validateCoverLetter(body, { minWords: 225, maxWords: 275, skillsBoundary });
  assert.equal(v.passed, false);
  assert.ok(v.errors.some((e) => /unverified skill/.test(e) && /kubernetes/.test(e) && /terraform/.test(e)));
});

test('validateCoverLetter does NOT flag a watchlisted skill the resume genuinely lists', () => {
  const body = paragraphsOfLength(250, 2);
  body[0] = `My Kubernetes work ${body[0]}`;
  const v = validateCoverLetter(body, { minWords: 225, maxWords: 275, skillsBoundary: new Set(['kubernetes']) });
  assert.ok(!v.errors.some((e) => /unverified skill/.test(e)), JSON.stringify(v.errors));
});

test('validateCoverLetter in lenient mode skips length and paragraph checks entirely', () => {
  const v = validateCoverLetter(['tiny'], { minWords: 225, maxWords: 275, mode: 'lenient' });
  assert.equal(v.passed, true, JSON.stringify(v.errors));
});

// --- buildCoverLetterMessages: the name must never reach the LLM ---

test('buildCoverLetterMessages never sends the candidate name or contact details to the LLM', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const combined = buildCoverLetterMessages({ model, job: JOB, preferences: factoryPreferences() })
    .map((m) => m.content).join('\n');
  // This is what makes a "John Doe" signature structurally impossible
  // rather than merely discouraged -- the model is never told the name.
  assert.ok(!combined.includes('Juan Rivera'), 'candidate name leaked into the cover-letter prompt');
  assert.ok(!combined.includes('647-555-0142'), 'phone leaked into the cover-letter prompt');
  assert.ok(!combined.includes('j.rivera@example.com'), 'email leaked into the cover-letter prompt');
});

test('buildCoverLetterMessages instructs the model to omit the greeting and sign-off', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const system = buildCoverLetterMessages({ model, job: JOB }).find((m) => m.role === 'system').content;
  assert.match(system, /no greeting/i);
  assert.match(system, /no sign-off/i);
});

test('buildCoverLetterMessages includes the job title, company, and truncated description', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const job = { ...JOB, description: 'z'.repeat(9000) };
  const user = buildCoverLetterMessages({ model, job }).find((m) => m.role === 'user').content;
  assert.match(user, /Backend Engineer/);
  assert.match(user, /Acme Corp/);
  const jd = user.split('JOB DESCRIPTION:\n')[1];
  assert.equal(jd.length, 4000);
});

test('buildCoverLetterMessages feeds previous validation errors back in as avoid-notes', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const system = buildCoverLetterMessages({ model, job: JOB, avoidNotes: ['Body is 12 words, below minimum 225.'] })
    .find((m) => m.role === 'system').content;
  assert.match(system, /do not repeat them/i);
  assert.match(system, /below minimum 225/);
});

// --- generateCoverLetter: retry / fallback / status honesty ---

function mockLlm(bodiesInOrder) {
  let call = 0;
  return async () => {
    const body = bodiesInOrder[Math.min(call, bodiesInOrder.length - 1)];
    call += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), { status: 200 });
  };
}

const GOOD_BODY = `${Array(130).fill('word').join(' ')}\n\n${Array(130).fill('word').join(' ')}`;

test('generateCoverLetter returns approved on a first-attempt valid body', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const { paragraphs, report } = await generateCoverLetter({
    model, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl: mockLlm([GOOD_BODY]),
  });
  assert.equal(report.status, 'approved');
  assert.equal(report.attempts, 1);
  assert.equal(paragraphs.length, 2);
});

test('generateCoverLetter retries after an invalid body and reports the attempt it succeeded on', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const { report } = await generateCoverLetter({
    model, job: JOB, provider, apiKey: 'k', modelName: 'm',
    fetchImpl: mockLlm(['too short', GOOD_BODY]),
  });
  assert.equal(report.status, 'approved');
  assert.equal(report.attempts, 2);
});

test('generateCoverLetter falls back to the least-bad attempt rather than returning nothing', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  // All attempts invalid (too short), but non-empty -- must keep the best.
  const { paragraphs, report } = await generateCoverLetter({
    model, job: JOB, provider, apiKey: 'k', modelName: 'm',
    fetchImpl: mockLlm(['short one\n\nshort two']),
  });
  assert.equal(report.status, 'fallback_after_validation');
  assert.equal(report.attempts, 3);
  assert.ok(paragraphs.length > 0, 'fallback must still return usable text');
  assert.ok(report.attemptValidations.length === 3);
});

test('generateCoverLetter reports approved_with_warning in lenient mode, never a bare approved', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const { report } = await generateCoverLetter({
    model, job: JOB, provider, apiKey: 'k', modelName: 'm',
    validationMode: 'lenient', fetchImpl: mockLlm(['a\n\nb']),
  });
  // Lenient skipped the length checks, so claiming plain "approved" would
  // overstate what was actually verified.
  assert.equal(report.status, 'approved_with_warning');
});

test('generateCoverLetter sanitizes em dashes out of the model output before validating', async () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const withDash = `First — paragraph ${Array(128).fill('word').join(' ')}\n\n${Array(130).fill('word').join(' ')}`;
  const { paragraphs, report } = await generateCoverLetter({
    model, job: JOB, provider, apiKey: 'k', modelName: 'm', fetchImpl: mockLlm([withDash]),
  });
  assert.equal(report.status, 'approved', JSON.stringify(report.validator));
  assert.ok(!paragraphs.join(' ').includes('—'), 'em dash should have been sanitized to a comma');
});

// --- rendering ---

test('renderCoverLetterHtml builds the greeting and sign-off itself, using the real name', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const html = renderCoverLetterHtml({ bodyParagraphs: ['Body one.', 'Body two.'], model, job: JOB });
  assert.match(html, /Dear Hiring Manager,/);
  assert.match(html, /Sincerely,/);
  assert.match(html, /Juan Rivera/);
  assert.match(html, /Re: Backend Engineer at Acme Corp/);
  assert.match(html, /Body one\./);
});

test('renderCoverLetterHtml escapes resume and body content (XSS boundary, it opens as a live page)', () => {
  const model = parseTxt(fixture('juan-rivera-full.txt'));
  const html = renderCoverLetterHtml({
    bodyParagraphs: ['<script>alert(1)</script>'], model, job: JOB,
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
