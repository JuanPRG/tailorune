// renderPdf.js — ResumeModel -> PDF bytes, laid out directly.
//
// WHY THIS EXISTS. The PDF used to be Chrome's print dialog: open the
// rendered HTML in a tab, let the user pick "Save as PDF", choose a location.
// The DOCX meanwhile lands in Downloads by itself. That asymmetry is the
// whole reason for this file -- with real bytes in hand, chrome.downloads
// takes a data: URL and the PDF behaves like the DOCX.
//
// WHY NOT chrome.debugger. Page.printToPDF would have reused Chrome's own
// renderer and cost no layout code at all. It was measured working end to end
// (792ms, exact margins) and rejected on the permission: `debugger` shows an
// install warning, puts a "started debugging this browser" banner in front of
// the user, and draws extended Chrome Web Store review. On a tool that
// already asks for a resume and API keys, that is the wrong thing to spend
// trust on.
//
// WHAT THAT LEAVES is a third renderer, and a third renderer is a liability:
// this project already lost an inch of page height to renderHtml.js and
// renderDocx.js quietly disagreeing about line spacing. Two defences:
//
//   1. Everything about WHAT to draw comes from resumeLayout.js, shared with
//      the other two. This file decides only WHERE ink goes.
//   2. Every measurement below is renderDocx.js's twips / 20 (twips -> pt).
//      Not one number here was chosen because it looked right, and
//      tests/e2e/docx-html-parity.test.mjs measures all three together.
//
// The font is Arimo, whose advance widths are IDENTICAL to Arial's -- not
// close, identical, as tests/unit/fontMetrics.test.mjs asserts glyph by
// glyph. That is what makes this file break lines where Word breaks them.

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { classifyLine, orderedBlocks, roleHead } from './resumeLayout.js';
import { coverLetterSubject } from './coverLetter.js';

// --- Geometry, all of it derived from renderDocx.js ------------------------

const PAGE_W = 612;   // 8.5in
const PAGE_H = 792;   // 11in
const MARGIN_TOP = 0.30 * 72;     // renderDocx MARGIN_TOP 432 twips
const MARGIN_SIDE = 0.60 * 72;    // renderDocx MARGIN_SIDE 864 twips
const MARGIN_BOTTOM = 0.50 * 72;  // renderDocx MARGIN_BOTTOM 720 twips

// The letter is square: renderDocx CL_MARGIN_TWIPS 1224 on all four sides.
const CL_MARGIN = 0.85 * 72;

const RESUME_BOX = { top: MARGIN_TOP, side: MARGIN_SIDE, bottom: MARGIN_BOTTOM };
const LETTER_BOX = { top: CL_MARGIN, side: CL_MARGIN, bottom: CL_MARGIN };

const BODY = 10;      // renderDocx BODY_SIZE 20 half-points
const NAME = 18;      // renderDocx NAME_SIZE 36 half-points
const LINE = 1.15;    // Word's single spacing for Arial, same as renderHtml.js

const INK = rgb(0.102, 0.102, 0.102); // #1a1a1a, matching both other renderers

// twips / 20. Named for the element, so a change in renderDocx.js has an
// obvious counterpart here.
const AFTER_NAME = 1;         // docx after 20
const AFTER_CONTACT = 7;      // docx after 140
const AFTER_SUMMARY = 7;      // docx after 140
const BEFORE_HEADING = 7;     // docx before 140
const AFTER_HEADING = 3.5;    // docx after 70
const RULE_GAP = 2;           // renderHtml h2 padding-bottom
const AFTER_PARA = 2;         // docx after 40
const BEFORE_ROLE = 5;        // docx before 100
const AFTER_ROLE = 2;         // docx after 40
const AFTER_ROLE_TIGHT = 0.5; // docx after 10, when a context line follows
const AFTER_BULLET = 1;       // docx after 20
const BEFORE_DATED = 3;       // docx before 60
const AFTER_DATED = 1;        // docx after 20

// renderHtml.js: ul padding-left 18px. CSS px are 1/96in, so 18px = 13.5pt.
const BULLET_INDENT = 13.5;
const BULLET_CHAR = '•';

// renderHtml .role-head gap, between a headline and the date beside it.
const HEADLINE_DATE_GAP = 12;

/** A heading with nothing under it is an orphan; break the page instead. */
const KEEP_WITH_NEXT = 28;

