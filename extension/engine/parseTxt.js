// parseTxt.js — plain-text resume -> ResumeModel.
//
// Ported and simplified from hirepilot_v4's section-detection heuristics
// (docx_ingest.py's _SECTION_HEADER_PATTERNS + state machine, and
// resume_profile.py's date/title extraction) — 100% regex/heuristic, no LLM,
// matching the original's own docstring claim (resume_profile.py:7).
//
// TXT has no bold/style signal, so entry detection relies on structural shape
// alone. The rules, in priority order, are deliberately about SHAPE rather
// than about any particular resume's layout:
//
//   1. A bullet-prefixed line is a bullet.
//   2. A line that is ONLY a date range is metadata. It can never be a title,
//      so it always attaches to the entry above it.
//   3. A line carrying its own date range (leading or trailing) starts a new
//      entry — the date is split off into meta.
//   4. Any other line, while the current entry has no bullets yet, is a
//      context line (employer, location, engagement type) and joins meta.
//   5. Anything else starts a new entry.
//
// Rule 4 is the one that needs care. An earlier version capped it at a single
// context line and treated a bare date line as a new entry, which parsed a
// "Employer / Job Title / Dates" stack — common in consulting and finance
// resumes — as two entries, burying the real title in meta and handing the
// bullets to a phantom entry titled with the date. Rules 2 and 4 are now
// unbounded and shape-based, which handles one context line or three.
//
// Where several lines could each plausibly be "the title", this deliberately
// does NOT guess. It keeps source order: the first line of the block is the
// heading, the rest become meta, and both render adjacently. Guessing which
// of "Deloitte Canada" and "Senior Consultant" is the title is not reliably
// decidable from text alone, and getting it wrong reorders someone's history.

const SECTION_PATTERNS = [
  ['summary', /^(summary|professional summary|profile|about me|career summary|objective)$/i],
  ['skills', /^(technical skills|core skills|skills|technologies|competencies|core competencies|key competencies|areas of expertise|skills\s*(?:&|and)\s*tools)$/i],
  ['experience', /^(work experience|professional experience|experience|employment history|career history)$/i],
  ['projects', /^(technical projects|projects|personal projects|key projects)$/i],
  ['education', /^(education|academic background|educational background)$/i],
];

const BULLET_RE = /^[-*•▪◦‣]\s+/;
const MONTH_YEAR = /[A-Za-z]{3,9}\.?\s+\d{4}/;
const DATE_RANGE_SOURCE = `(?:${MONTH_YEAR.source}|\\d{4})\\s*[-–—]\\s*(?:present|current|${MONTH_YEAR.source}|\\d{4})`;

const DATE_RANGE_RE = new RegExp(`^(?:${DATE_RANGE_SOURCE})$`, 'i');
/** "Senior Engineer, Shopify      2019 - 2024" */
const TRAILING_DATE_RE = new RegExp(`^(.*\\S)\\s{2,}(${DATE_RANGE_SOURCE})\\s*$`, 'i');
/** "2019 - 2024      Senior Engineer, Shopify" — the mirror layout. */
const LEADING_DATE_RE = new RegExp(`^(${DATE_RANGE_SOURCE})\\s{2,}(\\S.*)$`, 'i');

/**
 * A heading this parser does not have a pattern for, e.g. CERTIFICATIONS,
 * AWARDS, PUBLICATIONS, LANGUAGES, VOLUNTEER EXPERIENCE.
 *
 * v4 handles these with a generic-header fallback (docx_ingest.py:259-270).
 * Omitting it meant such a section silently merged into whichever section
 * preceded it — and once entry parsing gained context lines, the certificates
 * were absorbed into a phantom entry's meta, which is worse than merely
 * misfiled.
 *
 * Requiring ALL CAPS is the conservative choice on purpose. A false positive
 * here splits a real job into a bogus section, which is far more damaging
 * than a title-case "Certifications" going undetected; job-title lines that
 * happen to be short are almost never fully capitalised, and the extra
 * guards (no digits, no pipe, few words) exclude the ones that are.
 */
function looksLikeSectionHeader(line) {
  const text = line.trim().replace(/:$/, '');
  if (text.length < 3 || text.length > 40) return false;
  if (text !== text.toUpperCase() || !/[A-Z]/.test(text)) return false;
  // Letters, spaces and ampersands only. Punctuation is the tell that a line
  // is content rather than a heading: "BFA, OCAD" and "AWS SOLUTIONS
  // ARCHITECT - PROFESSIONAL, 2023" are both shouted credentials, not
  // sections, and a comma or digit separates them from AWARDS & HONOURS.
  if (!/^[A-Za-z&]+(?: [A-Za-z&]+)*$/.test(text)) return false;
  return text.split(/\s+/).length <= 4;
}

function matchSectionHeader(line) {
  const normalized = line.trim().replace(/:$/, '');
  for (const [kind, re] of SECTION_PATTERNS) {
    if (re.test(normalized)) return kind;
  }
  return null;
}

