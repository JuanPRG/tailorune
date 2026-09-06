// textUtils.js — shared text helpers and anti-fabrication watchlists.
//
// In v4 these lived inside tailor.py and were imported as private
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

/**
 * Is this string usable as a job title in user-facing output?
 *
 * Job-page extraction reads titles from whatever the page offers, and pages
 * offer plenty that is not a job title: a personalised greeting, a nav label,
 * a cookie banner heading. One such value ("Welcome, Juan", scraped from a
 * signed-in Indeed page) reached a finished cover letter as
 * "Re: Welcome, Juan at TP Canada".
 *
 * Deliberately a rejection test rather than a recognition test. Job titles
 * are unbounded and inventing a whitelist would reject real ones; what CAN be
 * enumerated is the small set of shapes that are definitely not titles. The
 * candidate's own name is included because a greeting usually contains it,
 * and a title that is the applicant's name is wrong however it got there.
 */
const GREETING_RE = /^\s*(welcome|hello|hi|hey|dear|greetings|thanks|thank you|good (morning|afternoon|evening)|sign in|log in|apply now|save this job)\b/i;

export function isPlausibleJobTitle(title, candidateName = '') {
  const text = String(title || '').trim();
  if (text.length < 2 || text.length > 100) return false;
  if (GREETING_RE.test(text)) return false;
  if (/[!?]/.test(text)) return false;
  // A URL or an email address is scraped chrome, not a title.
  if (/https?:\/\/|@/.test(text)) return false;

  const name = String(candidateName || '').trim();
  if (name) {
    const parts = name.split(/\s+/).filter((p) => p.length > 2).map((p) => p.toLowerCase());
    const lower = text.toLowerCase();
    if (parts.length && parts.every((p) => lower.includes(p))) return false;
  }
  return true;
}

// --- Concreteness retention -------------------------------------------------
//
// A rewrite can preserve every fact and still cost the candidate the job.
// Asked to make bullets sound stronger, an LLM reliably trades specific nouns
// for abstract process verbs: "bookkeeping, financial reporting, and budget
// tracking" becomes "comprehensive financial administration ... to optimize
// operational efficiency". Nothing is fabricated and nothing is lost that a
// human would call a fact — but the searchable terms are gone, and keyword
// matching is most of what a resume is screened on first.
//
// So concreteness is measured, not asked for. These functions define what is
// measured; tailor.js decides the thresholds and what to do about a shortfall.

/** Words that carry no matchable meaning, so retaining them proves nothing. */
const RETENTION_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'that', 'from', 'this', 'into', 'across', 'while', 'their',
  'were', 'was', 'has', 'have', 'had', 'are', 'not', 'out', 'all', 'can', 'its', 'who',
  'you', 'your', 'our', 'each', 'also', 'more', 'than', 'other', 'some', 'such', 'only',
  'over', 'then', 'them', 'they', 'when', 'where', 'which', 'will', 'would', 'about',
  'after', 'before', 'being', 'both', 'during', 'through', 'under', 'very', 'most', 'many',
  'much', 'including', 'include', 'includes', 'within', 'per', 'via', 'upon', 'these',
  // Generic resume verbs and intensifiers. These are what a rewrite ADDS, so
  // counting them as retained concreteness would mask the very loss being
  // measured.
  'managed', 'handled', 'led', 'ran', 'executed', 'delivered', 'drove', 'built', 'made',
  'worked', 'used', 'using', 'utilized', 'utilised', 'utilizing', 'leveraged', 'leveraging',
  'orchestrated', 'spearheaded', 'demonstrating', 'showcasing', 'ensuring', 'ensure',
  'providing', 'provide', 'supporting', 'support', 'responsible', 'various', 'several',
  'key', 'high', 'strong', 'proven', 'comprehensive', 'complex', 'rigorous', 'meticulous',
  'strategic', 'robust', 'seamless', 'superior', 'significant', 'substantial', 'effective',
  'efficient', 'efficiency', 'excellence', 'expertise', 'ability', 'able', 'skills',
  // Adverbs and vague quantifiers. Counting these as concrete vocabulary
  // would both inflate the score and clutter the "you dropped these" list
  // with words no screener searches for.
  'how', 'kept', 'quickly', 'different', 'needs', 'clearly', 'visibly', 'line', 'lines',
  'multiple', 'daily', 'regular', 'regularly', 'consistently', 'successfully',
]);

