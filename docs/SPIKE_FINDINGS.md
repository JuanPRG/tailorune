# Phase 0 Spike — Empirical Findings

Run 2026-08-20 with Node 24 / npm 10 / pypdf / python-docx / the Playwright already vendored in
hirepilot v4. Every number below is measured, not researched.

## Baseline: what v4 ships today

57 tailored PDFs from the live install (`~/.hirepilot/v4_data/tailored`):

| Metric | Result |
|---|---|
| Producer | `Skia/PDF` (Chromium backend) — **57/57** |
| Tagged PDF (`StructTreeRoot`) | **0 / 57** |
| Page count | 1 page — **57 / 57** |
| Text-extraction failures | **0 / 57** (170–516 words each, correct reading order) |

Two consequences:

1. `page.pdf()` *is* CDP `Page.printToPDF` *is* Chrome's print-to-PDF — the same Skia backend.
   Moving from Playwright to `window.print()` is **the same renderer**, not a fidelity tradeoff.
2. The shipping output is **untagged** and evidently parses fine, which also removes "untagged"
   as an objection to programmatic generation.

## The decisive test: Unicode fidelity

Same content rendered through each generator, then text-extracted.

| Probe | Chromium / Skia | jsPDF 4.2.1 (standard fonts) | `docx` 9.x |
|---|---|---|---|
| `José` | OK | **LOST** | OK |
| `García` | OK | **LOST** | OK |
| `Müller` | OK | **LOST** | OK |
| `François` | OK | **LOST** | OK |
| `Łukasz` | OK | **LOST** — silently becomes `Aukasz` | OK |
| `•` `—` `€` `½` `©` | OK | OK | OK |

**jsPDF's failure mode is worse than it looks.** The characters are present in the file, but any
line containing one is extracted letter-spaced:

```
 A c c e n t s :   J o s é   G a r c í a   /   M ü l l e r
```

So `"José" in text` is **false** — an accented name is not findable as a token. For a resume
tool, where the candidate's own name is the single most important string in the document, this is
disqualifying. `Ł → A` is outright data corruption.

Fixing it requires embedding a Unicode TTF via `addFileToVFS`/`addFont`, which adds bundle weight
and its own verification burden. Chromium and the `docx` library both get this right for free.

## Sizes

| Artifact | Size |
|---|---|
| jsPDF minified (`jspdf.es.min.js`) | 344 KB |
| jsPDF output PDF | 6.7 KB |
| `docx` output DOCX | 9.1 KB |
| Chromium output PDF | 43 KB |

## `@page` CSS controls Chromium's print margins

200 identical lines, measuring how many land on page 1:

| Setup | Lines on page 1 |
|---|---|
| no `@page`, no margin arg | 66 |
| `@page{margin:0.75in}`, no margin arg | 57 |
| `@page{margin:2in}`, no margin arg | 42 |
| `@page{margin:2in}` + Playwright `margin:0.25in` | 42 |

`@page` CSS **is** respected. Note the last row **contradicts the comment at
`render.py:98-101`** ("Playwright's own `margin` option always wins over any CSS `@page` margin
rule") — in this Chromium build the CSS won.

## Deterministic page fit works

The jsPDF spike reported `content height used: 437pt of 684 available` *before* drawing —
confirming height can be solved arithmetically rather than by the current render → count → shrink
→ re-render loop. This property is real, but it belongs to any generator where we own the layout,
not to jsPDF specifically.

## What ATS vendors actually document

Primary sources only; resume-advice blogs excluded as they repeat each other.

| Source | Accepted formats | Stated preference |
|---|---|---|
| Greenhouse | `.doc .docx .pdf .rtf .txt` | **None** |
| Workday | not enumerated | **None.** Only guidance: *"For best results, use resumes that don't have images or image-based styles."* Parsing "can vary based on resume format and order of words." |
| Textkernel (parsing engine behind many ATS) | 70+ formats | **None — explicitly no ranking.** Only caveat is OCR cost for image PDFs. |

**No primary source distinguishes PDF from DOCX for parsing accuracy, and none mentions tagged
vs untagged PDFs at all.** The common "use .docx for ATS" advice is not supported by any vendor
documentation checked. The consistently-flagged risks are image-based content and reading order —
neither of which is a container-format choice.

## Conclusions

1. **Format choice (PDF vs DOCX) is not the ATS risk it is commonly claimed to be.** Reading order
   and image-based content are.
2. **jsPDF is out as a default.** Not for layout effort — for Unicode. Accented names break.
3. **Chromium print and the `docx` library both have perfect Unicode fidelity**, and DOCX needs no
   font embedding at all.
4. Untagged output is fine, corroborated by both the 57-file corpus and the absence of any vendor
   guidance to the contrary.

## Still unverified

- Chrome's **interactive** print dialog lets the user override margins (Default/None/Custom).
  Not testable headlessly; a user on non-default margins could break a fitted one-page layout.
- The `docx` library was tested **in Node, not under MV3 CSP**. Extension viability unconfirmed.
- pdf.js under MV3 (input parsing) untested.
- `pypdf`/`python-docx` are proxies for real ATS parsers, not the parsers themselves.