// Cover letter, from renderDocx's buildCoverLetterDocument (half-points / 2,
// twips / 20). The letterhead runs smaller than the body on purpose: it is
// reference material, not the message.
const CL_META = 9.5;        // docx size 19 half-points
const CL_AFTER_NAME = 1;    // docx after 20
const CL_AFTER_CONTACT = 0.5; // docx after 10
const CL_AFTER_SUBJECT = 12;  // docx after 240
const CL_AFTER_PARA = 10;     // docx after 200
const CL_AFTER_SIGNOFF = 1;   // docx after 20

// --- Text measurement ------------------------------------------------------

const widthOf = (font, text, size) => font.widthOfTextAtSize(text, size);

/**
 * Greedy wrap. Returns lines of WORDS rather than strings, because the
 * justifier needs the gaps back.
 *
 * A single token wider than the column -- a long URL in a contact line -- is
 * hard-split rather than allowed to run into the margin.
 */
function wrapWords(text, font, size, width) {
  const out = [];
  let line = [];
  for (const word of String(text == null ? '' : text).split(/\s+/).filter(Boolean)) {
    if (widthOf(font, word, size) > width) {
      if (line.length) { out.push(line); line = []; }
      let chunk = '';
      for (const ch of word) {
        if (chunk && widthOf(font, chunk + ch, size) > width) { out.push([chunk]); chunk = ''; }
        chunk += ch;
      }
      if (chunk) line = [chunk];
      continue;
    }
    const trial = line.length ? line.join(' ') + ' ' + word : word;
    if (line.length && widthOf(font, trial, size) > width) {
      out.push(line);
      line = [word];
    } else {
      line.push(word);
    }
  }
  if (line.length) out.push(line);
  return out.length ? out : [[]];
}

// --- The sheet -------------------------------------------------------------

/**
 * A cursor that walks down a page and starts a new one when it runs out.
 *
 * `y` is the TOP of the next line box. pdf-lib draws from a baseline, so
 * every draw converts: baseline = top - halfLeading - ascent. Taking those
 * metrics from the font rather than guessing is what keeps the first line's
 * position honest against Word's.
 */
class Sheet {
  constructor(doc, fonts, box = RESUME_BOX) {
    this.doc = doc;
    this.fonts = fonts;
    this.box = box;
    this.contentW = PAGE_W - box.side * 2;
    this.pending = 0;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - this.box.top;
    this.pending = 0; // a page break swallows pending space, as CSS does
    return this.page;
  }

  /** Room for `height` more points, or turn the page. */
  ensure(height) {
    if (this.y - this.pending - height < this.box.bottom) this.newPage();
  }

  /**
   * Ask for vertical space before the next thing drawn -- and COLLAPSE it
   * against whatever was already asked for, rather than adding to it.
   *
   * This is the difference between a resume and a resume plus half an inch.
   * A paragraph's space-after and the next heading's space-before are both
   * 7pt; summing them puts 14pt between, and both of the other renderers put
   * 7pt there -- CSS collapses adjacent margins to the larger, and Word does
   * the same between paragraphs. Summing measured 25.5pt against the DOCX's
   * 18.5pt at every section boundary, which compounds down the page into the
   * kind of drift that turns a one-page resume into two.
   */
  space(pt) { this.pending = Math.max(this.pending, pt); }

  /** Settle the collapsed space. Called by every drawing primitive. */
  flush() { this.y -= this.pending; this.pending = 0; }

  /** Baseline for a line box whose top edge sits at `top`. */
  baseline(font, size, top) {
    const { ascent, descent, unitsPerEm } = font.embedder.font;
    const contentH = ((ascent - descent) / unitsPerEm) * size;
    const halfLeading = (size * LINE - contentH) / 2;
    return top - halfLeading - (ascent / unitsPerEm) * size;
  }

