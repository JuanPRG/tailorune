// tailorSkills.js — aggressive skills-section tailoring, with a hard
// retention guard.
//
// Ported from v4/tailor.py's `tailor_skill_blocks` /
// `build_skills_tailor_prompt`. This is deliberately its OWN call and
// prompt rather than folded into the main resume pass, for the reason v4
// states directly (tailor.py:352-356): a bare keyword list has no
// "same real activity" anchor the way a bullet does, so this pass is
// allowed to do things the bullet pass must never do — add plausible
// adjacent skills, reword toward the posting's language, reorder, drop the
// least relevant — and the one ground rule is enforced *deterministically*
// here rather than merely requested in the prompt.
//
// The guard: at least MIN_SKILLS_RETENTION_RATIO of each line's original
// comma-separated items must survive verbatim. A line that fails reverts to
// its original text and is retried; it is never silently accepted. That is
// what keeps the section anchored to the real candidate instead of becoming
// a wish list assembled from the job posting.

import { chatWithRetry, LlmError } from './llm.js';
import { parseLlmJson } from './tailor.js';
import { sanitizeText } from './textUtils.js';

export const MIN_SKILLS_RETENTION_RATIO = 0.20;

// A live run truncated EVERY call in this pass: 1024 tokens with thinking left
// on is not enough to finish even a short JSON answer, so the pass reported
// "no_change" while actually failing. Thinking off, and headroom above what
// the answer needs.
export const SKILLS_MAX_TOKENS = 2048;
const JD_MAX_CHARS = 4000; // matches tailor.py:378
const SKILLS_LABEL_RE = /^([^:]{1,40}:)\s*(.*)$/;

/**
 * Split a skills line into its comma-separated items, dropping any leading
 * "Label:" category prefix so the label is never counted as an item to
 * retain or replace.
 */
export function splitSkillItems(text) {
  const match = SKILLS_LABEL_RE.exec(String(text ?? ''));
  const rest = match ? match[2] : String(text ?? '');
  return rest.split(',').map((item) => item.trim()).filter(Boolean);
}

/** @returns {number} fraction of the original line's items still present verbatim */
export function skillsRetentionRatio(originalText, newText) {
  const originalItems = splitSkillItems(originalText);
  if (!originalItems.length) return 1.0;
  const newItems = new Set(splitSkillItems(newText).map((i) => i.toLowerCase()));
  const kept = originalItems.filter((item) => newItems.has(item.toLowerCase())).length;
  return kept / originalItems.length;
}

export function buildSkillsMessages({ lines, indices, job, avoidNotes }) {
  const pct = Math.round(MIN_SKILLS_RETENTION_RATIO * 100);
  const systemLines = [
    "You are aggressively tailoring the items in a resume's skills/competencies section so the candidate looks like the strongest possible fit for a job posting. The candidate alone decides whether to submit the result, so lean toward making them look as strong as honestly plausible.",
    "You may add relevant skills, tools, or competencies that plausibly extend the candidate's real background toward what the job posting wants, reword existing items toward the job posting's own language, reorder items, and drop less relevant ones.",
    `Ground rule: for each block, keep at least ${pct}% of its original items completely unchanged (verbatim) — never replace everything in a block.`,
    'Category labels (e.g. "Finance:", "Tools:") must be kept exactly as given.',
    'Return ONLY a JSON object mapping each block index (as a string) to its new text, e.g. {"2": "new text"}. Include every block you were given.',
  ];
  if (avoidNotes && avoidNotes.length) {
    systemLines.push(`Issues found in a previous attempt — do not repeat them: ${avoidNotes.join(' | ')}`);
  }

  const numbered = indices.map((idx, i) => `[${idx}] ${lines[i]}`).join('\n');
  const userLines = [
    `TARGET JOB TITLE: ${job.title || '(not specified)'}`,
    `JOB DESCRIPTION:\n${String(job.description || '').slice(0, JD_MAX_CHARS)}`,
    `\nSKILLS/COMPETENCIES BLOCKS (numbered):\n${numbered}`,
  ];

  return [
    { role: 'system', content: systemLines.join('\n') },
    { role: 'user', content: userLines.join('\n') },
  ];
}

/**
 * @param {object} opts
 * @param {string[]} opts.skillsLines - the resume's skills lines, in order
 * @returns {Promise<{lines: string[], report: object}>}
 */
export async function tailorSkills({
  skillsLines, job, provider, apiKey, modelName,
  maxAttempts = 2, demoteLast, fetchImpl, timeoutMs, sleepImpl,
  callLlm,
}) {
  if (!skillsLines || !skillsLines.length) {
    return { lines: [], report: { status: 'no_change', attempts: 0, reverted: [], note: 'no skills lines' } };
  }

  const result = [...skillsLines];
  // Track which line indices still need a usable answer, so a retry only
  // re-asks about the lines that actually failed the guard.
  let remaining = skillsLines.map((_, index) => index);
  let avoidNotes = [];
  let reverted = [];
  let changedAny = false;
  let attempt = 0;

  while (remaining.length && attempt < maxAttempts) {
    attempt += 1;
    const messages = buildSkillsMessages({
      lines: remaining.map((i) => skillsLines[i]),
      indices: remaining,
      job,
      avoidNotes,
    });

    let response;
    try {
      response = callLlm
        ? await callLlm({
          messages, jsonMode: true, maxTokens: SKILLS_MAX_TOKENS,
          reasoningEffort: 'none',
          // The other strict-JSON pass, so it shares the resume policy: same
          // shape of work, same failure when a model cannot hold a schema.
          task: 'skills',
        })
        : await chatWithRetry(
          {
            provider, apiKey, model: modelName, messages, jsonMode: true,
            maxTokens: SKILLS_MAX_TOKENS, reasoningEffort: 'none', fetchImpl, timeoutMs,
          },
          { sleepImpl },
        );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('network_error', String((err && err.message) || err));
    }

    const proposed = parseLlmJson(response.content);
    reverted = [];
    const stillUnresolved = [];

    for (const index of remaining) {
      const raw = proposed[String(index)];
      if (raw === undefined || raw === null) {
        stillUnresolved.push(index);
        continue;
      }
      const newText = sanitizeText(String(raw)).trim();
      if (!newText) {
        stillUnresolved.push(index);
        continue;
      }
      const ratio = skillsRetentionRatio(skillsLines[index], newText);
      if (ratio < MIN_SKILLS_RETENTION_RATIO) {
        // Deterministic revert, not a warning: the original line stays.
        reverted.push(`block_${index}_retention_${Math.round(ratio * 100)}%_below_${Math.round(MIN_SKILLS_RETENTION_RATIO * 100)}%`);
        stillUnresolved.push(index);
        continue;
      }
      result[index] = newText;
      changedAny = true;
    }

    remaining = stillUnresolved;
    if (reverted.length && attempt < maxAttempts && demoteLast) {
      demoteLast(`skills reverted: ${reverted.length} line(s)`);
    }
    avoidNotes = reverted;
  }

  return {
    lines: result,
    report: {
      status: changedAny ? 'approved' : 'no_change',
      attempts: attempt,
      reverted,
    },
  };
}