function isContactLike(line) {
  if (/@/.test(line)) return true;
  if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) return true;
  if (/^https?:\/\//i.test(line)) return true;
  if (/linkedin\.com|github\.com/i.test(line)) return true;
  if (line.includes('|') && line.length < 120 && !/[.?!]$/.test(line)) return true;
  return false;
}

function isDateOnlyLine(line) {
  return DATE_RANGE_RE.test(line.trim());
}

/** Split a title line from its date range, whichever side the date sits on. */
function splitDateRange(line) {
  const trailing = TRAILING_DATE_RE.exec(line);
  if (trailing) return { title: trailing[1].trim(), meta: trailing[2].trim() };
  const leading = LEADING_DATE_RE.exec(line);
  if (leading) return { title: leading[2].trim(), meta: leading[1].trim() };
  return { title: line.trim(), meta: null };
}

function carriesOwnDate(line) {
  return TRAILING_DATE_RE.test(line) || LEADING_DATE_RE.test(line);
}

function appendMeta(entry, line) {
  entry.meta = entry.meta ? `${entry.meta} · ${line}` : line;
}

function parseEntries(bodyLines) {
  const entries = [];
  let current = null;

  for (const raw of bodyLines) {
    const line = raw.trim();
    if (!line) continue;

    if (BULLET_RE.test(line)) {
      const text = line.replace(BULLET_RE, '').trim();
      if (!current) { current = { title: '', meta: null, bullets: [] }; entries.push(current); }
      current.bullets.push(text);
      continue;
    }

    // Rule 2: a bare date range is never a title, so it belongs to the entry
    // above it however many context lines have already accumulated.
    if (current && current.bullets.length === 0 && isDateOnlyLine(line)) {
      appendMeta(current, line);
      continue;
    }

    // Rule 3 before rule 4: a line carrying its own date is a new entry even
    // when the previous one never had bullets, so a genuinely bullet-less
    // role is not swallowed by the role above it.
    if (current && current.bullets.length === 0 && current.title && !carriesOwnDate(line)) {
      appendMeta(current, line);
      continue;
    }

    const { title, meta } = splitDateRange(line);
    current = { title, meta, bullets: [] };
    entries.push(current);
  }

  return entries;
}

export function parseTxt(rawText) {
  const lines = String(rawText).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());

  let i = 0;
  while (i < lines.length && lines[i] === '') i++;
  const name = lines[i] || '';
  i++;

  const contactLines = [];
  const proseLines = [];
  let sawProse = false;

  while (i < lines.length) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    if (matchSectionHeader(line) || looksLikeSectionHeader(line)) break;
    if (!sawProse && isContactLike(line)) {
      contactLines.push(line);
    } else {
      sawProse = true;
      proseLines.push(line);
    }
    i++;
  }

  // Position of each block as it appeared in the source. The skills section is
  // lifted out of `sections` into its own field (it has its own tailoring pass
  // and its own rules), which loses where it sat -- and a resume that leads
  // with experience should not come back leading with skills. This is what
  // lets the renderer put it back.
  let order = 0;
  let summary = proseLines.length ? proseLines.join(' ') : null;
  // Retained so the renderer can label the summary with the heading the
  // resume actually used -- PROFILE, OBJECTIVE, ABOUT ME -- instead of
  // dropping it and emitting an unlabelled orphan paragraph.
  let summaryHeading = null;
  let skills = null;
  const sections = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const known = matchSectionHeader(line);
    if (!known && !looksLikeSectionHeader(line)) { i++; continue; }

    const heading = line.replace(/:$/, '');
    const kind = known || 'other';
    i++;
    const bodyLines = [];
    while (i < lines.length) {
      const next = lines[i];
      // `sawBody` guards the generic fallback only: a section's very first
      // line cannot be a heading, because two headings never stack. A KNOWN
      // heading still breaks immediately, since those are unambiguous.
      const sawBody = bodyLines.some(Boolean);
      if (next !== '' && (matchSectionHeader(next) || (sawBody && looksLikeSectionHeader(next)))) break;
      bodyLines.push(next);
      i++;
    }

    if (kind === 'summary') {
      const text = bodyLines.filter(Boolean).join(' ');
      if (text) { summary = text; summaryHeading = heading; }
    } else if (kind === 'skills') {
      skills = { heading, lines: bodyLines.filter(Boolean), order: order++ };
    } else if (kind === 'experience' || kind === 'projects') {
      const entries = parseEntries(bodyLines);
      if (entries.length) sections.push({ kind, heading, entries, order: order++ });
    } else {
      // education, plus every unrecognised section: kept as verbatim lines.
      // That is also the right handling for credentials -- certifications and
      // awards are facts, and must never be handed to the rewriter.
      const sectionLines = bodyLines.filter(Boolean);
      if (sectionLines.length) sections.push({ kind, heading, lines: sectionLines, order: order++ });
    }
  }

  return { name, contact: contactLines.join('\n'), summary, summaryHeading, skills, sections };
}
