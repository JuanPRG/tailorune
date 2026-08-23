// extractDocxText.js — .docx -> plain text, paragraph breaks preserved.
//
// Deliberately NOT a port of hirepilot_v4/docx_ingest.py's rich style
// extraction (font, size, weight, color, spacing, indent, alignment,
// bottom-border underline via raw OOXML `qn()` access). That richness is
// exactly what MIGRATION_PLAN.md §1.1 identifies as unreliable in practice
// (python-docx returns None for anything inherited from a style rather than
// a direct run override) and not worth reproducing for a tool that already
// standardizes on one output template. All this needs from a .docx is its
// text, in original paragraph order, which parseTxt.js's existing heuristics
// can then classify exactly as they do for a .txt file.
//
// Regex-based, not DOMParser-based, on purpose: DOMParser only exists in a
// browser/offscreen-document context, and this module is unit-tested in
// plain Node against real .docx fixtures. `word/document.xml`'s structure is
// simple enough (paragraphs are `<w:p>`, text runs are `<w:t>`) that a
// regex pass is both portable and sufficient.

import JSZip from 'jszip';

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<string>} paragraphs joined by "\n", matching the shape parseTxt() expects
 */
export async function extractDocxText(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Not a valid .docx: word/document.xml is missing.');
  const xml = await docFile.async('string');

  // Split into paragraphs first (<w:p ...>...</w:p>), then pull every text
  // run out of each paragraph independently -- this is what keeps line
  // breaks in the right place instead of flattening the whole document into
  // one run of text.
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = paragraphs.map((p) => {
    const runs = p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    const text = runs
      .map((r) => decodeXmlEntities(r.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, '')))
      .join('');

    // A real Word bulleted list carries no literal bullet character in its
    // text at all -- the glyph is rendered purely from <w:numPr> list
    // metadata (confirmed against tests/fixtures/resumes/juan-rivera.docx,
    // a real resume whose bullets were silently swallowed as bogus new
    // "entries" before this check existed, exactly the failure mode
    // hirepilot_v4/docx_ingest.py's own `_has_list_numbering` exists to
    // catch). Restore a literal marker so parseTxt.js's BULLET_RE, which
    // only understands literal characters, sees it as any other bullet.
    const hasListNumbering = /<w:pPr>[\s\S]*?<w:numPr>/.test(p);
    if (hasListNumbering && text && !/^[-*•▪◦‣]\s/.test(text)) {
      return `- ${text}`;
    }
    return text;
  });

  return lines.join('\n');
}
