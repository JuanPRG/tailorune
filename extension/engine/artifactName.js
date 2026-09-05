// artifactName.js — what the downloaded files are called.
//
// Two requirements pulling against each other.
//
// UNIQUE: a run produced `juan_rivera_tailored_resume.docx` every time, so
// tailoring for three companies in an afternoon left three files whose names
// said nothing about which was which -- and chrome.downloads, told to
// uniquify, turned them into "(1)" and "(2)". The employer and the date fix
// that: the name says who it was for and when.
//
// SHORT: applicant tracking systems are the audience, and they are not
// forgiving. Long filenames get truncated, rejected, or mangled on upload, so
// every part here is capped and the word "tailored" -- which described the
// process rather than the document -- is gone.
//
// ASCII, and stripped of accents. Inside the document a candidate's name must
// survive exactly (see renderPdf.js, which embeds a font for that reason); a
// FILENAME is different, and "José" reaching an upload form as "Jos%C3%A9" or
// "Jos_" helps nobody. Filenames are for machines to move around.

/** Long enough for "Alexandra Rodriguez", short enough to stay polite. */
const MAX_NAME = 20;

/** "Northwind Systems" and "New York Times" fit; five-word legal entities do not. */
const MAX_EMPLOYER = 14;

/**
 * Letters NFKD will not decompose, because they are not a letter plus a mark.
 *
 * Stripping accents catches "Jose" from "Jose" but does nothing for these --
 * they simply vanished, and "Lukasz Kowalski" came out as "Ukasz_Kowalski".
 * Mangling someone's name on the file they are about to send an employer is
 * a bad way to be short. Ł is the same character that forced an embedded font
 * in renderPdf.js; it turns up everywhere.
 */
const TRANSLITERATE = {
  'Ł': 'L', 'ł': 'l', 'Ø': 'O', 'ø': 'o', 'Đ': 'D', 'đ': 'd', 'Ð': 'D', 'ð': 'd',
  'Æ': 'Ae', 'æ': 'ae', 'Œ': 'Oe', 'œ': 'oe', 'ß': 'ss', 'Þ': 'Th', 'þ': 'th',
  'İ': 'I', 'ı': 'i', 'Ħ': 'H', 'ħ': 'h', 'Ŋ': 'N', 'ŋ': 'n',
};

/** A backstop, in case both caps are raised without thinking about the sum. */
const MAX_TOTAL = 60;

/**
 * One underscore-joined, capitalised, ASCII fragment, cut at a word boundary.
 *
 * Truncating mid-word ("Northwind_Sys") reads like corruption; dropping the
 * word that would not fit reads like a choice.
 */
function slugPart(text, max) {
  const source = String(text == null ? '' : text)
    .split('')
    .map((ch) => (
      Object.prototype.hasOwnProperty.call(TRANSLITERATE, ch) ? TRANSLITERATE[ch] : ch
    ))
    .join('')
    .normalize('NFKD');

  // Combining marks, by code point rather than by a regex range. The range
  // spelled as an escape did not survive the tooling that wrote this file --
  // it arrived as two raw control bytes -- and a comparison cannot be
  // mangled the same way.
  const stripped = source
    .split('')
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code < 0x0300 || code > 0x036f;
    })
    .join('');

  const words = stripped
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase());

  let out = '';
  for (const word of words) {
    const next = out ? `${out}_${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** Month and day, local. The year is noise on something read within a week. */
function monthDay(at) {
  const when = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.candidateName]  from the parsed resume
 * @param {string} [opts.employer]       from the job, when it is known
 * @param {'resume'|'cover'} opts.kind
 * @param {string} opts.ext              including the dot
 * @param {number} [opts.at]             defaults to now
 * @returns {string} e.g. "Juan_Rivera_Acme_Resume_0905.docx"
 */
export function artifactName({ candidateName, employer, kind, ext, at = Date.now() }) {
  // A leading "The" is four characters of nothing: "The New York Times" would
  // otherwise cap at "The_New_York" and lose the word that identifies it.
  const company = String(employer == null ? '' : employer).replace(/^\s*the\s+/i, '');

  const who = slugPart(candidateName, MAX_NAME);
  const where = slugPart(company, MAX_EMPLOYER);

  // The label and the date always survive. The employer is the first thing
  // dropped when the whole will not fit, and the candidate name the second:
  // the audience is the employer's own ATS, so their name is the redundant
  // half and the applicant's is the point.
  //
  // Dropped BY NAME rather than by position. The previous version spliced
  // index 1, which is the employer only while a candidate name occupies
  // index 0 -- with no name it removed the label instead, and a file that
  // does not say whether it is a resume or a cover letter is worse than a
  // long one. Unreachable while the caps above stand (the longest stem they
  // can produce is 47 characters); here so that raising one cannot quietly
  // reintroduce it.
  const fixed = [kind === 'cover' ? 'Cover' : 'Resume', monthDay(at)];
  for (const optional of [[who, where], [who], []]) {
    const stem = [...optional, ...fixed].filter(Boolean).join('_');
    if (stem.length <= MAX_TOTAL || !optional.length) return stem + ext;
  }
  return fixed.join('_') + ext; // unreachable; the loop's last pass returns.
}
