// coverLetter.js — cover letter generation, validation, and rendering.
//
// Ported from hirepilot_v4/cover_letter.py. The single most important
// property, carried over verbatim: **the LLM only ever writes the body
// paragraphs.** The greeting and the sign-off (which contains the
// candidate's real name) are assembled deterministically from the resume
// model. cover_letter.py's own module docstring records why — the v3
// prototype asked the model for the whole letter and shipped letters signed
// "John Doe". This module cannot repeat that, because the name is never in
// the prompt at all.
//
// Also ported: the honest status reporting. v4 is careful never to return a
// hardcoded "approved" regardless of what validation found, and to
// distinguish `approved` / `approved_with_warning` (lenient mode skipped the
// length checks, so "approved" would overstate it) / `fallback_after_validation`
// (kept the least-bad attempt) / `failed_after_retries`. All four survive.

import { chatWithRetry, LlmError } from './llm.js';

// A live run truncated every call in this pass on 1024 tokens with thinking
// left on -- a 350-word letter is ~500 tokens of output, so the budget was
// going on reasoning a drafting task does not need.
export const COVER_LETTER_MAX_TOKENS = 2048;
import { sanitizeText, tokenize, FABRICATION_WATCHLIST_TERMS, resumeSkillsBoundary, isPlausibleJobTitle } from './textUtils.js';
import { coverLetterWordRange, buildCoverLetterPreferencesSection, factoryPreferences } from './preferences.js';

export const MIN_BODY_PARAGRAPHS = 2;
export const MAX_BODY_PARAGRAPHS = 4;
const MIN_WORD_TOLERANCE_PERCENT = 5.0;
const JD_MAX_CHARS = 4000; // matches cover_letter.py:161

export const BANNED_PHRASES = [
  'passionate', 'spearheaded', 'synergy', 'cutting-edge', 'proven track record',
  'i am confident', 'leverage', 'dynamic environment', 'go-getter', 'thrilled',
];

/**
 * @param {string[]} bodyParagraphs
 * @param {object} opts
 * @param {'strict'|'normal'|'lenient'} [opts.mode]
 * @param {number} opts.minWords
 * @param {number} opts.maxWords
 * @param {Set<string>} [opts.skillsBoundary] - omit to skip the fabrication check
 */
export function validateCoverLetter(bodyParagraphs, { mode = 'normal', minWords, maxWords, skillsBoundary } = {}) {
  const text = bodyParagraphs.join(' ');
  const wordCount = (text.match(/\S+/g) || []).length;
  const paragraphCount = bodyParagraphs.length;
  const errors = [];
  const warnings = [];

  if (skillsBoundary) {
    const fabricated = [...tokenize(text)]
      .filter((t) => FABRICATION_WATCHLIST_TERMS.has(t) && !skillsBoundary.has(t))
      .sort();
    if (fabricated.length) {
      errors.push(`References unverified skill(s)/tool(s) not in the resume: ${fabricated.join(', ')}`);
    }
  }

  if (mode !== 'lenient') {
    const floor = mode === 'normal' ? minWords * (1 - MIN_WORD_TOLERANCE_PERCENT / 100) : minWords;
    if (wordCount < floor) {
      errors.push(`Body is ${wordCount} words, below minimum ${minWords}.`);
    } else if (wordCount < minWords) {
      warnings.push(`Body is ${wordCount} words, slightly below target minimum ${minWords}.`);
    }
    if (wordCount > maxWords) {
      errors.push(`Body is ${wordCount} words, above maximum ${maxWords}.`);
    }
    if (paragraphCount < MIN_BODY_PARAGRAPHS || paragraphCount > MAX_BODY_PARAGRAPHS) {
      errors.push(`Expected ${MIN_BODY_PARAGRAPHS}-${MAX_BODY_PARAGRAPHS} body paragraphs, got ${paragraphCount}.`);
    }
  }

  const lowered = text.toLowerCase();
  const hits = BANNED_PHRASES.filter((phrase) => lowered.includes(phrase)).sort();
  if (hits.length) {
    (mode === 'strict' ? errors : warnings).push(`Contains AI-cliche phrase(s): ${hits.join(', ')}`);
  }

  // sanitizeText() already converts these, so reaching here means the model
  // produced one the sanitizer somehow missed — kept as a hard error to
  // match v4 rather than silently trusting the sanitizer.
  if (text.includes('—') || text.includes('–')) {
    errors.push('Contains an em dash or en dash.');
  }

  return { passed: errors.length === 0, errors, warnings, wordCount, paragraphCount };
}

