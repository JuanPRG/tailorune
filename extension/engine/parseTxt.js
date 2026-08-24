// parseTxt.js — plain-text resume -> ResumeModel.
//
// Ported and simplified from hirepilot_v4's section-detection heuristics
// (docx_ingest.py's _SECTION_HEADER_PATTERNS + state machine, and
// resume_profile.py's date/title extraction) — 100% regex/heuristic, no LLM,
// matching the original's own docstring claim (resume_profile.py:7).
//
// TXT has no bold/style signal, so title-vs-bullet detection relies on
// structural shape only: a bullet character prefix, or a line that is itself
// (or is followed by) a bare date range.
//
// Known, accepted limitation: an unrecognized section header (e.g.
// "CERTIFICATIONS", not in SECTION_PATTERNS) is not detected as a new
// section — its lines merge into whichever section precedes it. v4 handles
// this with a single-fire generic-header fallback
// (docx_ingest.py:259-270); omitted here since none of the real fixtures in
// tests/fixtures/resumes/ need it. Worth adding if a real resume surfaces
// the gap.

const SECTION_PATTERNS = [
  ['summary', /^(summary|professional summary|profile|about me|career summary|objective)$/i],
  ['skills', /^(technical skills|core skills|skills|technologies|competencies|skills\s*(?:&|and)\s*tools)$/i],
  ['experience', /^(work experience|professional experience|experience|employment history|career history)$/i],
  ['projects', /^(technical projects|projects|personal projects|key projects)$/i],
  ['education', /^(education|academic background|educational background)$/i],
];

const BULLET_RE = /^[-*•▪◦‣]\s+/;
const MONTH_YEAR = /[A-Za-z]{3,9}\.?\s+\d{4}/;
const DATE_RANGE_RE = new RegExp(
  `^(?:${MONTH_YEAR.source}|\\d{4})\\s*[-–—]\\s*(?:present|current|${MONTH_YEAR.source}|\\d{4})$`,
  'i',
);
const TRAILING_DATE_RE = new RegExp(
  `^(.*\\S)\\s{2,}((?:${MONTH_YEAR.source}|\\d{4})\\s*[-–—]\\s*(?:present|current|${MONTH_YEAR.source}|\\d{4}))\\s*$`,
  'i',
);

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

function splitTrailingDateRange(line) {
  const m = TRAILING_DATE_RE.exec(line);
  if (m) return { title: m[1].trim(), meta: m[2].trim() };
  return { title: line.trim(), meta: null };
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
    // A bare date range on its own line belongs to the entry above it.
    if (current && !current.meta && current.bullets.length === 0 && isDateOnlyLine(line)) {
      current.meta = line;
      continue;
    }

    // A non-bullet, non-date line sitting between a title and its first
    // bullet is a location/context subtitle, not a new role:
    //
    //   Retained Financial Advisor  |  Yesos Colombia S.A.S.   2018 - Present
    //   Colombia (Long-term outsourced engagement, Manufacturing)   <-- here
    //   - Served as the sole financial lead...
    //
    // Treating it as a new entry (the previous behaviour) doubled the role
    // count on a real resume and handed every bullet to the phantom entry,
    // leaving each actual job with none. v4 told these apart using bold runs
    // from the .docx; that signal does not survive normalization to text, so
    // position is the signal here: a title already claimed, no bullets yet.
    //
    // Guarded so a genuinely bullet-less role is not absorbed by the role
    // above it: a line carrying its own date range is always a new entry,
    // whatever came before it.
    const carriesOwnDate = TRAILING_DATE_RE.test(line) || isDateOnlyLine(line);
    if (current && current.title && current.bullets.length === 0 && !carriesOwnDate) {
      current.meta = current.meta ? `${current.meta} · ${line}` : line;
      continue;
    }

    const { title, meta } = splitTrailingDateRange(line);
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
    if (matchSectionHeader(line)) break;
    if (!sawProse && isContactLike(line)) {
      contactLines.push(line);
    } else {
      sawProse = true;
      proseLines.push(line);
    }
    i++;
  }

  let summary = proseLines.length ? proseLines.join(' ') : null;
  let skills = null;
  const sections = [];

  while (i < lines.length) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const kind = matchSectionHeader(line);
    if (!kind) { i++; continue; } // defensive: shouldn't happen given the loop shape above

    const heading = line;
    i++;
    const bodyLines = [];
    while (i < lines.length) {
      const next = lines[i];
      if (next !== '' && matchSectionHeader(next)) break;
      bodyLines.push(next);
      i++;
    }

    if (kind === 'summary') {
      const text = bodyLines.filter(Boolean).join(' ');
      if (text) summary = text;
    } else if (kind === 'skills') {
      skills = { heading, lines: bodyLines.filter(Boolean) };
    } else if (kind === 'experience' || kind === 'projects') {
      sections.push({ kind, heading, entries: parseEntries(bodyLines) });
    } else {
      sections.push({ kind: 'education', heading, lines: bodyLines.filter(Boolean) });
    }
  }

  return { name, contact: contactLines.join('\n'), summary, skills, sections };
}
