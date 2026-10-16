// pdfText.js — the pdf.js-agnostic half of PDF resume extraction.
//
// Split out of extractPdfText.js so the agent API can run the same text
// assembly and scanned-PDF guard in Node, where pdf.js comes from
// pdfjs-dist's legacy build instead of the vendored browser bundle. Which
// pdf.js to use is the caller's business; what counts as a readable resume
// is decided here, once.
//
// Ported guard from v4/fallback_txt_pdf.py:42-48
// (MIN_EXTRACTABLE_WORDS = 20): a PDF with too little extractable text is
// almost always a scanned/image PDF, not a real parsing failure, and OCR
// is out of scope here exactly as it was there.

export const MIN_EXTRACTABLE_WORDS = 20;

export class NoExtractableTextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoExtractableTextError';
  }
}

/**
 * @param {object} pdfjsLib  a loaded pdf.js module (vendored in Chrome, pdfjs-dist/legacy in Node)
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {object} [documentOptions]  extra getDocument() options. Node passes its standard-font
 *   location and a quiet verbosity, since pdf.js warns on stdout -- where the CLI writes its JSON.
 * @returns {Promise<string>} page texts joined by "\n\n"
 */
export async function extractPdfTextWith(pdfjsLib, bytes, documentOptions = {}) {
  const doc = await pdfjsLib.getDocument({ ...documentOptions, data: bytes }).promise;
  const pageTexts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // pdf.js returns positioned text items; naive concatenation drops the
    // spaces/newlines a reader expects (confirmed live in
    // SPIKE_FINDINGS.md: "Juan RiveraToronto, ON" with no separator).
    // hasEOL marks a genuine line break; otherwise items on the same line
    // are joined with a space unless one already ends in whitespace.
    let text = '';
    for (const item of content.items) {
      text += item.str;
      if (item.hasEOL) text += '\n';
      else if (item.str && !/\s$/.test(item.str)) text += ' ';
    }
    pageTexts.push(text);
  }

  const fullText = pageTexts.join('\n\n');
  const wordCount = (fullText.match(/\S+/g) || []).length;
  if (wordCount < MIN_EXTRACTABLE_WORDS) {
    throw new NoExtractableTextError(
      `Only ${wordCount} extractable words found -- this looks like a scanned/image PDF, which this tool cannot read text from.`,
    );
  }

  return fullText;
}