  /**
   * Draw wrapped text.
   *
   * `justify` stretches the gaps on every line but the last -- the same rule
   * CSS `text-align: justify` uses, and the reason a dense resume reads as a
   * block of text rather than a ragged list. The last line is never
   * stretched, which is what stops a two-word final line from being smeared
   * across the column.
   */
  text(content, {
    font = this.fonts.regular, size = BODY, align = 'left', justify = false,
    indent = 0,
  } = {}) {
    const x = this.box.side + indent;
    const width = this.contentW - indent;
    const lines = wrapWords(content, font, size, width);
    const lineH = size * LINE;

    lines.forEach((words, i) => {
      this.ensure(lineH);
      this.flush();
      const baseline = this.baseline(font, size, this.y);
      const isLast = i === lines.length - 1;

      if (justify && !isLast && words.length > 1) {
        const wordsW = words.reduce((sum, w) => sum + widthOf(font, w, size), 0);
        const gap = (width - wordsW) / (words.length - 1);
        let cx = x;
        for (const word of words) {
          this.page.drawText(word, { x: cx, y: baseline, size, font, color: INK });
          cx += widthOf(font, word, size) + gap;
        }
      } else {
        const plain = words.join(' ');
        const w = widthOf(font, plain, size);
        const cx = align === 'center' ? x + (width - w) / 2
          : align === 'right' ? x + width - w
            : x;
        this.page.drawText(plain, { x: cx, y: baseline, size, font, color: INK });
      }
      this.y -= lineH;
    });
  }

  /**
   * A bold headline with a date flush right, on one line.
   *
   * Both reference resumes right-align dates, and it is the arrangement a
   * reader scans fastest -- titles down the left edge, chronology down the
   * right. If the two would collide the headline wraps beneath, and the date
   * stays pinned to the first line's right edge.
   */
  headlineWithDate(headline, date) {
    const { bold, regular } = this.fonts;
    const dateW = date ? widthOf(regular, date, BODY) : 0;
    const headW = this.contentW - dateW - (date ? HEADLINE_DATE_GAP : 0);
    const lineH = BODY * LINE;
    const lines = wrapWords(headline, bold, BODY, headW);

    this.ensure(lineH);
    let drewDate = false;

    for (const words of lines) {
      this.ensure(lineH);
      this.flush();
      const top = this.y;
      this.page.drawText(words.join(' '), {
        x: this.box.side, y: this.baseline(bold, BODY, top), size: BODY, font: bold, color: INK,
      });
      if (date && !drewDate) {
        this.page.drawText(date, {
          x: this.box.side + this.contentW - dateW,
          y: this.baseline(regular, BODY, top),
          size: BODY, font: regular, color: INK,
        });
        drewDate = true;
      }
      this.y -= lineH;
    }
  }

  /** A bullet with a hanging indent, so wrapped lines align under the text. */
  bullet(content) {
    const { regular } = this.fonts;
    this.ensure(BODY * LINE);
    this.flush();
    this.page.drawText(BULLET_CHAR, {
      x: this.box.side + BULLET_INDENT - widthOf(regular, BULLET_CHAR + ' ', BODY),
      y: this.baseline(regular, BODY, this.y),
      size: BODY, font: regular, color: INK,
    });
    this.text(content, { indent: BULLET_INDENT, justify: true });
    this.space(AFTER_BULLET);
  }

  /** A section heading: capitals, bold, and a rule the width of the column. */
  heading(text) {
    // Keep the heading with at least the start of what it introduces.
    this.ensure(BODY * LINE + RULE_GAP + KEEP_WITH_NEXT);
    this.space(BEFORE_HEADING);
    this.text(String(text == null ? '' : text).toUpperCase(), { font: this.fonts.bold });
    this.y -= RULE_GAP; // a border position, not a collapsible margin
    this.page.drawLine({
      start: { x: this.box.side, y: this.y },
      end: { x: this.box.side + this.contentW, y: this.y },
      thickness: 0.75,
      color: INK,
    });
    this.space(AFTER_HEADING);
  }
}

// --- The document ----------------------------------------------------------

function drawEntries(sheet, entries) {
  entries.forEach((entry, idx) => {
    if (idx) sheet.space(BEFORE_ROLE);
    const { headline, date, context, inlineContext } = roleHead(entry);
    sheet.headlineWithDate(headline, date);
    sheet.space(inlineContext || !context ? AFTER_ROLE : AFTER_ROLE_TIGHT);
    if (context && !inlineContext) {
      sheet.text(context, { font: sheet.fonts.italic });
      sheet.space(AFTER_ROLE);
    }
    for (const b of entry.bullets) sheet.bullet(b);
  });
}

function drawLine(sheet, line) {
  const { kind, text, date } = classifyLine(line);
  if (kind === 'bullet') {
    sheet.bullet(text);
    return;
  }
  if (kind === 'dated') {
    sheet.space(BEFORE_DATED);
    sheet.headlineWithDate(text, date);
    sheet.space(AFTER_DATED);
    return;
  }
  sheet.text(text, { justify: true });
  sheet.space(AFTER_PARA);
}

