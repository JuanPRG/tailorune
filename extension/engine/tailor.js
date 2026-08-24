// tailor.js — the tailoring pipeline: build the prompt, call the LLM once,
// parse its answer, apply it, and enforce the one-page word budget.
//
// Ported spirit of hirepilot_v4/tailor.py, simplified to one combined call:
// v4 runs two separate LLM steps (tailor_editable_blocks, then
// tailor_skill_blocks with a judge retry loop, tailor.py:451-518). This
// phase-2 slice tailors summary + bullets only and leaves skills untouched —
// an explicit simplification, not an oversight; skills tailoring and the
// judge/retry loop are natural Phase-7 additions once the vertical slice is
// proven.
//
// Locked fields (name, contact, every entry's title/meta, education, skills)
// are never included in the prompt below — see resumeModel.js's module
// comment for why that is the actual anti-fabrication guarantee, not the
// instruction text.

import { chatWithRetry, LlmError } from './llm.js';
import { flattenEditableEntries, applyTailoredContent, compactToWordBudget, modelWordCount } from './resumeModel.js';
import { buildResumePreferencesSection, factoryPreferences } from './preferences.js';
import { sanitizeText, fabricatedRoleTitles, modelFullText } from './textUtils.js';

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

/**
 * Deterministic post-generation checks, ported in spirit from
 * hirepilot_v4/tailor.py's `validate_tailored_blocks`. v4 additionally runs
 * an LLM "judge" pass; that is deliberately not ported — it costs a second
 * call per attempt to re-check things this function already checks
 * deterministically, and the structural guarantee (locked fields never
 * enter the prompt) covers the failure mode the judge existed to catch.
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
    }
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
}) {
  const prefs = preferences || factoryPreferences();
  let avoidNotes = [];
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildTailorMessages(model, jobDescription, prefs, avoidNotes);

    let response;
    try {
      response = await chatWithRetry(
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
    const { model: compacted, wordCount, iterations } = compactToWordBudget(applied, ONE_PAGE_WORD_BUDGET);

    lastResult = {
      model: compacted,
      wordCount,
      compactionIterations: iterations,
      raw: response.content,
      usage: response.usage,
      report: { status: validation.passed ? 'approved' : 'pending', attempts: attempt, validator: validation },
    };

    if (validation.passed) return lastResult;
    avoidNotes = validation.errors;
  }

  // Every attempt failed validation. Return the last one with an honest
  // status rather than a hardcoded "approved" -- the caller decides whether
  // to surface it, exactly as v4's cover-letter path does.
  lastResult.report.status = 'fallback_after_validation';
  return lastResult;
}

export { modelWordCount };