// Unit suffixes that are part of a METRIC rather than a name: "$1.2M", "40k",
// "3x". Any other letter touching the digits means the token is an identifier.
const METRIC_SUFFIX = /^[%+kmbx]+\+?$/;

/**
 * Numbers and metrics: "20+", "40%", "15", "$1.2M", "200+".
 *
 * Dropping one is never a stylistic choice — a quantified claim is strictly
 * more useful to a reader and a screener than the same claim unquantified.
 *
 * BUT A DIGIT IS NOT AUTOMATICALLY A METRIC, and treating it as one was a real
 * bug. The earlier version matched any digit run anywhere, so "COVID-19"
 * contributed "19" — and because the tailored bullet reasonably dropped the
 * pandemic reference, EVERY run failed validation with "Role 1 dropped
 * quantities: 19", burned a retry, and finished as
 * `fallback_after_validation`. The check meant to catch a model quietly
 * dropping "reduced costs by 30%" was instead policing a disease name.
 *
 * It generalises badly, which is what makes it worth a rule rather than a
 * special case: 401(k), Log4j, HTML5, S3, Windows 10, K-12, ISO 9001, Section
 * 508 are all names that happen to contain digits. Demanding a rewrite carry
 * them over is both wrong and expensive.
 *
 * The rule: a digit run counts only when the whitespace-delimited token around
 * it carries no letters other than a unit suffix. Numbers standing alone
 * ("19 staff") still count, so the guard keeps its teeth.
 */
export function numericTokens(text) {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  const out = new Set();

  for (const raw of tokens) {
    // Trim sentence punctuation, but keep $ % + . , which can be part of a
    // number, and keep - so a leading minus or an internal hyphen is visible.
    const token = raw.replace(/^[^\w$+-]+/, '').replace(/[^\w%+.]+$/, '');
    if (!/\d/.test(token)) continue;

    // Every letter in the token must belong to a unit suffix. "COVID-19" fails
    // here (COVID is not a suffix); "$1.2M" passes; "19" has no letters.
    const letters = token.replace(/[^A-Za-z]/g, '');
    if (letters && !METRIC_SUFFIX.test(letters.toLowerCase())) continue;

    // A hyphen joining a word to the digits marks a compound name, even when
    // the word half was stripped above -- "K-12", "F-15", "COVID-19".
    if (/[A-Za-z]-\d|\d-[A-Za-z]/.test(raw)) continue;

    // A bracket straight after the digits is a named thing, not a unit:
    // "401(k)", "Section 8(a)". Without this, "401(k)" reads as "401k".
    if (/\d\s*[([]/.test(raw)) continue;

    const match = token.match(/\$?\d[\d,.]*\s?[%+kKmMbBxX]?\+?/);
    if (!match) continue;
    out.add(match[0].replace(/[\s,]/g, '').toLowerCase().replace(/\.$/, ''));
  }
  return out;
}

/** Concrete, matchable vocabulary: content words minus stopwords and filler. */
export function conceptTokens(text) {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9/&+-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return new Set(words.filter((w) => w.length > 2 && !RETENTION_STOPWORDS.has(w)));
}

/**
 * Share of the original's concrete vocabulary still present after rewriting.
 * 1 when the original had nothing to retain, so an empty source can never
 * fail the check.
 */
export function conceptRetentionRatio(originalText, rewrittenText) {
  const before = conceptTokens(originalText);
  if (before.size === 0) return 1;
  const after = conceptTokens(rewrittenText);
  let kept = 0;
  for (const token of before) if (after.has(token)) kept++;
  return kept / before.size;
}

/** Numbers present in the original that no longer appear anywhere in the rewrite. */
export function droppedNumbers(originalText, rewrittenText) {
  const after = numericTokens(rewrittenText);
  return [...numericTokens(originalText)].filter((n) => !after.has(n));
}