/** Rank failed attempts by usability, so the least-bad one can be kept. */
function fallbackScore(validation, minWords, maxWords) {
  const paragraphDistance = validation.paragraphCount < MIN_BODY_PARAGRAPHS
    ? MIN_BODY_PARAGRAPHS - validation.paragraphCount
    : Math.max(0, validation.paragraphCount - MAX_BODY_PARAGRAPHS);
  const wordDistance = validation.wordCount < minWords
    ? minWords - validation.wordCount
    : Math.max(0, validation.wordCount - maxWords);
  return [paragraphDistance, wordDistance, validation.errors.length, validation.warnings.length];
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function buildCoverLetterMessages({ model, job, preferences, avoidNotes }) {
  const prefs = preferences || factoryPreferences();
  const [minWords, maxWords] = coverLetterWordRange(prefs);
  const skills = [...resumeSkillsBoundary(model)].sort().join(', ');

  const systemLines = [
    "You write direct, natural, human-sounding cover letters. Write ONLY the body — 2 to 4 paragraphs, no greeting ('Dear...') and no sign-off ('Sincerely...'). Those are added separately.",
    "Connect the candidate's real, truthful background to the employer's needs. Highlight transferable skills honestly. Do not repeat the resume word for word.",
    'Avoid AI-sounding wording, generic templates, cliches, em dashes, and unnecessary hyphens.',
    `The candidate's verified real skills are: ${skills || '(none listed)'}. Do not claim a skill, tool, or certification that is not in that list.`,
    `Target length: ${minWords}-${maxWords} words total across ${MIN_BODY_PARAGRAPHS}-${MAX_BODY_PARAGRAPHS} paragraphs, separated by a blank line.`,
    // Live runs undershot this every time -- 190 words against a 225 minimum,
    // on all three attempts, with the shortfall fed back each time. A range
    // stated once reads as a suggestion; the floor has to be stated as a
    // requirement, at the point the model is deciding to stop writing.
    `HARD MINIMUM: ${minWords} words. A letter under ${minWords} words is a failed response and`
    + ' will be rejected. Count as you write, and if you are short, develop a specific example from'
    + ' the resume rather than padding with adjectives.',
    buildCoverLetterPreferencesSection(prefs),
  ];
  if (avoidNotes && avoidNotes.length) {
    systemLines.push(`Issues found in a previous attempt — do not repeat them: ${avoidNotes.join(' | ')}`);
  }

  // Deliberately excludes the candidate's name and contact details: the
  // model has no reason to know them (it never writes the greeting or
  // sign-off) and not sending them is what makes a "John Doe" signature
  // structurally impossible rather than merely discouraged.
  const userLines = [
    `TARGET JOB TITLE: ${job.title || '(not specified)'}`,
    `COMPANY: ${job.company || '(not specified)'}`,
    `CANDIDATE BACKGROUND (summary and skills only):\n${model.summary || '(none)'}\n${skills}`,
    `JOB DESCRIPTION:\n${String(job.description || '').slice(0, JD_MAX_CHARS)}`,
  ];

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ];
}

/**
 * @returns {Promise<{paragraphs: string[], report: object}>}
 *   report.status is one of: approved | approved_with_warning |
 *   fallback_after_validation | failed_after_retries
 */
