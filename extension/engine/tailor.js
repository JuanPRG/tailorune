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
  sanitizeText, fabricatedRoleTitles, modelFullText, tokenize,
  resumeSkillsBoundary, FABRICATION_WATCHLIST_TERMS,
  conceptTokens, conceptRetentionRatio, droppedNumbers,
} from './textUtils.js';

// Re-measured against the CURRENT template, not inherited.
//
// SPIKE_FINDINGS.md's 570 was measured at Arial 10.5pt with 0.75in margins all
// round. The template has since moved to 10pt with a 0.30in top and a 0.60in
// bottom, and a budget tied to a geometry that no longer exists is not a
// budget. Re-running the same LibreOffice page-count sweep against today's
// renderer put the boundary at 522 words for one page and 543 for two -- so
// 570 was permitting documents that silently ran onto page two, which is the
// one promise this tool makes about the output.
//
// 510 sits under the measured boundary with room for structural variance: the
// exact threshold depends on how many lines the headings and role rows take,
// and erring low costs a few words while erring high costs the page.
export const ONE_PAGE_WORD_BUDGET = 510;
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
    // v4's skills boundary (tailor.py:123-125). Naming the candidate's own
    // declared skills gives the model an explicit allow-list; without it, the
    // only thing between a job description that mentions Kubernetes and a
    // resume that claims it is the model's own restraint. Safe to show —
    // these are the resume's skills section, not a locked field like a title,
    // employer or date.
    skillsBoundaryLine(model),
    // v4 states this separately from the credentials rule (tailor.py:126-127),
    // because an invented team size or percentage is the fabrication people
    // actually get caught on in an interview.
    'Do not invent numbers, metrics, team sizes, or achievements that are not already in the'
    + ' original text. You may rephrase and re-emphasize what is there; you may not add new facts.',
    'Write in natural, human, ATS-friendly language. Avoid AI-sounding phrasing and cliches.',
    'Keep bullets concise and quantified where the original supports it — the whole resume'
    + ` must fit roughly ${ONE_PAGE_WORD_BUDGET} words total, so favor tight, high-signal bullets.`,
    // The mandate comes FIRST and the preservation rule second, deliberately.
    // With the order reversed, a model reads the constraint as the primary
    // instruction and satisfies it by copying the input back — observed
    // twice on real runs, on both attempts, even with the failure fed back.
    'Rewrite every block. Copying a bullet or the summary back unchanged is a failed'
    + ' response, not a safe one. Fully rewrite phrasing, framing and emphasis to speak to this'
    + ' posting\'s language and priorities — do not limit yourself to small keyword swaps.'
    + ' Every rewritten bullet must still describe the exact same real activity as its original,'
    + ' told more compellingly; never substitute a different activity or responsibility.',
    // Ported from v4 (tailor.py:137-145). Without this the model treats a
    // weak connection between a bullet and the posting as grounds to leave
    // the bullet alone — which is how a finance resume against a sales
    // posting came back completely untouched, twice. The examples matter:
    // they show what an honest improvement looks like when there is no
    // domain overlap to lean on.
    'Attempt to improve EVERY block, including the ones with no obvious connection to the'
    + ' posting. A bullet can almost always gain a light keyword or phrasing adjustment —'
    + ' emphasizing process improvement, accuracy, volume, stakeholder communication,'
    + ' cross-functional collaboration, reliability — without inventing anything or changing what'
    + ' it describes. Do NOT leave a block untouched just because the connection is not obvious'
    + ' at first glance; that is exactly the case that most needs a genuine attempt. Leaving a'
    + ' block unchanged should be a rare exception you reach after really trying, never the'
    + ' default for something that looks unrelated.',
    // The single most common way a rewrite makes a resume worse. Screening is
    // keyword-driven first, so trading "bookkeeping, IFRS, budget tracking"
    // for "comprehensive financial administration" loses the candidate real
    // matches while sounding more senior. Enforced afterwards by
    // conceptRetentionRatio, because instructions alone do not hold across
    // models — but framed here as a constraint ON the rewrite above, not as
    // a competing instruction.
    'While rewriting, CARRY OVER THE CONCRETE WORDS. Keep every number, percentage, currency'
    + ' amount and quantity exactly as written, and keep the specific nouns the original used —'
    + ' tools, systems, standards, processes, certifications, domain terms. Rephrase around them;'
    + ' never replace them with generic descriptions. "Reconciled accounts payable in NetSuite"'
    + ' may not become "managed comprehensive financial workflows".',
    'Prefer adding a job-description keyword alongside an original term to swapping one for'
    + ' the other. Do not pad with adjectives like comprehensive, robust, strategic or'
    + ' meticulous; they match nothing and consume the word budget.',
    buildResumePreferencesSection(prefs),
    'Respond with ONLY a JSON object of this exact shape, no prose, no markdown fence:',
    '{"summary": "...", "entries": [{"index": 0, "bullets": ["...", "..."]}]}',
    // v4 repeats the point at the output contract (tailor.py:147-150), where
    // a model deciding what to emit is most likely to take the easy path.
    'Include every entry index you were given. Returning a bullet unchanged should be rare and'
    + ' deliberate, never a default for a block that seems hard to connect to the posting.',
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

