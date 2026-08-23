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
