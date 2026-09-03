// resumeLayout.js — the decisions the DOCX, the HTML and the PDF must agree on.
//
// There are three exits from one ResumeModel and they are one design, not
// three: the same line has to become a bullet in all of them, the same meta
// string has to split into the same date and subtitle, and the same section
// has to land in the same position. Until this file existed that agreement
// was maintained by copying -- renderHtml.js carried a comment reading
// "Mirrors renderDocx.js's splitMeta ... a change has to land in both", which
// is an honest description of a rule a compiler cannot enforce.
//
// A third exit is what made it untenable. Three copies of TRAILING_YEAR_RE is
// three chances to make the mistake its own comment already records: `\s` and
// `\d` are not valid escapes inside a template literal, so a pattern built
// that way collapses to bare letters, matches nothing, and reports no error
// at all. It happened once. Copying it twice more invites it back.
//
// So: the shaping lives here and the renderers decide only how to DRAW it.

/** A line that already carries a bullet marker in the source resume. */
export const LEADING_BULLET_RE = /^[-*•▪◦‣]\s+/;

// A line ending in a year or a date range behind real whitespace:
// "Bachelor of Economics   2015", "Advanced Diploma (CPA)   May 2023 - Apr 2026".
// Both reference resumes bold this line and push the year to the right margin
// exactly as they do for a role.
//
// WRITTEN AS A LITERAL, DELIBERATELY. See the note at the top of this file.
export const TRAILING_YEAR_RE = /^(.*\S)\s{2,}((?:[A-Za-z]{3,9}\.?\s+)?\d{4}(?:\s*[-–—]\s*(?:present|current|(?:[A-Za-z]{3,9}\.?\s+)?\d{4}))?)\s*$/i;

/** parseTxt joins a role's meta with " · "; this is the date half. */
export const META_DATE_RE = /^(?:[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})\s*[-–—]\s*(?:present|current|[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})$/i;

/** Longest a role's context can be and still share the title's line. */
export const INLINE_CONTEXT_MAX = 92;

/**
 * Split an entry's meta into the date range and whatever context follows it.
 * "2018 - Present · Colombia (Remote)" -> date at the right margin, context
 * as a subtitle.
 */
export function splitMeta(meta) {
  const parts = String(meta || '').split(' · ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { date: '', context: '' };
  if (META_DATE_RE.test(parts[0])) {
    return { date: parts[0], context: parts.slice(1).join(' · ') };
  }
  return { date: '', context: parts.join(' · ') };
}

/**
 * How one role's header reads: bold headline on the left, date flush right.
 *
 * Short context (a city) joins the title line. Long context -- "Colombia
 * (Remote, Manufacturing and Distribution)" -- drops to its own italic line
 * rather than colliding with the date.
 *
 * @returns {{headline: string, date: string, context: string, inlineContext: boolean}}
 */
export function roleHead(entry) {
  const title = entry.title || '(untitled role)';
  const { date, context } = splitMeta(entry.meta);
  const inlineContext = Boolean(context) && `${title} · ${context}`.length <= INLINE_CONTEXT_MAX;
  return {
    headline: inlineContext ? `${title} · ${context}` : title,
    date,
    context,
    inlineContext,
  };
}

/**
 * What a plain (non-entry) section line is.
 *
 * @returns {{kind: 'bullet'|'dated'|'text', text: string, date?: string}}
 */
export function classifyLine(line) {
  const raw = String(line || '');
  if (LEADING_BULLET_RE.test(raw)) {
    return { kind: 'bullet', text: raw.replace(LEADING_BULLET_RE, '').trim() };
  }
  const dated = TRAILING_YEAR_RE.exec(raw);
  if (dated) return { kind: 'dated', text: dated[1].trim(), date: dated[2].trim() };
  return { kind: 'text', text: raw };
}

/**
 * Every section in the order the source resume put it.
 *
 * Skills is parsed out of `sections` into its own field because it has its own
 * tailoring pass and its own rules -- but that must not decide where it
 * PRINTS. parseTxt records each block's position, so a resume that ends with
 * skills comes back ending with skills. Models built by hand (tests, older
 * callers) carry no order and fall back to skills-first, which is why the
 * default is -1 rather than 0.
 *
 * @returns {Array<{heading: string, kind: 'skills'|'entries'|'lines', lines?: string[], entries?: object[]}>}
 */
export function orderedBlocks(model) {
  const blocks = [];
  if (model.skills && model.skills.lines.length) {
    blocks.push({
      order: model.skills.order ?? -1,
      heading: model.skills.heading || 'SKILLS',
      kind: 'skills',
      lines: model.skills.lines,
    });
  }
  (model.sections || []).forEach((section, i) => {
    blocks.push({
      order: section.order ?? i,
      heading: section.heading,
      kind: section.entries ? 'entries' : 'lines',
      entries: section.entries,
      lines: section.lines,
    });
  });
  blocks.sort((a, b) => a.order - b.order);
  return blocks;
}
