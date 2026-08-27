// tailor.js — the tailoring pipeline: build the prompt, call the LLM once,
// parse its answer, apply it, and enforce the one-page word budget.
//
// Ported from hirepilot_v4/tailor.py's `tailor_editable_blocks`. This pass
// handles the summary and per-role bullets; the skills section is a separate
// call with different rules and its own deterministic guard, in
// tailorSkills.js (v4 splits them the same way, and tailor.py:352-356
// explains why).
//
// The deterministic validator (validateTailoredModel) and the semantic judge
// (judge.js) are complementary, not redundant: the validator catches
// watchlisted-title fabrication, dropped bullets, and thin summaries; the
// judge catches a rewrite that swaps in a different-but-plausible activity,
// which no deterministic check can see. Both feed the same retry loop.
//
// Locked fields (name, contact, every entry's title/meta, education) are
// never included in the prompt below — see resumeModel.js's module comment
// for why that is the actual anti-fabrication guarantee, not the instruction
// text.

import { chatWithRetry, LlmError } from './llm.js';
import { flattenEditableEntries, applyTailoredContent, compactToWordBudget, modelWordCount } from './resumeModel.js';
import { buildResumePreferencesSection, factoryPreferences } from './preferences.js';
import {
  sanitizeText, fabricatedRoleTitles, modelFullText,
  conceptTokens, conceptRetentionRatio, droppedNumbers,
} from './textUtils.js';

export const ONE_PAGE_WORD_BUDGET = 570; // measured in SPIKE_FINDINGS.md: 571 words -> 1 page, 649 -> 2
const JD_MAX_CHARS = 6000; // matches hirepilot_v4/tailor.py:160

/**
 * json.loads-then-brace-slice-salvage, ported from
 * hirepilot_v4/tailor.py:167-179 (`_parse_llm_json`). Also strips a leading
 * markdown code fence, the same normalization fill_mapper.py:382-394 applies
 * before its own brace-slice.
 */
