// renderDocx.js — ResumeModel -> a .docx file, via the `docx` library.
//
// Template verified in SPIKE_FINDINGS.md: Arial, 18pt centered name, black
// section rules (no fills — Chrome's print path drops backgrounds by default
// per the same findings, so this template never relied on one anyway), full
// Unicode with no font embedding needed.
//
// Typography follows the strongest of the user's own resumes: TWO sizes for
// the whole page, hierarchy from bold + capitals + rules, dates flush right
// on a tab stop, asymmetric margins that spend space on line length rather
// than on the top of the page.
//
// This is the PRIMARY output — auto-downloads via chrome.downloads, no print
// dialog, no "uncheck Headers and footers" step. See MIGRATION_PLAN.md §3-4.

import { Document, Packer, Paragraph, TextRun, Tab, TabStopType, AlignmentType, BorderStyle } from 'docx';
import { coverLetterSubject } from './coverLetter.js';

const FONT = 'Arial';

// TWO type sizes for the whole document, and no more.
//
// Hierarchy comes from bold, capitals and rules rather than from size
// variation. That is the single thing that separates a resume that reads as
// designed from one that reads as assembled, and it is measurable: the
// strongest of the reference resumes uses exactly two sizes, while an earlier
// version of this template used five -- including an 8.5pt contact line
// smaller than anything on a real resume.
const NAME_SIZE = 36; // half-points: 18pt
const BODY_SIZE = 20; // half-points: 10pt

// Asymmetric on purpose. A wide top margin wastes the most valuable space on
// the page; the sides are what actually control how much fits per line.
const MARGIN_TOP = 432; // 0.30in
const MARGIN_SIDE = 1080; // 0.75in
const MARGIN_BOTTOM = 864; // 0.60in

// Letter width (12240 twips) less both side margins: where a right-aligned
// tab stop has to sit for dates to land flush with the right edge.
const CONTENT_WIDTH = 12240 - MARGIN_SIDE * 2;

// Longest a role's context can be and still share the title's line.
const INLINE_CONTEXT_MAX = 92;

function textParagraph(text, opts = {}) {
  return new Paragraph({
    alignment: opts.justify ? AlignmentType.JUSTIFIED : opts.align,
    spacing: { before: opts.before ?? 0, after: opts.after ?? 40 },
    border: opts.rule
      ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1A1A1A' } }
      : undefined,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: opts.size ?? BODY_SIZE,
        font: FONT,
      }),
    ],
  });
}

// Justified: bullets, the summary and the skills lines all run to multiple
// lines, and a flush right edge is what makes a dense one-page resume read as
// a block of text rather than a ragged list. Headings, role titles and dated
// rows stay unjustified -- stretching a short line to the margin looks broken,
// and a right-aligned date has nothing to justify against.
function bulletParagraph(text) {
  return new Paragraph({
    bullet: { level: 0 },
    alignment: AlignmentType.JUSTIFIED,
    spacing: { after: 20 },
    children: [new TextRun({ text, size: BODY_SIZE, font: FONT })],
  });
}

/**
 * Same size as body text: bold, capitals and a rule carry the hierarchy.
 * Upper-cased for consistency, but the heading's own WORD is preserved --
 * a resume that says OBJECTIVE or ABOUT ME keeps saying it.
 */
function sectionHeading(text) {
  return textParagraph(String(text || '').toUpperCase(), {
    bold: true, rule: true, before: 140, after: 70,
  });
}

/** A source line that already carries a bullet marker, rendered as a real list item. */
const LEADING_BULLET_RE = /^[-*•▪◦‣]\s+/;