export async function generateCoverLetter({
  model,
  job,
  preferences,
  provider,
  apiKey,
  modelName,
  maxAttempts = 3,
  validationMode = 'normal',
  fetchImpl,
  timeoutMs,
  sleepImpl,
  callLlm,
}) {
  const prefs = preferences || factoryPreferences();
  const [minWords, maxWords] = coverLetterWordRange(prefs);
  const skillsBoundary = resumeSkillsBoundary(model);

  let avoidNotes = [];
  const failedAttempts = [];
  let lastValidation = null;
  let lastParagraphs = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildCoverLetterMessages({ model, job, preferences: prefs, avoidNotes });
    const response = callLlm
      ? await callLlm({
        messages, maxTokens: COVER_LETTER_MAX_TOKENS, reasoningEffort: 'none',
        // Prose, not JSON: the .env leads this chain with gemma-4-31b, the
        // very model it excludes from resume JSON.
        task: 'coverLetter',
      })
      : await chatWithRetry(
        {
          provider, apiKey, model: modelName, messages,
          maxTokens: COVER_LETTER_MAX_TOKENS, reasoningEffort: 'none', fetchImpl, timeoutMs,
        },
        { sleepImpl },
      );

    const cleaned = sanitizeText(response.content).trim();
    const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const validation = validateCoverLetter(paragraphs, { mode: validationMode, minWords, maxWords, skillsBoundary });

    lastValidation = validation;
    lastParagraphs = paragraphs;

    if (validation.passed) {
      return {
        paragraphs,
        report: {
          // Lenient mode skipped the length/paragraph checks entirely, so
          // a bare "approved" there would overstate what was verified.
          status: validationMode === 'lenient' ? 'approved_with_warning' : 'approved',
          attempts: attempt,
          validator: validation,
        },
      };
    }

    if (paragraphs.length) failedAttempts.push({ attempt, paragraphs, validation });
    avoidNotes = validation.errors;
  }

  if (failedAttempts.length) {
    const best = failedAttempts.reduce((a, b) => (
      compareScores(fallbackScore(a.validation, minWords, maxWords), fallbackScore(b.validation, minWords, maxWords)) <= 0 ? a : b
    ));
    return {
      paragraphs: best.paragraphs,
      report: {
        status: 'fallback_after_validation',
        attempts: maxAttempts,
        selectedAttempt: best.attempt,
        validator: best.validation,
        attemptValidations: failedAttempts.map((c) => ({ attempt: c.attempt, validator: c.validation })),
      },
    };
  }

  return {
    paragraphs: lastParagraphs,
    report: { status: 'failed_after_retries', attempts: maxAttempts, validator: lastValidation },
  };
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Greeting and sign-off are built here, never by the LLM. Same Arial/10.5pt
 * body as the resume template so the two documents look like a set
 * (cover_letter.py:288-292 records this as a direct user preference, not an
 * incidental choice).
 */
/**
 * The "Re:" line, built defensively.
 *
 * job.title comes from page scraping, which returns whatever the page had --
 * including a signed-in greeting. Printing an implausible title verbatim
 * produced "Re: Welcome, Juan at TP Canada" on a real letter. When the title
 * cannot be trusted the subject degrades to the company alone, or is dropped
 * entirely: a letter with no subject line reads as a stylistic choice, while
 * a letter addressed to a greeting reads as a machine that was not checked.
 */
export function coverLetterSubject(job = {}, model = {}) {
  const company = String(job.company || '').trim();
  const title = String(job.title || '').trim();
  const usable = isPlausibleJobTitle(title, model.name);

  if (usable && company) return `Re: ${title} at ${company}`;
  if (usable) return `Re: ${title}`;
  if (company) return `Re: Application to ${company}`;
  return '';
}

export function renderCoverLetterHtml({ bodyParagraphs, model, job }) {
  const name = escapeHtml(model.name || 'Candidate');
  const contactLine = escapeHtml(model.contact ? model.contact.split('\n').join(' | ') : '');
  const jobLine = escapeHtml(coverLetterSubject(job, model));
  const body = bodyParagraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${name} — Cover Letter</title>
<style>
  @page { size: letter; margin: 0.85in; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; }
  .sheet { max-width: 7.5in; margin: 0 auto; padding: 0.4in; }
  p { margin-bottom: 1em; text-align: left; }
  .cl-header { margin-bottom: 24px; padding-bottom: 6px; border-bottom: 1.5px solid #1a1a1a; }
  .cl-name { font-size: 18pt; font-weight: 700; }
  .cl-contact, .cl-job { font-size: 9.5pt; color: #555; }
  .cl-job { margin-top: 2px; }
  .bold-line { font-weight: 700; }
  .print-hint { background: #e0edee; border: 1px solid #0f6e78; border-radius: 4px; padding: 10px 14px; margin-bottom: 16px; font-size: 10pt; }
  @media print { .print-hint, .print-actions { display: none; } }
</style>
</head>
<body>
  <div class="print-hint">
    Before printing: open <strong>More settings</strong> and uncheck <strong>Headers and footers</strong> —
    Chrome prints a date, this page's title, and its URL onto the page by default, and no amount of
    styling here can turn that off.
  </div>
  <div class="print-actions" style="margin-bottom:16px;">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">
    <div class="cl-header">
      <div class="cl-name">${name}</div>
      <div class="cl-contact">${contactLine}</div>
      ${jobLine ? `<div class="cl-job">${jobLine}</div>` : ''}
    </div>
    <p class="bold-line">Dear Hiring Manager,</p>
    ${body}
    <p class="bold-line">Sincerely,<br />${name}</p>
  </div>
</body>
</html>`;
}