// v4's length guard (tailor.py:252-258). A rewrite more than 2.5x the length
// of its original is padding rather than tailoring, and it blows the one-page
// budget that the compactor then has to claw back.
export const MAX_BULLET_LENGTH_RATIO = 2.5;

// The resume pass emits the largest JSON of the three passes: a summary plus
// every bullet of every role. It also runs on reasoning models, where
// max_tokens caps thinking AND output together -- so a hard posting can spend
// the budget before emitting usable JSON, and the truncated answer then fails
// to parse. Skills and cover letter ask for far less and keep their 1024.
export const RESUME_MAX_TOKENS = 4096;

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
/**
 * The candidate's declared skills, as an explicit allow-list for the prompt.
 *
 * Derived from this resume's own skills section rather than a global profile —
 * see resumeSkillsBoundary()'s note on why v4 treats the per-resume
 * derivation as the correct default for a multi-resume library.
 */
function skillsBoundaryLine(model) {
  const skills = [...resumeSkillsBoundary(model)].sort();
  if (!skills.length) {
    return 'This resume has no skills section, so introduce no tool, technology or certification'
      + ' that is not already named in the bullet you are editing.';
  }
  return `The candidate's verified skills and tools are: ${skills.join(', ')}.`
    + ' Do not introduce a skill, tool, certification or technology that is not in that list and'
    + ' not already present in the original text of the bullet you are editing.';
}

/**
 * Repair-first pass, ported from v4 (tailor.py:198-262).
 *
 * v4 reverts an individual offending block to its original text and carries
 * on, rather than failing the whole batch: a bullet that overreached costs
 * that bullet, not the run. Two checks live here rather than in the validator
 * because their correct outcome is a targeted revert, not a verdict on the
 * whole model:
 *
 *   - a bullet introducing a watchlisted tool or certification that is in
 *     neither the job description nor the candidate's own skills;
 *   - a bullet that ballooned past MAX_BULLET_LENGTH_RATIO, which is how a
 *     tight bullet becomes a paragraph and blows the one-page budget.
 *
 * Reverting is index-wise when the model returned the same number of bullets
 * for a role. When the count differs there is no "the original of this
 * bullet" to revert to, so the whole role reverts — the conservative reading,
 * and the only one that cannot silently pair a repaired bullet with an
 * unrepaired neighbour that shared its claim.
 */