export function parseLlmJson(raw) {
  let text = String(raw).trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function buildTailorMessages(model, jobDescription, preferences, avoidNotes) {
  const entries = flattenEditableEntries(model);
  const jd = String(jobDescription || '').slice(0, JD_MAX_CHARS);
  const prefs = preferences || factoryPreferences();

  // role_label is a generic ordinal ("Role 1", "Role 2"), never the entry's
  // real title/company/dates -- those are locked and must not enter the
  // prompt at all, not even as read-only context. Matches
  // hirepilot_v4/tailor.py's own framing: the model sees bullets only, never
  // the employer or title they belong to.
  const entriesForPrompt = entries.map((e) => ({
    index: e.index,
    role_label: `Role ${e.index + 1}`,
    current_bullets: e.bullets,
  }));

  const systemLines = [
    'You tailor resume content to a specific job description.',
    'You will be given ONLY the editable portions of a resume: the professional summary and'
    + ' per-role bullet points. Everything else — the name, contact info, job titles, dates,'
    + ' company names, and education — has already been removed from your view and CANNOT be'
    + ' changed by you, because you are not shown it.',
    'Do not invent employers, dates, titles, or credentials. Rewrite only what is given.',
    'Keep bullets concise and quantified where the original supports it — the whole resume'
    + ` must fit roughly ${ONE_PAGE_WORD_BUDGET} words total, so favor tight, high-signal bullets.`,
    // The single most common way a rewrite makes a resume worse. Screening is
    // keyword-driven first, so trading "bookkeeping, IFRS, budget tracking"
    // for "comprehensive financial administration" loses the candidate real
    // matches while sounding more senior. Stated as a rule and enforced
    // afterwards by conceptRetentionRatio, because instructions alone do not
    // hold across models.
    'CARRY OVER THE CONCRETE WORDS. Keep every number, percentage, currency amount and'
    + ' quantity exactly as written, and keep the specific nouns the original used — tools,'
    + ' systems, standards, processes, certifications, domain terms. Rephrase around them;'
    + ' never replace them with generic descriptions. "Reconciled accounts payable in NetSuite"'
    + ' may not become "managed comprehensive financial workflows".',
    'Prefer adding a job-description keyword alongside an original term to swapping one for'
    + ' the other. Do not pad with adjectives like comprehensive, robust, strategic or'
    + ' meticulous; they match nothing and consume the word budget.',
    // The opposite failure, and a real one: told firmly enough to keep the
    // concrete words, a model will satisfy that by returning the input
    // verbatim. Both directions have to be named, or fixing one causes the
    // other.
    'BUT ACTUALLY REWRITE. Copying a bullet or the summary back unchanged is a failed'
    + ' response, not a safe one. Every bullet must be re-framed for THIS job — change the'
    + ' emphasis, the ordering, and what leads the sentence — while the concrete terms above'
    + ' travel with it. Keep the nouns, change the framing.',
    buildResumePreferencesSection(prefs),
    'Respond with ONLY a JSON object of this exact shape, no prose, no markdown fence:',
    '{"summary": "...", "entries": [{"index": 0, "bullets": ["...", "..."]}]}',
  ];
  if (avoidNotes && avoidNotes.length) {
    systemLines.push(`Issues found in a previous attempt — do not repeat them: ${avoidNotes.join(' | ')}`);
  }
  const system = systemLines.join('\n');

  const user = [
    `JOB DESCRIPTION:\n${jd}`,
    `CURRENT SUMMARY:\n${model.summary || '(none provided)'}`,
    `EDITABLE ROLE ENTRIES (rewrite bullets only, keep the same number of entries and indices):\n${JSON.stringify(entriesForPrompt, null, 2)}`,
  ].join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const MIN_SUMMARY_WORDS = 20; // matches hirepilot_v4/tailor.py's _MIN_SUMMARY_WORDS

// Share of a bullet's concrete vocabulary that must survive rewriting.
//
// Calibrated against a real run rather than picked: a tailoring pass that
// visibly hollowed out its bullets -- "bookkeeping, financial reporting,
// budget tracking" becoming "comprehensive financial administration" -- scored
// 27-33% per role. 45% flags every one of those while still permitting a
// heavy rewrite, since it means over half the wording may still change.
//
// The summary is deliberately NOT checked. It is a positioning statement, and
// rewriting it wholesale for a specific job is the legitimate core of
// tailoring; the same run scored 15% there and that was the right outcome.
export const MIN_BULLET_CONCEPT_RETENTION = 0.45;

/**
 * Deterministic post-generation checks, ported in spirit from
 * hirepilot_v4/tailor.py's `validate_tailored_blocks`.
 *
 * Note what this deliberately does NOT check: whether a rewritten bullet
 * still describes the same real activity as its original. That is a semantic
 * comparison, it needs the original text alongside the rewrite, and it is
 * the judge's job (judge.js) -- not something a watchlist can approximate.
 *
 * @param {object} original - the pre-tailoring model, as the source of truth
 * @param {object} tailored - the post-application model
 */
export function validateTailoredModel(original, tailored) {
  const errors = [];
  const warnings = [];

  const sourceText = modelFullText(original);
  const newText = modelFullText(tailored);

  // Professional-identity fabrication: a role title claimed in the tailored
  // output that appears nowhere in the candidate's real source material.
  const fabricatedTitles = [...fabricatedRoleTitles(sourceText, newText)].sort();
  if (fabricatedTitles.length) {
    errors.push(`Claims a professional identity absent from the source resume: ${fabricatedTitles.join(', ')}`);
  }

  if (tailored.summary) {
    const summaryWords = (tailored.summary.match(/\S+/g) || []).length;
    if (summaryWords < MIN_SUMMARY_WORDS) {
      warnings.push(`Summary is only ${summaryWords} words (expected at least ${MIN_SUMMARY_WORDS}).`);
    }
  }

  // An entry that had bullets and now has none means content was lost, not
  // tailored -- worth surfacing rather than shipping a thinner resume.
  const originalEntries = flattenEditableEntries(original);
  const tailoredEntries = flattenEditableEntries(tailored);
  for (let i = 0; i < originalEntries.length; i++) {
    if (originalEntries[i].bullets.length > 0 && (tailoredEntries[i]?.bullets.length ?? 0) === 0) {
      errors.push(`Role ${i + 1} lost all of its bullet points.`);
      continue;
    }

    const before = originalEntries[i].bullets.join(' ');
    const after = (tailoredEntries[i]?.bullets ?? []).join(' ');
    if (!before) continue;

    // Quantities are never a stylistic choice: "a team of 15+" outperforms
    // "cross-functional teams" for every reader, human or machine.
    const lostNumbers = droppedNumbers(before, after);
    if (lostNumbers.length) {
      errors.push(`Role ${i + 1} dropped quantities that were in the original: ${lostNumbers.join(', ')}. Put them back.`);
    }

    // Concreteness. Errors rather than warnings so the retry loop feeds the
    // specific missing terms back into the next attempt -- they come from the
    // original bullets, which the model is already shown, so naming them
    // leaks nothing locked.
    const retention = conceptRetentionRatio(before, after);
    if (retention < MIN_BULLET_CONCEPT_RETENTION) {
      const beforeTokens = conceptTokens(before);
      const afterTokens = conceptTokens(after);
      const lost = [...beforeTokens].filter((t) => !afterTokens.has(t)).slice(0, 12);
      errors.push(
        `Role ${i + 1} kept only ${Math.round(retention * 100)}% of the original's specific vocabulary`
        + ` (needs ${Math.round(MIN_BULLET_CONCEPT_RETENTION * 100)}%). Rephrase around these instead of`
        + ` replacing them: ${lost.join(', ')}.`,
      );
    }
  }

  // A rewrite that returns everything unchanged scores perfectly on every
  // check above -- full retention, no dropped numbers, nothing fabricated --
  // and is a total failure of the task. Without this, the retention floor
  // added below actively rewards copying: an untailored resume shipped as
  // "approved", and the only honest signal was that the text was identical
  // to the upload.
  const normalize = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const rolesUnchanged = originalEntries.length > 0 && originalEntries.every((entry, i) => (
    normalize(entry.bullets.join(' ')) === normalize((tailoredEntries[i]?.bullets ?? []).join(' '))
  ));
  const summaryUnchanged = normalize(original.summary) === normalize(tailored.summary);
  if (rolesUnchanged && summaryUnchanged) {
    errors.push(
      'The response returned the summary and every bullet unchanged — nothing was tailored.'
      + ' Re-frame each bullet for this job while keeping its concrete terms.',
    );
  } else if (rolesUnchanged) {
    warnings.push('Every role came back with its bullets unchanged; only the summary was tailored.');
  }

  return { passed: errors.length === 0, errors, warnings };
}

/**
 * @returns {Promise<{model: object, wordCount: number, compactionIterations: number, raw: string, report: object}>}
 */
export async function tailorResume({
  model, jobDescription, provider, apiKey, modelName,
  preferences, maxAttempts = 2,
  fetchImpl, timeoutMs, maxRetries, sleepImpl,
  callLlm, judge, job,
}) {
  const prefs = preferences || factoryPreferences();
  let avoidNotes = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildTailorMessages(model, jobDescription, prefs, avoidNotes);

    let response;
    try {
      // callLlm lets the pipeline inject the rotating multi-provider caller.
      // Without it this falls back to a single provider with retries, which
      // is what the unit tests exercise.
      response = callLlm
        ? await callLlm({ messages, jsonMode: true })
        : await chatWithRetry(
          { provider, apiKey, model: modelName, messages, jsonMode: true, fetchImpl, timeoutMs },
          { maxRetries, sleepImpl },
        );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('network_error', String(err && err.message || err));
    }

    const tailored = parseLlmJson(response.content);
    // sanitizeText on the way in, so em dashes and smart quotes the model
    // produced never reach the rendered document.
    if (typeof tailored.summary === 'string') tailored.summary = sanitizeText(tailored.summary);
    if (Array.isArray(tailored.entries)) {
      for (const entry of tailored.entries) {
        if (Array.isArray(entry.bullets)) entry.bullets = entry.bullets.map((b) => sanitizeText(String(b)));
      }
    }

    const applied = applyTailoredContent(model, tailored);
    const validation = validateTailoredModel(model, applied);

    // The semantic judge only runs once the cheap deterministic checks pass
    // -- no point paying for a review of content already known to be
    // invalid. `judge` is injected so it stays optional and testable.
    let judgeResult = null;
    if (validation.passed && judge) {
      judgeResult = await judge({ original: model, tailored: applied, job: job || { description: jobDescription } });
    }

    const { model: compacted, wordCount, iterations } = compactToWordBudget(applied, ONE_PAGE_WORD_BUDGET);
    const judgePassed = !judgeResult || judgeResult.passed;

    lastResult = {
      model: compacted,
      wordCount,
      compactionIterations: iterations,
      raw: response.content,
      usage: response.usage,
      report: {
        status: validation.passed && judgePassed ? 'approved' : 'pending',
        attempts: attempt,
        validator: validation,
        judge: judgeResult,
      },
    };

    if (validation.passed && judgePassed) return lastResult;
    // Feed whichever check failed back into the next attempt.
    avoidNotes = validation.passed ? judgeResult.issues : validation.errors;
  }

  // Every attempt failed validation. Return the last one with an honest
  // status rather than a hardcoded "approved" -- the caller decides whether
  // to surface it, exactly as v4's cover-letter path does.
  lastResult.report.status = 'fallback_after_validation';
  return lastResult;
}

export { modelWordCount };
