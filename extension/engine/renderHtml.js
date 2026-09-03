// renderHtml.js — ResumeModel -> an HTML document for the secondary output
// path: in-extension preview, then browser print -> PDF.
//
// Same template as renderDocx.js by design (Arial, 0.75in margins, black
// section rules, no fills) -- MIGRATION_PLAN.md §3-4 treats these as one
// content model with two exits, not two designs. Two things specific to
// print, both measured directly against the real Chrome print dialog in
// SPIKE_FINDINGS.md's gap-3 closure:
//   - `@page { margin: 0.75in }` is honored on the dialog's default path,
//     confirmed against the real UI, not just headlessly.
//   - Chrome's "Headers and footers" default ON prints a date/title/URL/
//     page-number onto the page and CSS cannot suppress it. There is no
//     programmatic fix; the preview page below carries a visible reminder
//     instead, which is the only lever available.
//   - "Background graphics" is OFF by default, so this template must never
//     rely on a fill for structure -- it doesn't; section rules are borders.

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

import { LEADING_BULLET_RE, classifyLine, orderedBlocks, roleHead } from './resumeLayout.js';

/** A plain section line: a bullet, or a dated row (education) that reads like a role. */
function renderLine(line) {
  const { kind, text, date } = classifyLine(line);
  if (kind === 'bullet') return `<ul><li>${escapeHtml(text)}</li></ul>`;
  if (kind === 'dated') {
    return `<div class="role-head"><span class="role-title">${escapeHtml(text)}</span>`
      + `<span class="role-date">${escapeHtml(date)}</span></div>`;
  }
  return `<p class="justified">${escapeHtml(text)}</p>`;
}