// A line ending in a year or a date range, separated by real whitespace:
// "Bachelor of Economics   2015", "Advanced Diploma (CPA)   May 2023 - Apr 2026".
// Both reference resumes bold this line and push the year to the right margin,
// exactly as they do for a role -- and both leave the institution line beneath
// it plain, which is what tells the two apart at a glance.
// Written as a literal, not assembled from strings. `\s` and `\d` are not
// valid escapes inside a template literal and collapse to bare `s` and `d`,
// which turns this pattern into something that matches nothing and fails
// silently — it did exactly that on the first attempt.
const TRAILING_YEAR_RE = /^(.*\S)\s{2,}((?:[A-Za-z]{3,9}\.?\s+)?\d{4}(?:\s*[-–—]\s*(?:present|current|(?:[A-Za-z]{3,9}\.?\s+)?\d{4}))?)\s*$/i;

function datedLineParagraph(text, year) {
  return new Paragraph({
    spacing: { before: 60, after: 20 },
    tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }],
    children: [
      new TextRun({ text, bold: true, size: BODY_SIZE, font: FONT }),
      new TextRun({ children: [new Tab(), year], size: BODY_SIZE, font: FONT }),
    ],
  });
}

function lineParagraph(line, { justify = false } = {}) {
  if (LEADING_BULLET_RE.test(line)) {
    return bulletParagraph(line.replace(LEADING_BULLET_RE, '').trim());
  }
  const dated = TRAILING_YEAR_RE.exec(line);
  if (dated) return datedLineParagraph(dated[1].trim(), dated[2].trim());
  return textParagraph(line, { justify });
}

/**
 * Split an entry's meta into the date range and whatever context follows it.
 *
 * parseTxt joins them with " · " ("2018 - Present · Colombia (Remote)"), and
 * the date is what belongs at the right margin; the context is a subtitle.
 */
const META_DATE_RE = /^(?:[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})\s*[-–—]\s*(?:present|current|[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})$/i;
function splitMeta(meta) {
  const parts = String(meta || '').split(' · ').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { date: '', context: '' };
  if (META_DATE_RE.test(parts[0])) {
    return { date: parts[0], context: parts.slice(1).join(' · ') };
  }
  return { date: '', context: parts.join(' · ') };
}

/**
 * One line per role wherever it fits: bold title on the left, date flush
 * right on a real tab stop.
 *
 * Both reference resumes right-align their dates, and it is the arrangement a
 * reader scans fastest — titles down the left edge, chronology down the
 * right. The previous template put the date at the START of a small italic
 * line under the title, which buried the one field a recruiter looks for
 * first and cost an extra line per role.
 *
 * Short context (a city) joins the title line. Long context — "Colombia
 * (Remote, Manufacturing and Distribution)" — drops to its own line rather
 * than colliding with the date.
 *
 * @returns {Paragraph[]}
 */
function renderEntries(entries) {
  const out = [];
  entries.forEach((entry, idx) => {
    const title = entry.title || '(untitled role)';
    const { date, context } = splitMeta(entry.meta);
    const inlineContext = context && `${title} · ${context}`.length <= INLINE_CONTEXT_MAX;
    const headline = inlineContext ? `${title} · ${context}` : title;

    const children = [new TextRun({ text: headline, bold: true, size: BODY_SIZE, font: FONT })];
    if (date) {
      children.push(new TextRun({ children: [new Tab(), date], size: BODY_SIZE, font: FONT }));
    }

    out.push(new Paragraph({
      spacing: { before: idx ? 100 : 0, after: inlineContext || !context ? 40 : 10 },
      tabStops: date ? [{ type: TabStopType.RIGHT, position: CONTENT_WIDTH }] : undefined,
      children,
    }));

    if (context && !inlineContext) {
      out.push(textParagraph(context, { italics: true, after: 40 }));
    }
    for (const bullet of entry.bullets) out.push(bulletParagraph(bullet));
  });
  return out;
}

