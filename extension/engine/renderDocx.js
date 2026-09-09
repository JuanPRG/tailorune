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
import { classifyLine, orderedBlocks, roleHead } from './resumeLayout.js';

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
const MARGIN_SIDE = 864; // 0.60in
const MARGIN_BOTTOM = 720; // 0.50in

// US Letter, DECLARED. A .docx with no page size takes the reader's default,
// which is Letter in North America and A4 nearly everywhere else -- so the
// same file opened in Warsaw was 0.24in narrower per line and 0.69in taller
// per page than the PDF and the HTML, which are both pinned to Letter. Three
// renderers cannot be "the same document" while one of them asks the
// operating system what shape paper is. Found by measuring a LibreOffice
// conversion and getting text positions 50pt off: 842pt of A4 against the
// 792pt everything else assumed.
const PAGE_WIDTH = 12240;  // 8.5in
const PAGE_HEIGHT = 15840; // 11in

// Measured, not assumed: a LibreOffice page-count sweep put the one-page
// boundary at 522 words for BOTH 0.30/0.75/0.60 and this tighter geometry.
// Page breaks land on line boundaries, so extra width adds no lines to
// bullet-shaped content, and 0.10in of vertical gain is less than one 10pt
// line. The change is cosmetic, and ONE_PAGE_WORD_BUDGET is unaffected -- but
// that is a fact about this specific pair of geometries, not a general rule.
// Any further change needs the sweep re-run.

// Letter width (12240 twips) less both side margins: where a right-aligned
// tab stop has to sit for dates to land flush with the right edge.
const CONTENT_WIDTH = 12240 - MARGIN_SIDE * 2;

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
// The other two renderers put bullet text 13.5pt in -- renderHtml's
// `ul { padding-left: 18px }`, which renderPdf mirrors as BULLET_INDENT. This
// file set no indent at all, so the docx library's DEFAULT numbering ladder
// applied: left 720 twips, i.e. HALF AN INCH, nearly four times the other two.
//
// REPORTED, on a real resume: "the margin of the bullet points is starting
// almost as if it was tabbed, taking precious space". It was. On a 7.3in
// column, 0.5in is 6.8% of the width spent on a glyph that needs about 0.15in,
// and it applied to every line of every bullet -- so the DOCX wrapped where
// the PDF of the same content did not, and only the DOCX ran to two pages.
//
// 270 twips = 13.5pt, so all three renderers now indent identically. The
// hanging value puts the marker at 110 twips, matching where renderPdf draws
// it (BULLET_INDENT less the width of "• ").
const BULLET_INDENT = 270;
const BULLET_HANGING = 160;

function bulletParagraph(text) {
  return new Paragraph({
    bullet: { level: 0 },
    indent: { left: BULLET_INDENT, hanging: BULLET_HANGING },
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
  const { kind, text, date } = classifyLine(line);
  if (kind === 'bullet') return bulletParagraph(text);
  if (kind === 'dated') return datedLineParagraph(text, date);
  return textParagraph(text, { justify });
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
    const { headline, date, context, inlineContext } = roleHead(entry);

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

  // Section order -- including where skills lands -- is resumeLayout.js's
  // call, so the DOCX, the HTML and the PDF cannot disagree about it.
  for (const block of orderedBlocks(model)) {
    children.push(sectionHeading(block.heading));
    children.push(...(block.kind === 'entries'
      ? renderEntries(block.entries)
      : block.lines.map((line) => lineParagraph(line, { justify: true }))));
  }

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
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
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: CL_MARGIN_TWIPS, right: CL_MARGIN_TWIPS, bottom: CL_MARGIN_TWIPS, left: CL_MARGIN_TWIPS },
          },
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
