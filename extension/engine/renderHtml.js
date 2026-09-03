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

// Mirrors renderDocx.js's splitMeta: the date belongs at the right margin,
// the rest is a subtitle. Kept in step deliberately -- the two exits are one
// design, so a change to how a role reads has to land in both.
const META_DATE_RE = /^(?:[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})\s*[-–—]\s*(?:present|current|[A-Za-z]{3,9}\.?\s+\d{4}|\d{4})$/i;
const INLINE_CONTEXT_MAX = 92;

function splitMeta(meta) {
  const parts = String(meta || '').split(' · ').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return { date: '', context: '' };
  if (META_DATE_RE.test(parts[0])) return { date: parts[0], context: parts.slice(1).join(' · ') };
  return { date: '', context: parts.join(' · ') };
}

// Mirrors renderDocx.js. Written as a literal for the same reason it is there:
// \s and \d are not valid escapes in a template literal and collapse to bare
// letters, which silently produces a pattern that matches nothing.
const TRAILING_YEAR_RE = /^(.*\S)\s{2,}((?:[A-Za-z]{3,9}\.?\s+)?\d{4}(?:\s*[-–—]\s*(?:present|current|(?:[A-Za-z]{3,9}\.?\s+)?\d{4}))?)\s*$/i;
const LEADING_BULLET_RE = /^[-*•▪◦‣]\s+/;

/** A plain section line: a dated row (education) reads like a role. */
function renderLine(line) {
  const dated = TRAILING_YEAR_RE.exec(line);
  if (dated) {
    return `<div class="role-head"><span class="role-title">${escapeHtml(dated[1].trim())}</span>`
      + `<span class="role-date">${escapeHtml(dated[2].trim())}</span></div>`;
  }
  return `<p class="justified">${escapeHtml(line)}</p>`;
}

function renderEntries(entries) {
  return entries.map((entry) => {
    const title = entry.title || '(untitled role)';
    const { date, context } = splitMeta(entry.meta);
    const inline = context && `${title} · ${context}`.length <= INLINE_CONTEXT_MAX;
    const headline = inline ? `${title} · ${context}` : title;
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
  // Source order, same as renderDocx: skills is parsed into its own field but
  // must print where the resume put it.
  const blocks = [];
  if (model.skills && model.skills.lines.length) {
    blocks.push({
      order: model.skills.order ?? -1,
      html: `<h2>${escapeHtml(model.skills.heading || 'SKILLS')}</h2><ul>${
        model.skills.lines.map((l) => `<li>${escapeHtml(l.replace(LEADING_BULLET_RE, ''))}</li>`).join('')}</ul>`,
    });
  }
  model.sections.forEach((section, i) => {
    blocks.push({
      order: section.order ?? i,
      html: `<h2>${escapeHtml(section.heading)}</h2>${
        section.entries
          ? renderEntries(section.entries)
          : section.lines.map((l) => (LEADING_BULLET_RE.test(l)
            ? `<ul><li>${escapeHtml(l.replace(LEADING_BULLET_RE, ''))}</li></ul>`
            : renderLine(l))).join('')}`,
    });
  });
  blocks.sort((a, b) => a.order - b.order);
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
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.3; color: #1a1a1a; margin: 0; }
  .sheet { max-width: 7.5in; margin: 0 auto; padding: 0.4in; }
  h1 { font-size: 18pt; text-align: center; margin: 0 0 4px; }
  .contact { text-align: center; margin: 0 0 14px; }
  .summary { margin: 0 0 14px; }
  h2 { font-size: inherit; text-transform: uppercase; border-bottom: 1px solid #1a1a1a; padding-bottom: 3px; margin: 14px 0 7px; }
  p { margin: 0 0 4px; }
  /* Titles down the left edge, chronology down the right: the arrangement a
     reader scans fastest, and what both reference resumes do. */
  .role-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 8px; }
  .role-title { font-weight: bold; }
  .role-date { white-space: nowrap; }
  .role-context { font-style: italic; margin-bottom: 4px; }
  /* Justified: bullets, summary and skills all run to multiple lines, and a
     flush right edge is what makes a dense one-page resume read as a block of
     text. Headings, titles and dated rows stay ragged -- stretching a short
     line to the margin looks broken. */
  .summary, .justified, li { text-align: justify; }
  ul { margin: 0 0 6px; padding-left: 18px; }
  li { margin-bottom: 2px; }
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
