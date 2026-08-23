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

function renderEntries(entries) {
  return entries.map((entry) => `
    <p class="role-title">${escapeHtml(entry.title || '(untitled role)')}</p>
    ${entry.meta ? `<p class="role-meta">${escapeHtml(entry.meta)}</p>` : ''}
    ${entry.bullets.length ? `<ul>${entry.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
  `).join('');
}

/** @param {import('./resumeModel.js').ResumeModel} model */
export function renderResumeHtml(model) {
  const contactLine = model.contact ? model.contact.split('\n').join(' | ') : '';
  const skillsHtml = model.skills && model.skills.lines.length
    ? `<h2>${escapeHtml(model.skills.heading || 'SKILLS')}</h2>${model.skills.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}`
    : '';
  const sectionsHtml = model.sections.map((section) => `
    <h2>${escapeHtml(section.heading)}</h2>
    ${section.entries ? renderEntries(section.entries) : section.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}
  `).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(model.name || 'Tailored Resume')}</title>
<style>
  @page { size: letter; margin: 0.75in; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt; line-height: 1.3; color: #1a1a1a; margin: 0; }
  .sheet { max-width: 7.5in; margin: 0 auto; padding: 0.4in; }
  h1 { font-size: 18pt; text-align: center; margin: 0 0 4px; }
  .contact { text-align: center; font-size: 9pt; margin: 0 0 14px; }
  .summary { margin: 0 0 14px; }
  h2 { font-size: 11pt; border-bottom: 1px solid #1a1a1a; padding-bottom: 3px; margin: 14px 0 7px; }
  p { margin: 0 0 4px; }
  .role-title { font-weight: bold; margin-top: 8px; }
  .role-meta { font-style: italic; font-size: 9.5pt; margin-bottom: 4px; }
  ul { margin: 0 0 6px; padding-left: 18px; }
  li { margin-bottom: 2px; }
  .print-hint { background: #e0edee; border: 1px solid #0f6e78; border-radius: 4px; padding: 10px 14px; margin-bottom: 16px; font-size: 10pt; }
  @media print { .print-hint, .print-actions { display: none; } }
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
    ${model.summary ? `<p class="summary">${escapeHtml(model.summary)}</p>` : ''}
    ${skillsHtml}
    ${sectionsHtml}
  </div>
</body>
</html>`;
}
