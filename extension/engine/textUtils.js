// textUtils.js — shared text helpers and anti-fabrication watchlists.
//
// In hirepilot_v4 these lived inside tailor.py and were imported as private
// symbols by five other modules (cover_letter.py, jd_cleanup.py, profile.py,
// fallback_txt_pdf.py, fill_mapper.py) — MIGRATION_PLAN.md §5 flagged that
// as the one real coupling smell to fix during the port, so they get their
// own module here rather than being reached into.
//
// Ported verbatim from tailor.py:29-33 (FABRICATION_WATCHLIST_TERMS),
// :42-48 (ROLE_TITLE_WATCHLIST), :62-69 (smart quotes, stopwords),
// :74-80 (sanitize_text), :181-183 (_tokenize), :51-58 (fabricated_role_titles).

const EM_DASH = '—';
const EN_DASH = '–';

const SMART_QUOTES = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'with', 'for', 'to', 'of', 'in',
  'on', 'at', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'this',
  'that', 'these', 'those', 'our', 'their', 'its', 'it', 'from', 'into',
  'over', 'across', 'through', 'using', 'via', 'per', 'up', 'out',
]);

// Specific tools/credentials that are cheap for an LLM to add and expensive
// for a candidate to have falsely claimed. Not exhaustive by design — a
// defense-in-depth heuristic, per tailor.py's own note.
export const FABRICATION_WATCHLIST_TERMS = new Set([
  'c#', 'c++', 'golang', 'rust', 'django', 'angular', 'kubernetes',
  'terraform', 'aws certified', 'pmp', 'cissp', 'scrum master certified',
  'certified', 'six sigma',
]);

// Claiming one of these when the term appears nowhere in the candidate's
// real source material is a professional-identity fabrication, not a
// transferable-skills reframing — e.g. rewriting a Support Specialist's
// summary to open with "Product Manager with 4 years of experience".
export const ROLE_TITLE_WATCHLIST = new Set([
  'product manager', 'software engineer', 'data scientist', 'data analyst',
  'project manager', 'program manager', 'business analyst', 'product owner',
  'engineering manager', 'marketing manager', 'sales manager', 'account manager',
  'devops engineer', 'solutions architect', 'ux designer', 'ui designer',
  'financial analyst', 'operations manager', 'general manager', 'chief of staff',
]);

/** Auto-fix em/en dashes and smart quotes the LLM tends to produce. */
export function sanitizeText(text) {
  let out = String(text ?? '');
  out = out.split(EM_DASH).join(', ');
  out = out.split(EN_DASH).join('-');
  for (const [smart, plain] of Object.entries(SMART_QUOTES)) {
    out = out.split(smart).join(plain);
  }
  return out;
}

/** @returns {Set<string>} case-folded content words, stopwords removed */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase().match(/[a-z][a-z0-9+#.]*/g) || [];
  const out = new Set();
  for (const word of raw) {
    const trimmed = word.replace(/\.+$/, '');
    if (trimmed && !STOPWORDS.has(trimmed)) out.add(trimmed);
  }
  return out;
}

/**
 * Role-title phrases present in `newText` but absent anywhere in
 * `sourceText` — the "don't claim a different professional identity" guard.
 */
export function fabricatedRoleTitles(sourceText, newText) {
  const source = String(sourceText ?? '').toLowerCase();
  const next = String(newText ?? '').toLowerCase();
  const found = new Set();
  for (const title of ROLE_TITLE_WATCHLIST) {
    if (next.includes(title) && !source.includes(title)) found.add(title);
  }
  return found;
}

/**
 * The skills the candidate actually has, derived from THIS resume's own
 * skills section rather than a separate global profile.
 *
 * v4 offers both: `skills_boundary()` reads one global profile.json, and
 * `resume_skills_boundary()` derives it per-resume. profile.py:121-127
 * explains why the per-resume version is the correct default — a resume
 * library can hold resumes for genuinely different career paths, and
 * checking a cover letter's skill claims against one global declaration
 * "silently breaks the moment a selected resume describes a different
 * background". There is no profile.json here, so the per-resume derivation
 * is the only one ported.
 *
 * @param {import('./resumeModel.js').ResumeModel} model
 */
export function resumeSkillsBoundary(model) {
  const tokens = new Set();
  if (model.skills) {
    for (const line of model.skills.lines) {
      for (const token of tokenize(line)) tokens.add(token);
    }
  }
  return tokens;
}

/** Flat text of every locked/unlocked field, for source-anchoring checks. */
export function modelFullText(model) {
  const parts = [model.name, model.contact, model.summary];
  if (model.skills) {
    parts.push(model.skills.heading, ...model.skills.lines);
  }
  for (const section of model.sections) {
    parts.push(section.heading);
    if (section.entries) {
      for (const entry of section.entries) {
        parts.push(entry.title, entry.meta, ...entry.bullets);
      }
    } else {
      parts.push(...section.lines);
    }
  }
  return parts.filter(Boolean).join('\n');
}
