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

export function buildTailorMessages(model, jobDescription) {
  const entries = flattenEditableEntries(model);
  const jd = String(jobDescription || '').slice(0, JD_MAX_CHARS);

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

  const system = [
    'You tailor resume content to a specific job description.',
    'You will be given ONLY the editable portions of a resume: the professional summary and',
    'per-role bullet points. Everything else — the name, contact info, job titles, dates,',
    'company names, and education — has already been removed from your view and CANNOT be',
    'changed by you, because you are not shown it.',
    'Do not invent employers, dates, titles, or credentials. Rewrite only what is given.',
    'Keep bullets concise and quantified where the original supports it — the whole resume',
    `must fit roughly ${ONE_PAGE_WORD_BUDGET} words total, so favor tight, high-signal bullets.`,
    'Respond with ONLY a JSON object of this exact shape, no prose, no markdown fence:',
    '{"summary": "...", "entries": [{"index": 0, "bullets": ["...", "..."]}]}',
  ].join(' ');

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

/**
 * @returns {Promise<{model: object, wordCount: number, compactionIterations: number, raw: string}>}
 */
export async function tailorResume({ model, jobDescription, provider, apiKey, modelName, fetchImpl, timeoutMs, maxRetries, sleepImpl }) {
  const messages = buildTailorMessages(model, jobDescription);

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
  const applied = applyTailoredContent(model, tailored);
  const { model: compacted, wordCount, iterations } = compactToWordBudget(applied, ONE_PAGE_WORD_BUDGET);

  return {
    model: compacted,
    wordCount,
    compactionIterations: iterations,
    raw: response.content,
    usage: response.usage,
  };
}

export { modelWordCount };
