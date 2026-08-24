// renderDocx.js — ResumeModel -> a .docx file, via the `docx` library.
//
// Template verified in SPIKE_FINDINGS.md: Arial, 18pt centered name, 0.75in
// margins, black section rules (no fills — Chrome's print path drops
// backgrounds by default per the same findings, so this template never
// relied on one anyway), full Unicode with no font embedding needed.
//
// This is the PRIMARY output — auto-downloads via chrome.downloads, no print
// dialog, no "uncheck Headers and footers" step. See MIGRATION_PLAN.md §3-4.

import { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle } from 'docx';

const FONT = 'Arial';
const MARGIN_TWIPS = 1080; // 0.75in

function textParagraph(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align,
    spacing: { before: opts.before ?? 0, after: opts.after ?? 40 },
    border: opts.rule
      ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '1A1A1A' } }
      : undefined,
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        italics: opts.italics,
        size: opts.size ?? 21, // half-points: 21 = 10.5pt
        font: FONT,
      }),
    ],
  });
}

function bulletParagraph(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 20 },
    children: [new TextRun({ text, size: 21, font: FONT })],
  });
}

function sectionHeading(text) {
  return textParagraph(text, { bold: true, size: 22, rule: true, before: 140, after: 70 });
}

/** @returns {Paragraph[]} */
function renderEntries(entries) {
  const out = [];
  entries.forEach((entry, idx) => {
    const metaLine = [entry.title, entry.meta].filter(Boolean);
    out.push(textParagraph(entry.title || '(untitled role)', { bold: true, before: idx ? 80 : 0, after: entry.meta ? 10 : 50 }));
    if (entry.meta) out.push(textParagraph(entry.meta, { size: 19, italics: true, after: 50 }));
    for (const bullet of entry.bullets) out.push(bulletParagraph(bullet));
  });
  return out;
}

/** @param {import('./resumeModel.js').ResumeModel} model */
export function buildResumeDocument(model) {
  const children = [];

  children.push(textParagraph(model.name || 'Unnamed Candidate', { bold: true, size: 36, align: AlignmentType.CENTER, after: 20 }));
  if (model.contact) {
    const contactLine = model.contact.split('\n').join(' | ');
    children.push(textParagraph(contactLine, { size: 17, align: AlignmentType.CENTER, after: 140 }));
  }

  if (model.summary) {
    children.push(textParagraph(model.summary, { after: 140 }));
  }

  if (model.skills && model.skills.lines.length) {
    children.push(sectionHeading(model.skills.heading || 'SKILLS'));
    for (const line of model.skills.lines) children.push(textParagraph(line));
  }

  for (const section of model.sections) {
    children.push(sectionHeading(section.heading));
    if (section.entries) {
      children.push(...renderEntries(section.entries));
    } else {
      for (const line of section.lines) children.push(textParagraph(line));
    }
  }

  return new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: MARGIN_TWIPS, right: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS } },
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
  const jobLine = `Re: ${job.title || 'the role'}${job.company ? ` at ${job.company}` : ''}`;

  const children = [
    textParagraph(name, { bold: true, size: 36, after: 20 }),
  ];
  if (contactLine) children.push(textParagraph(contactLine, { size: 19, after: 10 }));
  children.push(textParagraph(jobLine, { size: 19, rule: true, after: 240 }));

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