function renderEntries(entries) {
  return entries.map((entry) => {
    const { headline, date, context, inlineContext: inline } = roleHead(entry);
    return `
    <div class="role-head">
      <span class="role-title">${escapeHtml(headline)}</span>
      ${date ? `<span class="role-date">${escapeHtml(date)}</span>` : ''}
    </div>
    ${context && !inline ? `<p class="role-context">${escapeHtml(context)}</p>` : ''}
    ${entry.bullets.length ? `<ul>${entry.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
  `;
  }).join('');
}

/** @param {import('./resumeModel.js').ResumeModel} model */
export function renderResumeHtml(model) {
  const contactLine = model.contact ? model.contact.split('\n').join(' | ') : '';
  // Section order -- including where skills lands -- is resumeLayout.js's
  // call, so the DOCX, the HTML and the PDF cannot disagree about it.
  const blocks = orderedBlocks(model).map((block) => ({
    html: `<h2>${escapeHtml(block.heading)}</h2>${
      block.kind === 'skills'
        ? `<ul>${block.lines.map((l) => `<li>${escapeHtml(l.replace(LEADING_BULLET_RE, ''))}</li>`).join('')}</ul>`
        : block.kind === 'entries'
          ? renderEntries(block.entries)
          : block.lines.map(renderLine).join('')}`,
  }));
  const sectionsHtml = blocks.map((b) => b.html).join('');
  const skillsHtml = '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(model.name || 'Tailored Resume')}</title>
<style>
  /* TWO type sizes for the page: 18pt name, 10pt everything else. Hierarchy
     comes from weight, capitals and rules -- see renderDocx.js. */
  @page { size: letter; margin: 0; }
  * { box-sizing: border-box; }
  /* SPACING IS DERIVED FROM renderDocx.js, not chosen. Every value below is
     that file's twips divided by 20 (twips -> points), because the two files
     must render the same document and a comfortable-looking stylesheet is
     not the same thing as a matching one.

     line-height 1.15 is Word's single spacing for Arial. It was 1.3, which
     reads better on screen and added about 1.5pt to EVERY line -- roughly an
     inch over a full resume, enough to push a one-page DOCX onto a second
     PDF page while the word budget still said it fit. */
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.15; color: #1a1a1a; margin: 0; }
  .sheet { max-width: 7.5in; margin: 0 auto; padding: 0.4in; }
  h1 { font-size: 18pt; text-align: center; margin: 0 0 1pt; }          /* docx after 20tw */
  .contact { text-align: center; margin: 0 0 7pt; }                     /* docx after 140tw */
  .summary { margin: 0 0 7pt; }                                         /* docx after 140tw */
  h2 { font-size: inherit; text-transform: uppercase; border-bottom: 1px solid #1a1a1a; padding-bottom: 2pt; margin: 7pt 0 3.5pt; }  /* docx before 140tw / after 70tw */
  p { margin: 0 0 2pt; }                                                /* docx after 40tw */
  /* Titles down the left edge, chronology down the right: the arrangement a
     reader scans fastest, and what both reference resumes do. */
  .role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 5pt; }  /* docx before 100tw */
  .role-title { font-weight: bold; }
  .role-date { white-space: nowrap; }
  .role-context { font-style: italic; margin-bottom: 2pt; }             /* docx after 40tw */
  /* Justified: bullets, summary and skills all run to multiple lines, and a
     flush right edge is what makes a dense one-page resume read as a block of
     text. Headings, titles and dated rows stay ragged -- stretching a short
     line to the margin looks broken. */
  .summary, .justified, li { text-align: justify; }
  ul { margin: 0 0 1pt; padding-left: 18px; }
  li { margin-bottom: 1pt; }                                            /* docx after 20tw */
  .print-hint { background: #e0edee; border: 1px solid #0f6e78; border-radius: 4px; padding: 10px 14px; margin-bottom: 16px; font-size: 10pt; }
  /* The screen page and the PRINTED page are different geometries, and
     conflating them silently changed the document. .sheet pads 0.4in to
     look like paper on screen; @page sets the real print margin. Without
     this override both applied, so a printed PDF measured 1.00in sides
     against the DOCX's 0.60in -- a 0.40in narrower text block, different
     line breaks, and a one-page budget (measured against the DOCX) that no
     longer describes the PDF. Verified by printing and measuring the text
     bbox, not by reading the CSS. */
  /* THE MARGIN LIVES IN THE CONTENT, and @page is zero. That looks backwards
     and is deliberate.

     Chrome's print dialog has a Margins control (Default / None / Minimum /
     Custom) and it OVERRIDES the @page margin. A user who once chose "None"
     keeps it, silently, forever. Relying on @page therefore produced a resume
     printed edge to edge -- section rules running off both sides and words
     clipped mid-line -- while every measurement through Playwright looked
     perfect, because page.pdf() has no dialog to disagree with it.

     Padding is content. Nothing in the dialog can remove it. With @page at
     zero, "Default" and "None" both land on exactly the DOCX template's 0.30/0.60/0.50in.
  */
  @media print {
    .print-hint, .print-actions { display: none; }
    .sheet { max-width: none; margin: 0; padding: 0.30in 0.60in 0.50in; }
  }
</style>
</head>
<body>
  <div class="print-hint">
    Before printing: open <strong>More settings</strong> and uncheck <strong>Headers and footers</strong> —
    Chrome prints a date, this page's title, and its URL onto the page by default, and no amount of
    styling here can turn that off.
  </div>
  <div class="print-actions" style="margin-bottom:16px;">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="sheet">
    <h1>${escapeHtml(model.name)}</h1>
    <p class="contact">${escapeHtml(contactLine)}</p>
    ${model.summary ? `<h2>${escapeHtml(model.summaryHeading || 'SUMMARY')}</h2><p class="summary">${escapeHtml(model.summary)}</p>` : ''}
    ${skillsHtml}
    ${sectionsHtml}
  </div>
</body>
</html>`;
}

/**
 * Open the print dialog as soon as the preview loads.
 *
 * Applied when the tab is opened rather than baked into the stored HTML, so
 * there is one copy of each preview in storage rather than two. Verified
 * empirically that inline handlers DO run in the data: URL tab the popup
 * creates -- that is not obvious, and the whole feature depends on it.
 *
 * Cancelling the dialog leaves the user on the preview page, so this button
 * still does both jobs: the dialog IS the preview for anyone who just wants
 * the PDF, and the page is there for anyone who wants to read it first.
 */
export function withAutoPrint(html) {
  if (typeof html !== 'string' || !html) return html;
  if (html.includes('onload="window.print()"')) return html;
  return html.replace('<body>', '<body onload="window.print()">');
}
