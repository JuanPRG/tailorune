// judge.js — second-pass semantic review of tailored resume content.
//
// Ported from hirepilot_v4/tailor.py's `judge_tailored_blocks`. This closes a
// gap that `validateTailoredModel()` genuinely cannot: that validator checks
// role-title fabrication against a watchlist, dropped bullets, and summary
// length — none of which catch a rewrite that swaps in a *different but
// plausible-sounding* activity. v4's own docstring is explicit about why the
// original text has to be shown alongside each rewrite:
//
//   "Needs the original text alongside each rewrite to tell those two apart
//    at all; without it, a rewrite that swaps in a wholly different (but
//    plausible-sounding) activity is invisible to this check."
//
// The failure mode this exists for:
//
//   ORIGINAL:  "Resolved 40 support tickets weekly, 96% satisfaction"
//   REWRITTEN: "Architected a distributed caching layer serving 2M req/day"
//
// Both plausible; no watchlisted title; no bullets dropped. Deterministic
// checks pass it. Only a semantic comparison catches it.
//
// Two properties carried over deliberately:
//   - FAILS OPEN. A judge error, a timeout, or a malformed response returns
//     `passed: true` with a `judgeError` recorded. A safety net that becomes
//     a hard blocker when the network hiccups is worse than no safety net.
//   - ADVISORY. Its issues feed the retry loop's avoid-notes rather than
//     discarding the work outright.

import { flattenEditableEntries } from './resumeModel.js';
import { parseLlmJson } from './tailor.js';

const JD_MAX_CHARS = 3000; // matches tailor.py:304

/** Build the ORIGINAL/REWRITTEN pair list the judge compares. */
export function buildJudgePairs(original, tailored) {
  const pairs = [];
  // Only review what actually changed -- an untouched summary is not worth
  // the tokens, and the same rule is applied to bullets below.
  if ((original.summary || '') !== (tailored.summary || '')) {
    pairs.push({
      label: 'SUMMARY',
      original: original.summary || '(none)',
      rewritten: tailored.summary || '(none)',
    });
  }
  const originalEntries = flattenEditableEntries(original);
  const tailoredEntries = flattenEditableEntries(tailored);
  for (let i = 0; i < originalEntries.length; i++) {
    const before = originalEntries[i].bullets;
    const after = (tailoredEntries[i] && tailoredEntries[i].bullets) || [];
    // Unchanged content is not worth a judge's attention or the tokens.
    if (before.join('\n') === after.join('\n')) continue;
    pairs.push({
      label: `ROLE ${i + 1} BULLETS`,
      original: before.join('\n') || '(none)',
      rewritten: after.join('\n') || '(none)',
    });
  }
  return pairs;
}

export function buildJudgeMessages({ pairs, job }) {
  const joined = pairs
    .map((p) => `[${p.label}]\n  ORIGINAL: ${p.original}\n  REWRITTEN: ${p.rewritten}`)
    .join('\n\n');

  const prompt = [
    "You are reviewing a tailored resume's summary and bullet points against a job posting.",
    'Each item below shows its ORIGINAL text and the REWRITTEN version. Aggressive reframing,',
    "full rewrites, emphasizing transferable skills, and leaning into the job posting's own",
    'vocabulary are all expected and fine — do not flag those.',
    'Respond ONLY with JSON: {"passed": true|false, "issues": ["..."]}.',
    'Flag an item ONLY if: (1) the REWRITTEN text describes a genuinely different real activity,',
    'task, or deliverable than the ORIGINAL — not just different words, but a different real thing',
    'than what actually happened — or (2) it reads as fabricated/exaggerated beyond what the',
    "ORIGINAL supports, or (3) it completely ignores the job posting's key requirements.",
    'Do not flag rephrasing, reordering, or vocabulary shifts that still describe the same',
    'underlying activity.',
    '',
    `JOB TITLE: ${job.title || '(not specified)'}`,
    `JOB DESCRIPTION:\n${String(job.description || '').slice(0, JD_MAX_CHARS)}`,
    '',
    `ITEMS:\n${joined}`,
  ].join('\n');

  return [{ role: 'user', content: prompt }];
}

/**
 * @returns {Promise<{passed: boolean, issues: string[], judgeError?: string, skipped?: boolean}>}
 */
export async function judgeTailoredModel({ original, tailored, job, callLlm }) {
  const pairs = buildJudgePairs(original, tailored);
  // Nothing actually changed -- there is nothing to review, and spending a
  // call to confirm that would be pure waste.
  if (!pairs.length) return { passed: true, issues: [], skipped: true };

  let response;
  try {
    response = await callLlm({
      messages: buildJudgeMessages({ pairs, job }),
      jsonMode: true,
      maxTokens: 2048,
      // Same finding as the other passes: 1024 with thinking on truncated
      // every call, and this one fails open -- so a truncated judge silently
      // became "passed" and reviewed nothing.
      reasoningEffort: 'none',
      // LLM_JUDGE_PREFERRED_MODELS leads with qwen3.6, not the resume model.
      task: 'judge',
    });
  } catch (err) {
    // Fail open, deliberately -- see this module's header.
    return { passed: true, issues: [], judgeError: String((err && err.message) || err) };
  }

  const parsed = parseLlmJson(response.content);
  if (!parsed || typeof parsed !== 'object' || !('passed' in parsed)) {
    return { passed: true, issues: [], judgeError: 'malformed_response' };
  }
  return {
    passed: Boolean(parsed.passed),
    issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
  };
}