/** @param {import('./resumeModel.js').ResumeModel} model */
export function buildResumeDocument(model) {
  const children = [];

  children.push(textParagraph(model.name || 'Unnamed Candidate', { bold: true, size: NAME_SIZE, align: AlignmentType.CENTER, after: 20 }));
  if (model.contact) {
    const contactLine = model.contact.split('\n').join(' | ');
    children.push(textParagraph(contactLine, { align: AlignmentType.CENTER, after: 140 }));
  }

  if (model.summary) {
    // Labelled, always. An unlabelled paragraph between the contact block and
    // the first real heading is an orphan: a parser segmenting by heading has
    // nothing to attach it to. The resume's own heading is used when it had
    // one (PROFILE, OBJECTIVE, ABOUT ME), and a neutral default when the
    // summary came from leading prose with no heading at all.
    children.push(sectionHeading(model.summaryHeading || 'SUMMARY'));
    children.push(textParagraph(model.summary, { after: 140, justify: true }));
  }

  // Skills is parsed out of `sections` into its own field, because it has its
  // own tailoring pass and its own rules -- but that must not decide where it
  // PRINTS. parseTxt records each block's position, so a resume that ends with
  // skills comes back ending with skills. Models built by hand (tests, older
  // callers) carry no order, and fall back to skills-first.
  const blocks = [];
  if (model.skills && model.skills.lines.length) {
    blocks.push({
      order: model.skills.order ?? -1,
      heading: model.skills.heading || 'SKILLS',
      // Real list items, matching the reference resume. Each line is a
      // labelled group ("Languages: Java, Python"), and a bullet is what tells
      // a reader -- and a parser -- that these are peers rather than prose.
      render: () => model.skills.lines.map((line) => lineParagraph(line, { justify: true })),
    });
  }
  model.sections.forEach((section, i) => {
    blocks.push({
      order: section.order ?? i,
      heading: section.heading,
      render: () => (section.entries
        ? renderEntries(section.entries)
        : section.lines.map((line) => lineParagraph(line, { justify: true }))),
    });
  });

  blocks.sort((a, b) => a.order - b.order);
  for (const block of blocks) {
    children.push(sectionHeading(block.heading));
    children.push(...block.render());
  }

  return new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: MARGIN_TOP, right: MARGIN_SIDE, bottom: MARGIN_BOTTOM, left: MARGIN_SIDE,
            },
          },
        },
        children,
      },
    ],
  });
}

/** @returns {Promise<Uint8Array>} */
export async function renderResumeDocx(model) {
  const doc = buildResumeDocument(model);
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

const CL_MARGIN_TWIPS = 1224; // 0.85in, matching cover_letter.py's COVER_LETTER_MARGIN

/**
 * Cover letter as DOCX. Greeting and sign-off are assembled here from the
 * resume model, never from the LLM — see coverLetter.js's module comment.
 * Same Arial/10.5pt body as the resume so the two read as a set.
 */
export function buildCoverLetterDocument({ bodyParagraphs, model, job }) {
  const name = model.name || 'Candidate';
  const contactLine = model.contact ? model.contact.split('\n').join(' | ') : '';
  const jobLine = coverLetterSubject(job, model);

  const children = [
    textParagraph(name, { bold: true, size: 36, after: 20 }),
  ];
  if (contactLine) children.push(textParagraph(contactLine, { size: 19, after: 10 }));
  if (jobLine) children.push(textParagraph(jobLine, { size: 19, rule: true, after: 240 }));

  // Greeting and sign-off bold, body regular -- matches cover_letter.py:265-272.
  children.push(textParagraph('Dear Hiring Manager,', { bold: true, after: 200 }));
  for (const paragraph of bodyParagraphs) {
    children.push(textParagraph(paragraph, { after: 200 }));
  }
  children.push(textParagraph('Sincerely,', { bold: true, after: 20 }));
  children.push(textParagraph(name, { bold: true }));

  return new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: CL_MARGIN_TWIPS, right: CL_MARGIN_TWIPS, bottom: CL_MARGIN_TWIPS, left: CL_MARGIN_TWIPS } },
        },
        children,
      },
    ],
  });
}

/** @returns {Promise<Uint8Array>} */
export async function renderCoverLetterDocx({ bodyParagraphs, model, job }) {
  const doc = buildCoverLetterDocument({ bodyParagraphs, model, job });
  const blob = await Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