export function repairTailoredModel(original, tailored, jobDescription = '') {
  const originalEntries = flattenEditableEntries(original);
  const tailoredEntries = flattenEditableEntries(tailored);
  const jdTokens = tokenize(jobDescription);
  const knownSkills = resumeSkillsBoundary(original);
  const jdLower = String(jobDescription).toLowerCase();
  const warnings = [];
  const repairs = [];

  const fabricatedTerms = (originalText, newText) => {
    const found = new Set();
    const originalTokens = tokenize(originalText);
    for (const token of tokenize(newText)) {
      if (originalTokens.has(token) || jdTokens.has(token) || knownSkills.has(token)) continue;
      if (FABRICATION_WATCHLIST_TERMS.has(token)) found.add(token);
    }
    // Multi-word watchlist entries ("six sigma", "aws certified") never
    // survive tokenization, so they are matched as phrases instead. v4 checks
    // tokens only and misses these.
    const originalLower = String(originalText).toLowerCase();
    const newLower = String(newText).toLowerCase();
    for (const term of FABRICATION_WATCHLIST_TERMS) {
      if (!term.includes(' ')) continue;
      if (newLower.includes(term) && !originalLower.includes(term) && !jdLower.includes(term)) {
        found.add(term);
      }
    }
    return [...found].sort();
  };

  const repairedEntries = tailoredEntries.map((entry, i) => {
    const before = originalEntries[i];
    if (!before) return entry;

    const sameCount = before.bullets.length === entry.bullets.length;
    const wholeRole = { index: entry.index, bullets: [...before.bullets] };
    const bullets = [];

    for (let b = 0; b < entry.bullets.length; b++) {
      const newText = entry.bullets[b];
      const originalText = sameCount ? before.bullets[b] : before.bullets.join(' ');

      const fabricated = fabricatedTerms(originalText, newText);
      if (fabricated.length) {
        warnings.push(
          `Role ${i + 1}: reverted a bullet that introduced ${fabricated.join(', ')}`
          + ' — not in your skills section or the job description.',
        );
        repairs.push(`role_${i + 1}_bullet_${b + 1}_fabrication_reverted`);
        if (!sameCount) return wholeRole;
        bullets.push(originalText);
        continue;
      }

      const originalWords = Math.max(1, String(originalText).split(/\s+/).filter(Boolean).length);
      const newWords = String(newText).split(/\s+/).filter(Boolean).length;
      if (newWords > originalWords * MAX_BULLET_LENGTH_RATIO) {
        warnings.push(
          `Role ${i + 1}: reverted a bullet that grew to ${newWords} words from ${originalWords}`
          + ' — too long for a one-page resume.',
        );
        repairs.push(`role_${i + 1}_bullet_${b + 1}_too_long_reverted`);
        if (!sameCount) return wholeRole;
        bullets.push(originalText);
        continue;
      }

      bullets.push(newText);
    }
    return { index: entry.index, bullets };
  });

  if (!repairs.length) return { model: tailored, warnings, repairs };

  const repaired = applyTailoredContent(original, {
    summary: tailored.summary,
    entries: repairedEntries.map((e) => ({ index: e.index, bullets: e.bullets })),
  });
  return { model: repaired, warnings, repairs };
}

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
  // Set when an attempt produced nothing usable, so the final report can say
  // "the model's answer could not be used" instead of the misleading
  // "nothing was tailored" -- which reads as a model that declined to work.
  let malformedReason = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const messages = buildTailorMessages(model, jobDescription, prefs, avoidNotes);

    let response;
    try {
      // callLlm lets the pipeline inject the rotating multi-provider caller.
      // Without it this falls back to a single provider with retries, which
      // is what the unit tests exercise.
      response = callLlm
        ? await callLlm({ messages, jsonMode: true, maxTokens: RESUME_MAX_TOKENS })
        : await chatWithRetry(
          {
            provider, apiKey, model: modelName, messages, jsonMode: true,
            maxTokens: RESUME_MAX_TOKENS, fetchImpl, timeoutMs,
          },
          { maxRetries, sleepImpl },
        );
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw new LlmError('network_error', String(err && err.message || err));
    }

    const tailored = parseLlmJson(response.content);

    // An unparseable answer must NOT be applied as an empty patch.
    //
    // parseLlmJson returns {} when it cannot salvage an object, and
    // applyTailoredContent then changes nothing -- producing a document
    // byte-identical to the upload. That is indistinguishable from a model
    // choosing to echo its input, and it cost two misdiagnoses: the real
    // cause was a response truncated mid-JSON, and no amount of prompt
    // rewording could fix it. The two failures now report differently.
    const usable = (typeof tailored.summary === 'string' && tailored.summary.trim())
      || (Array.isArray(tailored.entries) && tailored.entries.length > 0);
    if (!usable) {
      const truncated = response.finishReason === 'length';
      const reason = truncated
        ? 'the model ran out of output tokens partway through its answer'
        : 'the model did not return the requested JSON object';
      malformedReason = reason;
      avoidNotes = [
        truncated
          ? 'Your previous answer was cut off before it finished. Return the complete JSON object and keep bullets short.'
          : 'Your previous answer could not be parsed. Return ONLY the JSON object described, with no prose around it.',
      ];
      continue;
    }
    malformedReason = null;
    // sanitizeText on the way in, so em dashes and smart quotes the model
    // produced never reach the rendered document.
    if (typeof tailored.summary === 'string') tailored.summary = sanitizeText(tailored.summary);
    if (Array.isArray(tailored.entries)) {
      for (const entry of tailored.entries) {
        if (Array.isArray(entry.bullets)) entry.bullets = entry.bullets.map((b) => sanitizeText(String(b)));
      }
    }

    // Repair before judging. A single overreaching bullet is reverted to its
    // original rather than costing the whole attempt -- v4's repair-first
    // philosophy, and the reason it degrades gracefully where a batch-level
    // pass/fail would burn a retry on one bad line.
    const applied = applyTailoredContent(model, tailored);
    const repair = repairTailoredModel(model, applied, jobDescription);
    const validation = validateTailoredModel(model, repair.model);
    validation.warnings = [...validation.warnings, ...repair.warnings];

    // The semantic judge only runs once the cheap deterministic checks pass
    // -- no point paying for a review of content already known to be
    // invalid. `judge` is injected so it stays optional and testable.
    let judgeResult = null;
    if (validation.passed && judge) {
      judgeResult = await judge({ original: model, tailored: repair.model, job: job || { description: jobDescription } });
    }

    const { model: compacted, wordCount, iterations } = compactToWordBudget(repair.model, ONE_PAGE_WORD_BUDGET);
    // The judge is ADVISORY: it reports, it never gates and never retries.
    //
    // This is v4's `validation_mode: "lenient"` (tailor.py:494, 508-512),
    // where a judge failure returns immediately as
    // "approved_with_judge_warning" instead of costing an attempt. It is the
    // right default for this tool because of what a judge failure actually
    // means: not "this is wrong" but "this reframing drifted from the
    // original". Feeding that back as an avoid-note asks the model to be more
    // literal on the next pass, which is the opposite of aggressive
    // tailoring -- so the check meant to protect the resume was quietly
    // sanding down the thing the user wants most.
    //
    // Whether an aggressive reframing is acceptable is the candidate's call,
    // not the tool's. It is their resume and their name on the application.
    // Surfacing the finding respects that; overriding it does not.
    const judgePassed = !judgeResult || judgeResult.passed;

    lastResult = {
      model: compacted,
      wordCount,
      compactionIterations: iterations,
      raw: response.content,
      usage: response.usage,
      report: {
        status: validation.passed
          ? (judgePassed ? 'approved' : 'approved_with_judge_warning')
          : 'pending',
        attempts: attempt,
        validator: validation,
        judge: judgeResult,
        // What was silently reverted rather than failed. Reported so an
        // approved run that quietly rolled a bullet back is still visible.
        repairs: repair.repairs,
      },
    };

    // Only the deterministic validator earns another attempt. Its failures are
    // objective and fixable — a dropped quantity, hollowed-out vocabulary, an
    // answer returned unchanged — so naming them gives the model something
    // concrete to correct. A judge finding is a judgement call, and retrying
    // on one just asks for a more literal rewrite.
    if (validation.passed) return lastResult;
    avoidNotes = validation.errors;
  }

  // Every attempt produced nothing usable. Report that plainly, and hand back
  // the untouched resume so the run still yields a document -- but never
  // labelled as though it had been tailored.
  if (!lastResult) {
    const { model: compacted, wordCount, iterations } = compactToWordBudget(model, ONE_PAGE_WORD_BUDGET);
    return {
      model: compacted,
      wordCount,
      compactionIterations: iterations,
      raw: '',
      usage: null,
      report: {
        status: 'malformed_response',
        attempts: maxAttempts,
        validator: {
          passed: false,
          errors: [`Your resume was NOT tailored: ${malformedReason || 'the model returned no usable answer'}. The document below is your original. Try again, or switch provider or model.`],
          warnings: [],
        },
        judge: null,
        repairs: [],
      },
    };
  }

  // Every attempt failed validation. Return the last one with an honest
  // status rather than a hardcoded "approved" -- the caller decides whether
  // to surface it, exactly as v4's cover-letter path does.
  lastResult.report.status = 'fallback_after_validation';
  return lastResult;
}

export { modelWordCount };
