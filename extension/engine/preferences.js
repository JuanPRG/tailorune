// preferences.js — user-configurable tailoring/cover-letter preferences.
//
// Ported from v4/prompt_preferences.py. Every enum, default, word
// range, and guidance string is carried over verbatim, because those values
// encode real decisions the original made after testing (e.g. the comment at
// prompt_preferences.py:99-105 records that "conservative" tailoring barely
// changed anything in practice and "aggressive" was what actually produced
// useful output — so aggressive guidance is unconditional there and here).
//
// One field deliberately NOT carried over: `tailoring_style`. v4 kept it
// only so an older extension's Settings UI wouldn't break when it POSTed the
// key, then forcibly overwrote it to "aggressive" and never read it
// (prompt_preferences.py:36-45, :168-172). There is no legacy UI here to
// stay compatible with, so the inert field is dropped rather than ported as
// dead weight — the aggressive guidance it gated is still applied
// unconditionally, exactly as in v4.
//
// Everything here is style/emphasis only. v4 scopes each generated section
// with `scope="style_only"` and an explicit "NEVER allow invented ..." line
// so a preference can never be read as permission to fabricate; both are
// preserved, and the structural guarantee still lives in resumeModel.js
// (locked fields simply never enter a prompt).

export const RESUME_DENSITIES = ['concise', 'standard', 'detailed'];
export const KEYWORD_ALIGNMENTS = ['light', 'balanced'];
export const COVER_LETTER_LENGTHS = ['short', 'standard', 'long'];
export const COVER_LETTER_TONES = ['direct', 'warm', 'confident', 'formal'];
export const EMPHASIS_AREAS = [
  'customer_facing', 'technical', 'leadership', 'operations', 'sales',
  'project_management', 'data', 'process_improvement',
];

export const COVER_LETTER_WORD_RANGES = {
  short: [180, 250],
  standard: [225, 275],
  long: [300, 425],
};

const MAX_NOTE_CHARS = 800;
const MAX_PRESERVE_CHARS = 600;

export const DEFAULT_PREFERENCES = {
  resume_density: 'detailed',
  keyword_alignment: 'balanced',
  emphasis_areas: [],
  preserve_points: '',
  cover_letter_length: 'standard',
  cover_letter_tone: 'direct',
  resume_notes: '',
  cover_letter_notes: '',
};

export const PREFERENCE_OPTIONS = {
  resume_density: RESUME_DENSITIES,
  keyword_alignment: KEYWORD_ALIGNMENTS,
  emphasis_areas: EMPHASIS_AREAS,
  cover_letter_length: COVER_LETTER_LENGTHS,
  cover_letter_tone: COVER_LETTER_TONES,
};

const ENUMS = {
  resume_density: RESUME_DENSITIES,
  keyword_alignment: KEYWORD_ALIGNMENTS,
  cover_letter_length: COVER_LETTER_LENGTHS,
  cover_letter_tone: COVER_LETTER_TONES,
};

const TEXT_LIMITS = {
  preserve_points: MAX_PRESERVE_CHARS,
  resume_notes: MAX_NOTE_CHARS,
  cover_letter_notes: MAX_NOTE_CHARS,
};

const RESUME_DENSITY_GUIDANCE = {
  concise: 'Concise density guidance: keep the resume tight while preserving the strongest real evidence; prefer fewer, sharper bullets over filler.',
  standard: 'Standard density guidance: keep a complete one-page resume; preserve enough real experience, skills, and projects that the resume does not look sparse when the job is only a partial match.',
  detailed: 'Detailed density guidance: use as much one-page space as possible with truthful content; aim for a fuller summary, complete skills ordering, and as many real bullets per role/project as the source resume supports without inventing anything.',
};

// Unconditional, matching v4 — see this module's header comment for why.
const AGGRESSIVE_TAILORING_GUIDANCE =
  'Aggressive tailoring guidance: strongly reframe and rewrite transferable achievements toward the job language to maximize alignment. Fully rewrite phrasing and structure where it helps — but every rewritten bullet must still describe the exact same real activity as its original, never a different one, and never invent skills, duties, metrics, employers, credentials, dates, or experience.';

const KEYWORD_ALIGNMENT_GUIDANCE = {
  light: 'Light keyword guidance: use job keywords only where they naturally match the candidate\'s real work.',
  balanced: 'Balanced keyword guidance: weave job keywords into the candidate\'s real work and skills, but do not force them where they do not belong.',
};

export class PreferenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreferenceError';
  }
}

export function factoryPreferences() {
  return structuredClone(DEFAULT_PREFERENCES);
}

