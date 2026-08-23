# Implementation Status

Tracks what actually exists in code, against MIGRATION_PLAN.md's phases. Updated as work lands —
this file describes the repo as it is, not as it's planned to be.

**Scope for this build: tailoring + resume (CV) only.** Autofill, cover letters, and the v4
backend are explicitly out of scope per the standing decision — this repo is a standalone
experiment, not a parallel track alongside v4, and no user data is migrated (real resumes are used
only as test fixtures).

## Done

**Phase 1 — Skeleton.** MV3 manifest (`offscreen`, `storage`, `downloads`; host_permissions for
the 4 LLM hosts only — no autofill means no broad content-script permissions at all), service
worker, offscreen document, build pipeline (`npm run build` bundles the offscreen entry + vendors
pdf.js's prebuilt files).

**Phase 2 — Vertical slice, exceeded.** The plan's minimum bar was "TXT in → one LLM call → DOCX
in Downloads." Built and proven with a real end-to-end browser test (not just unit tests):
popup → service worker → offscreen document → real HTTP call → parse → tailor → word-budget
compaction → DOCX render → real `chrome.downloads.download()` → file readable on disk with correct
content. `tests/e2e/vertical-slice.test.mjs`.

**Phase 5 — Input parsing, partial.** TXT, DOCX, and PDF input all work, verified against the
user's own real resume files (not synthetic fixtures) in both unit tests and a full browser e2e
test per format (`tests/e2e/file-upload.test.mjs`). DOCX extraction is regex-based (see
`extractDocxText.js`'s module comment for why that's a deliberate choice, not a shortcut) and
already had one real bug found and fixed: Word's native bulleted lists carry no literal bullet
character in the text at all — the glyph comes from `<w:numPr>` list metadata — so bullets were
initially swallowed as bogus title-only entries. Fixed at the extraction boundary; regression test
added. PDF extraction uses pdf.js exactly as verified in `SPIKE_FINDINGS.md`: the same prebuilt
files, same `wasm-unsafe-eval`-free CSP posture, plus explicit item-spacing handling the spike
flagged as needed (`"Juan RiveraToronto, ON"` with no separator otherwise).

**Anti-fabrication, architectural.** `resumeModel.js` separates locked fields (name, contact,
every entry's title/meta, education) from editable ones (summary, bullets). Locked fields are
never serialized into the LLM prompt — not "instructed against," structurally absent. A real
near-miss: an earlier draft of `tailor.js` included each entry's title+date as "context" for the
LLM; a test written to check for exactly this caught it before it shipped.

**One-page budget.** `compactToWordBudget()` replaces v4's render→count→shrink→re-render loop with
the ~570-word arithmetic budget measured in `SPIKE_FINDINGS.md`.

**Phase 6 — both output exits built.** DOCX (primary) auto-downloads via `chrome.downloads`, as
above. HTML preview (secondary) opens in a real tab via a data URL from the popup's "Preview /
Print PDF" button, one content model rendered two ways per `MIGRATION_PLAN.md` §3-4 — not two
designs. The preview carries a visible reminder to uncheck Chrome's "Headers and footers" print
setting, since `SPIKE_FINDINGS.md`'s gap-3 closure found that default injects a date/title/URL/page
number onto the printed page and no CSS can suppress it. Verified end to end in
`vertical-slice.test.mjs`: clicking the button opens a real tab with the tailored content and the
print hint both present.

**Reliability, a right-sized slice of Phase 4.** `chatWithRetry()` retries only what's actually
transient — timeouts, network errors, HTTP 429/5xx — with exponential backoff, and fails fast on
everything else (a bad API key, malformed JSON, an empty response) where retrying would just waste
time and get the same answer. This is not the full `RotatingClient` port (no multi-provider
rotation, no per-model cooldowns) — that's still Phase 4 proper — but it closes the most common
real-world failure mode (a transient rate limit killing the whole tailoring run) without that
larger scope.

## Explicitly simplified from v4, on purpose

- One combined LLM call for summary+bullets. v4 runs two separate calls (main content, then
  skills, with its own judge/retry loop). Skills are currently passed through unchanged.
- No provider rotation or per-model cooldowns across multiple providers (`llm.js` is
  single-provider). Full `RotatingClient` fidelity is Phase 4 proper; what's built now is
  single-provider retry-on-transient-failure, described above.
- No cover letter generation yet.
- No settings persistence UI beyond provider/model/API key.

## Test coverage

- `npm run test:unit` — 47 tests, pure logic, no browser: parser heuristics against 3 real TXT
  resumes (a full one, a standard one, and a deliberately sparse edge case with zero section
  headers), the LLM client's error taxonomy and retry/backoff behavior via injected-fetch and
  injected-sleep mocking, the word-budget compactor, prompt-construction leak checks, DOCX text
  extraction against a real `.docx`, HTML render (including an XSS-escaping check, since this HTML
  is opened as a live page).
- `npm run test:e2e` — 3 tests, real Chromium, real unpacked extension load, real
  `chrome.downloads` calls: pasted-text vertical slice (DOCX download + HTML preview tab, both
  checked), real `.docx` upload, real `.pdf` upload. LLM calls are answered by a real local HTTP
  server (`mockLlmServer.mjs`) rather than `context.route()`, which does not intercept
  offscreen-document fetches — confirmed by direct experiment, not found in any doc.