/**
 * A document with the three faces embedded.
 *
 * Subsetting keeps the output small: the shipped faces are already trimmed to
 * Latin, and only the glyphs this document actually uses reach the file --
 * 134KB of font on disk becomes about 14KB of PDF.
 */
async function newDocument(fontBytes, title) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(title);
  doc.setProducer('Tailorune');
  doc.setCreator('Tailorune');
  const fonts = {
    regular: await doc.embedFont(fontBytes.regular, { subset: true }),
    bold: await doc.embedFont(fontBytes.bold, { subset: true }),
    italic: await doc.embedFont(fontBytes.italic, { subset: true }),
  };
  return { doc, fonts };
}

/**
 * @param {import('./resumeModel.js').ResumeModel} model
 * @param {{regular: Uint8Array, bold: Uint8Array, italic: Uint8Array}} fontBytes
 * @returns {Promise<Uint8Array>}
 */
export async function renderResumePdf(model, fontBytes) {
  const { doc, fonts } = await newDocument(fontBytes, model.name ? model.name + ' — Resume' : 'Resume');
  const sheet = new Sheet(doc, fonts, RESUME_BOX);

  sheet.text(model.name || 'Unnamed Candidate', { font: fonts.bold, size: NAME, align: 'center' });
  sheet.space(AFTER_NAME);
  if (model.contact) {
    sheet.text(model.contact.split('\n').join(' | '), { align: 'center' });
    sheet.space(AFTER_CONTACT);
  }
  if (model.summary) {
    // Labelled, always -- for the same reason renderDocx.js labels it: an
    // unlabelled paragraph between the contact block and the first heading is
    // an orphan to any parser segmenting by heading.
    sheet.heading(model.summaryHeading || 'SUMMARY');
    sheet.text(model.summary, { justify: true });
    sheet.space(AFTER_SUMMARY);
  }

  for (const block of orderedBlocks(model)) {
    sheet.heading(block.heading);
    if (block.kind === 'entries') drawEntries(sheet, block.entries);
    else for (const line of block.lines) drawLine(sheet, line);
  }

  return doc.save();
}

/**
 * Cover letter as PDF.
 *
 * Greeting and sign-off are assembled here from the resume model and never
 * from the LLM -- see coverLetter.js's module comment for why that line is
 * held. The body is left-aligned rather than justified: renderDocx does not
 * justify it either, and a letter is prose, not a dense one-page grid.
 *
 * @param {{bodyParagraphs: string[], model: object, job: object}} content
 * @param {{regular: Uint8Array, bold: Uint8Array, italic: Uint8Array}} fontBytes
 * @returns {Promise<Uint8Array>}
 */
export async function renderCoverLetterPdf({ bodyParagraphs, model, job }, fontBytes) {
  const name = model.name || 'Candidate';
  const { doc, fonts } = await newDocument(fontBytes, name + ' — Cover Letter');
  const sheet = new Sheet(doc, fonts, LETTER_BOX);

  sheet.text(name, { font: fonts.bold, size: NAME });
  sheet.space(CL_AFTER_NAME);

  if (model.contact) {
    sheet.text(model.contact.split('\n').join(' | '), { size: CL_META });
    sheet.space(CL_AFTER_CONTACT);
  }

  const subject = coverLetterSubject(job, model);
  if (subject) {
    sheet.text(subject, { size: CL_META });
    sheet.y -= RULE_GAP; // a border position, not a collapsible margin
    sheet.page.drawLine({
      start: { x: sheet.box.side, y: sheet.y },
      end: { x: sheet.box.side + sheet.contentW, y: sheet.y },
      thickness: 0.75,
      color: INK,
    });
    sheet.space(CL_AFTER_SUBJECT);
  }

  sheet.text('Dear Hiring Manager,', { font: fonts.bold });
  sheet.space(CL_AFTER_PARA);

  for (const paragraph of bodyParagraphs) {
    sheet.text(paragraph);
    sheet.space(CL_AFTER_PARA);
  }

  sheet.text('Sincerely,', { font: fonts.bold });
  sheet.space(CL_AFTER_SIGNOFF);
  sheet.text(name, { font: fonts.bold });

  return doc.save();
}