/** Validate and normalize a partial or complete preference payload. */
export function validatePreferences(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PreferenceError('preferences must be an object');
  }
  const unknown = Object.keys(raw).filter((k) => !(k in DEFAULT_PREFERENCES)).sort();
  if (unknown.length) {
    throw new PreferenceError(`unknown preference field(s): ${unknown.join(', ')}`);
  }

  const prefs = factoryPreferences();
  for (const [key, value] of Object.entries(raw)) {
    if (key in ENUMS) {
      if (!ENUMS[key].includes(value)) {
        throw new PreferenceError(`${key} must be one of: ${ENUMS[key].join(', ')}`);
      }
      prefs[key] = value;
    } else if (key === 'emphasis_areas') {
      if (!Array.isArray(value)) throw new PreferenceError('emphasis_areas must be a list');
      const normalized = [];
      for (const item of value) {
        if (!EMPHASIS_AREAS.includes(item)) {
          throw new PreferenceError(`emphasis_areas contains unsupported value '${item}'. Allowed: ${EMPHASIS_AREAS.join(', ')}`);
        }
        if (!normalized.includes(item)) normalized.push(item);
      }
      prefs[key] = normalized;
    } else if (key in TEXT_LIMITS) {
      if (typeof value !== 'string') throw new PreferenceError(`${key} must be a string`);
      const cleaned = value.replace(/\r\n/g, '\n').trim();
      if (cleaned.length > TEXT_LIMITS[key]) {
        throw new PreferenceError(`${key} must be ${TEXT_LIMITS[key]} characters or fewer`);
      }
      prefs[key] = cleaned;
    }
  }
  return prefs;
}

/** @returns {[number, number]} target [min, max] words for the cover-letter body */
export function coverLetterWordRange(preferences) {
  const selected = (preferences && preferences.cover_letter_length) || DEFAULT_PREFERENCES.cover_letter_length;
  return COVER_LETTER_WORD_RANGES[selected] || COVER_LETTER_WORD_RANGES.standard;
}

function label(value) {
  return String(value).replace(/_/g, ' ');
}

export function buildResumePreferencesSection(preferences) {
  const prefs = preferences || factoryPreferences();
  const emphasis = prefs.emphasis_areas.map(label).join(', ') || 'none';
  const lines = [
    '<user_preferences scope="style_only">',
    'Apply these preferences ONLY when truthful and compatible with the output contract, skills boundary, one-page fit, and anti-fabrication rules.',
    'Tailoring style: aggressive.',
    `Resume density: ${label(prefs.resume_density)}.`,
    `Keyword alignment: ${label(prefs.keyword_alignment)} (use job language only when supported by the candidate's real background).`,
    `Emphasis areas: ${emphasis}.`,
    AGGRESSIVE_TAILORING_GUIDANCE,
    RESUME_DENSITY_GUIDANCE[prefs.resume_density],
    KEYWORD_ALIGNMENT_GUIDANCE[prefs.keyword_alignment],
  ];
  if (prefs.preserve_points) lines.push(`Key points to preserve when relevant: ${prefs.preserve_points}`);
  if (prefs.resume_notes) lines.push(`Additional resume notes: ${prefs.resume_notes}`);
  lines.push(
    'These preferences NEVER allow invented tools, metrics, employers, degrees, certifications, dates, or experience.',
    '</user_preferences>',
  );
  return lines.join('\n');
}

export function buildCoverLetterPreferencesSection(preferences) {
  const prefs = preferences || factoryPreferences();
  const emphasis = prefs.emphasis_areas.map(label).join(', ') || 'none';
  const lines = [
    '<user_preferences scope="style_only">',
    'Apply these preferences ONLY when truthful and compatible with the validation rules and anti-fabrication rules.',
    `Cover letter length: ${label(prefs.cover_letter_length)}.`,
    `Cover letter tone: ${label(prefs.cover_letter_tone)}.`,
    `Keyword alignment: ${label(prefs.keyword_alignment)} (use job language only when supported by the resume/profile).`,
    `Emphasis areas: ${emphasis}.`,
  ];
  if (prefs.preserve_points) lines.push(`Key points to preserve when relevant: ${prefs.preserve_points}`);
  if (prefs.cover_letter_notes) lines.push(`Additional cover letter notes: ${prefs.cover_letter_notes}`);
  lines.push(
    'These preferences NEVER allow invented tools, metrics, employers, degrees, certifications, dates, or experience.',
    '</user_preferences>',
  );
  return lines.join('\n');
}
