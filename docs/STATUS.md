# Implementation Status

Tracks what actually exists in code, against MIGRATION_PLAN.md's phases. Updated as work lands —
this file describes the repo as it is, not as it's planned to be.

**Scope for this build: resume tailoring and cover letters.** **Autofill** is the one feature
explicitly out of scope per the standing decision. This repo is a standalone experiment, not a
parallel track alongside v4, and no user data is migrated — real resumes are used only as test
fixtures.

## Done

**Phase 1 — Skeleton.** MV3 manifest, service worker, offscreen document, build pipeline
(`npm run build` bundles the offscreen entry and vendors pdf.js's prebuilt files).

Permissions are deliberately narrow: `storage`, `downloads`, `offscreen`, plus `activeTab` and
`scripting` for reading a job posting. `host_permissions` covers only the 4 LLM API hosts. There is
**no declared `content_scripts` entry and no broad host access** — the job-page reader is injected
on demand under `activeTab`, which Chrome grants for a single tab only because the user clicked
this extension's own toolbar button. Dropping autofill is what keeps it this small.

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

**Phase 4 — reliability, complete.** Two layers. `chatWithRetry()` retries only what is actually
transient (timeouts, network errors, HTTP 429/5xx) with exponential backoff, and fails fast on a bad
key or malformed output where a retry would get the same answer. Above it, `chatWithRotation()`
walks a chain built from every provider the user supplied a key for, expanded into one entry per
model and interleaved round-robin by model index — so every provider's best model is tried before
any provider's fallback model. Cooldowns are keyed per (provider, model), because free-tier limits
are commonly per-model: a throttled `gemini-2.5-flash` must not take `gemini-3.1-flash-lite` down
with it. A quota 429 earns a 15-minute cooldown and a plain rate-limit 429 earns 60 seconds, told
apart by inspecting the response body. One rotating caller is shared across the resume, skills,
judge, and cover-letter passes, so a provider throttled early is already cooling down later in the
same run.

## Feature parity with v4 (non-autofill)

The first pass of this build shipped only the thin vertical slice and deferred several v4 features
behind a "Phase 2" boundary. That was the wrong call — the only feature actually excluded from
scope was autofill, and cover letter generation had been listed as a keep from the very first
message. Those gaps are now closed:

| v4 feature | Status here |
|---|---|
| Resume tailoring | Ported, with preferences + validation + retry |
| **Cover letter generation** | **Ported** — `coverLetter.js`, full validation suite, own DOCX + print preview |
| **Prompt preferences** | **Ported** — `preferences.js`, wired into both the resume and letter prompts and into the popup UI |
| **Tailoring validation + retry** | **Ported** — `validateTailoredModel()` plus a retry loop feeding errors back into the next attempt |
| **Shared text utils / anti-fabrication watchlists** | **Ported** — `textUtils.js` (v4 kept these inside `tailor.py` and had five modules import its privates; MIGRATION_PLAN.md §5 flagged that as the one coupling smell to fix during the port) |
| **Skills tailoring** | **Ported** — `tailorSkills.js`, own pass, own prompt, 20% verbatim retention guard enforced deterministically |
| **Multi-provider rotation + cooldowns** | **Ported** — `rotatingClient.js`, per-provider cooldowns with quota-vs-rate-limit distinction |
| Transient-failure retry | Ported (`chatWithRetry`), plus rotation above |
| **JD extraction from the job page** | **Ported** — `content/extractJob.js`, 3 tiers + Indeed adapter, `activeTab` only |
| **LLM judge (semantic review)** | **Ported** — `judge.js`, fails open, advisory, feeds the retry loop |
| **Per-model rotation** | **Ported** — model pools expanded and interleaved, cooldowns keyed per (provider, model) |
| **Resume library** | **Ported** — `resumeLibrary.js`, named resumes in `chrome.storage.local`, last-used reloaded on open |
| Autofill (mapper, rules, answer memory, candidate settings) | **Out of scope by decision** |

### Deliberate departures from v4, with reasons

- **The resume library is smaller than v4's.** Named resumes and a remembered last-used one; no
  archive, no revisions. Those are filing-cabinet features for a database — a dropdown holding at
  most twenty entries does not need them. What is stored is the *extracted text*, not the original
  file: it is what the pipeline consumes anyway (so a saved resume can never drift from what the
  tailorer sees), it is ~5KB rather than ~20KB, and it makes the library format-agnostic — a `.docx`
  uploaded once is, from then on, just a saved resume.
- **No JD cleanup LLM call.** v4 spent a call deriving employer/title from raw scraped JD text.
  Largely obsolete here: `content/extractJob.js` reads both directly from JSON-LD or platform
  selectors for free, and they are editable fields in the popup either way.
- **`tailoring_style` preference dropped.** v4 kept it only so an older extension's Settings UI
  wouldn't break, then forcibly overwrote it and never read it. No legacy UI here to stay
  compatible with.

### Known limitation: the activeTab grant path is not automated

"Read job from this page" depends on `activeTab`, which Chrome grants only when the user *invokes*
the extension on a tab — i.e. clicks its toolbar icon. Playwright cannot click the browser's own
toolbar, so the happy path through a real click is **unverified by automated tests**. What is
tested: the full extraction logic against real pages (all three tiers, `@graph` nesting, async
panes, malformed JSON-LD, job-board name rejection, re-injection safety), and that the service
worker converts a missing grant into actionable guidance rather than leaking Chrome's raw
"Extension manifest must request permission" string. The click path itself needs one manual check.

## Resume library

Named resumes persist in `chrome.storage.local`; reopening the popup reloads whichever was used
last, so the common case — one resume, many applications — costs no interaction at all. Uploading a
file extracts it to text immediately (via a `resume:extract` round trip to the offscreen document,
which is where JSZip and pdf.js live) rather than at tailoring time, which is what makes an uploaded
file saveable and surfaces an unreadable PDF at once instead of a minute into a run.

**The popup reads uploaded files itself.** `.docx` (JSZip) and `.pdf` (pdf.js) are parsed in the
popup, so `popup.entry.js` is bundled to `popup.bundle.js` alongside the offscreen bundle. This
replaced a popup → service worker → offscreen-document round trip: two message hops and three
lifetimes for what is a pure function over bytes. The offscreen document exists because the LLM
pipeline can outlive the service worker's 5-minute event ceiling — reading a file has nothing to do
with that, and inherited a whole class of failure for no benefit. The bundle is ~800KB (pdf.js
inlined) but measures 40ms to DOMContentLoaded in a real popup, so it is not worth code-splitting.

Two consequences worth recording:

- **The textarea is now the single source of truth.** The run payload no longer carries a file, so
  there is no "which input wins" question. A file selection is an import step, not a second input.
- **The popup opens no JS dialogs, ever.** Naming a resume originally used `window.prompt()`. A
  browser-action popup is *dismissed* the moment a dialog opens and `prompt()` then resolves to
  null, so Save silently did nothing for a real user — while passing every e2e test, because
  Playwright loads `popup.html` as an ordinary tab where dialogs behave normally. That context
  difference is invisible to the harness, so naming is now an inline field and deleting is a
  two-step arm/confirm on the button itself. `forbidDialogs()` in the e2e suite fails any test in
  which the popup opens a dialog at all.
- **Settings persist as you type, not only on run.** They used to be written inside the tailor
  handler, so typing an API key and closing the popup discarded it. Both `input` and `change` are
  listened for (debounced): on a text field `change` fires only on *blur*, so a user who types a key
  and clicks straight out of the popup never fires it — verified directly in a browser, not assumed.

### Testing the real popup

`popup.html` loaded in a tab and the actual browser-action popup are different rendering contexts,
and that difference has already hidden a shipped bug: `window.prompt()` works in a tab and silently
dismisses the real popup, so a Save button that saved nothing passed a fully green suite.

`tests/e2e/realPopup.mjs` closes that gap. Chrome exposes the popup as an ordinary CDP page target,
so launching with `--remote-debugging-port` and reconnecting over CDP yields a real Playwright
`Page` backed by the real popup. Two constraints come with it, both inherent:

- `chrome.action.openPopup()` takes no query string, so the `?llmBaseUrlOverride=` hook is
  unavailable — real-popup tests cover everything up to, but not including, an LLM call.
- The popup is **destroyed the instant it loses focus** (verified directly). No real-popup test may
  focus another window or tab. Note this does *not* apply to the OS file picker, which is
  browser-owned — also verified directly, which is what ruled it out as the cause of a reported
  upload failure.

## Guarding against single-resume overfitting

Every original fixture was one person's resume, which is how a heuristic parser ends up encoding one
layout's quirks as rules. It did: a "non-bullet line after a title is a subtitle" rule assumed at
most ONE context line, because that is what the one real fixture had. On an employer/title/date
stack — ordinary in consulting and finance resumes — it produced two roles, buried the real title in
meta, and gave both bullets to a phantom entry titled with a date.

`tests/fixtures/resumes/layouts/` now holds six deliberately different people and layouts: dates on
the left, an employer/title/date stack, unicode bullets with an `OBJECTIVE` heading, leading prose
with no heading at all, a role with no bullets between two that have them, and an unrecognised
`CERTIFICATIONS` section. `parseTxtLayouts.test.mjs` asserts the full parse of each. Their job is to
fail when a fix is shaped around one resume rather than around resumes.

Two things fell out of writing them: entry rules are now shape-based rather than position-based
(a bare date line can never be a title, so it always attaches upward, however many context lines
preceded it), and unrecognised ALL-CAPS headings become their own section instead of merging into
the previous one — kept as verbatim lines, which is also the correct handling for credentials, since
certifications are facts the rewriter must never touch.

## Content quality: concreteness is measured, not requested

A rewrite can preserve every fact and still cost the candidate the job. Asked to make bullets sound
stronger, models reliably trade specific nouns for abstract process verbs — "bookkeeping, financial
reporting, and budget tracking" becomes "comprehensive financial administration … to optimize
operational efficiency". Nothing is fabricated, so every other check passes, but screening is
keyword-driven first and the searchable terms are gone.

`validateTailoredModel()` therefore measures two things per role and feeds failures back into the
existing retry loop:

- **Dropped quantities** — any number in the original bullets missing from the rewrite. "A team of
  15+" beats "cross-functional teams" for every reader, human or machine.
- **Concreteness retention** — the share of the original's specific vocabulary that survives, which
  must clear `MIN_BULLET_CONCEPT_RETENTION` (0.45). Calibrated against a real run rather than
  guessed: a pass that visibly hollowed out its bullets scored 27–33% per role, so 45% flags all of
  them while still permitting over half the wording to change.

Both directions have to be checked, and finding that out cost a real run. Told firmly enough to keep
the concrete words, a model satisfied the instruction by returning the input **verbatim** — which
scores 100% retention, drops no numbers and fabricates nothing, so an untailored resume shipped
reported as `approved`. A retention floor with no counterweight actively rewards copying. A response
that returns the summary and every bullet unchanged is therefore an error that feeds the retry, and
the prompt now names copying as a failure alongside hollowing out.

The summary is deliberately exempt — rewriting it wholesale for a specific job is the legitimate
core of tailoring. The same run scored 15% there, and that was the right outcome.

## Where the time goes

A run is up to **nine sequential model calls**, and none of that is visible from the finished
document:

| Pass | Attempts | Tokens | Notes |
|---|---|---|---|
| Resume | 2 | 4096 | each passing attempt can trigger a judge call |
| Judge | 1 per passing resume attempt | 1024 | opt-out via the checkbox |
| Skills | 2 | 1024 | |
| Cover letter | 3 | 1024 | v4 parity (`max_retries: 3`) |

Every one of those can also rotate across the provider chain on failure - two entries for a single
Gemini key, since the model pool expands to `gemini-2.5-flash` and `gemini-3.1-flash-lite`. Rotation
does not sleep between entries, so a failover costs a round trip rather than a backoff, but each
request carries a 45s timeout.

`offscreen.entry.js` now records per-phase wall time and a call count, and the popup prints a
breakdown under the word count: `62s in 5 AI calls - resume 31.0s (3 calls), skills 12.4s (1 call),
letter 18.1s (1 call)`. A vertical-slice e2e assertion keeps it alive through the offscreen ->
service worker -> popup hops, since a silently-empty breakdown would be invisible until the next
time somebody asked why a run was slow.

Two things worth knowing when reading a slow run:

- **`RESUME_MAX_TOKENS` was raised from 2048 to 4096** to fix truncated JSON. On a reasoning model
  the cap covers thinking as well as output, so a larger budget permits more thinking - the fix for
  one problem is a plausible cause of another, and the breakdown is what tells them apart.
- **The judge is a whole extra call per passing attempt.** Turning it off is the single biggest
  saving available from the UI.

## The output template

Derived from the strongest of the user's own resumes rather than invented. The rules, and why each
one is a rule:

- **Two type sizes for the whole page** - 18pt name, 10pt everything else. Hierarchy comes from
  bold, capitals and rules. This is the single thing separating a resume that reads as designed from
  one that reads as assembled, and it is the rule most likely to erode: an earlier version of this
  template reached FIVE sizes, including an 8.5pt contact line smaller than anything on a real
  resume, with every individual step defensible at the time. `template.test.mjs` asserts the count.
- **Asymmetric margins** - 0.30in top, 0.75in sides, 0.60in bottom. A wide top margin spends the
  most valuable space on the page; the sides are what actually control how much fits per line.
- **Dates flush right on a real tab stop.** Titles down the left edge, chronology down the right, is
  what a reader scans fastest, and it is what both reference resumes do. The previous template put
  the date at the *start* of a small italic line under the title - burying the field a recruiter
  looks for first, and costing an extra line per role.
- **Short context joins the title line; long context drops to its own.** "Toronto, ON" fits beside a
  title and a date; "Colombia (Remote, Manufacturing and Distribution)" does not.
- **Skills lines are real list items**, and a source line that already carries a bullet marker is
  rendered as a list item rather than printing the marker as literal text.
- **Headings are upper-cased but never reworded** - a resume that says OBJECTIVE keeps saying it.
- **Source section order is preserved.** Skills is parsed out of `sections` into its own field
  because it has its own tailoring pass and its own rules - but that is an implementation detail and
  must not decide where it prints. `parseTxt` records each block's position; a resume that ends with
  skills comes back ending with skills.
- **Body text is justified; titles and dated rows are not.** Bullets, the summary and the skills
  lines all run to multiple lines, and a flush right edge is what makes a dense one-page resume read
  as a block of text. Stretching a short heading to the margin looks broken, and a right-aligned
  date has nothing to justify against.
- **An education line ending in a year is treated as a dated row**, bold with the year flush right,
  exactly like a role. Both reference resumes do this, and both leave the institution line beneath
  it plain - which is what tells the two apart at a glance.

One trap worth recording: the trailing-year pattern is written as a regex **literal**, not assembled
from strings. `\s` and `\d` are not valid escapes inside a template literal and collapse to bare
`s` and `d`, so the first attempt produced a pattern that matched nothing and failed silently - no
error, just education years that never moved. `template.test.mjs` asserts the behaviour that bug
removed.

One deliberate departure from the reference: it has no summary heading, with the summary as leading
prose under the contact line. That looks cleaner and parses worse - an unlabelled opening paragraph
is an orphan to anything segmenting by heading - so the heading stays.

The HTML preview carries the same rules. They are one design with two exits, so a change to how a
role reads has to land in both, and `template.test.mjs` checks they agree on which context is
inline.

## The judge is advisory, and never costs a retry

Ported from v4's `validation_mode: "lenient"` (`tailor.py:494, 508-512`), which accepts a judge
finding as `approved_with_judge_warning` rather than spending an attempt on it.

The judge never blocked the document - both files were always produced. What it did do was feed its
findings back as avoid-notes for the next attempt, and that is the problem: "this reframing drifted
from the original" asks the model to be MORE literal next time. The check meant to protect the
resume was quietly sanding down the aggressive tailoring the tool exists to do.

So the split is now by *kind of failure*, not by severity:

- **The deterministic validator earns a retry.** Its failures are objective and fixable - a dropped
  quantity, hollowed-out vocabulary, an answer returned unchanged - so naming them gives the model
  something concrete to correct.
- **The judge reports and stops there.** Whether an aggressive reframing is acceptable is a
  judgement call about the candidate's own history, made by the person whose name is on the
  application. Surfacing the finding respects that; overriding it does not.

The findings still appear in the popup, labelled "advisory - nothing was changed", and the
`Review tailoring for accuracy` checkbox still turns the whole pass off to save the call.

## A parse failure and a model echo look identical

Three runs came back byte-identical to the upload. Two rounds of prompt work went into treating that
as a model declining to rewrite. It was not.

`parseLlmJson` returns `{}` when it cannot salvage an object. `applyTailoredContent` then applies an
empty patch, changing nothing, and the rendered document is byte-identical to the input - exactly
what a model echoing its input produces. One output, two completely different causes, and the
reported message named the wrong one.

What actually went wrong: the resume pass emits the largest JSON of the three passes and was left on
the default 2048 `max_tokens`, while skills and cover letter ask for far less on 1024. On reasoning
models `max_tokens` caps thinking AND output together, so a harder posting spends the budget and the
answer arrives truncated mid-JSON. The cover letter kept working throughout because it asks for
prose, and the skills pass because its JSON is small - which is what finally isolated the bullet
pass as the only failing one.

Three changes, and the first is the one that matters:

- **An unusable answer is never applied as an empty patch.** A response with no summary and no
  entries is now a distinct `malformed_response` outcome that retries and, if it never recovers,
  says *"Your resume was NOT tailored: the model ran out of output tokens partway through"* - rather
  than "nothing was tailored", which reads as the model's fault and sent this down the wrong path
  twice. The untouched resume is still produced, just never labelled as tailored.
- **Truncation is visible.** `chat()` surfaces `finish_reason`, so a cut-off answer is diagnosable
  instead of arriving as an unexplained parse failure.
- **`RESUME_MAX_TOKENS` is 4096**, sized for the pass that emits the most.

`applyTailoredContent` also coerces the entry index with `Number()`, since a model answering
`"index": "0"` would miss every lookup and produce the same silent no-op by a different route.

## Prompt ordering, and the weak-connection case

Two consecutive real runs came back with the summary and every bullet byte-identical to the upload,
on both attempts, with the failure fed back into the retry. Both were sales postings against a
finance and administration resume; the run either side of them, for a closer role, tailored fine.
So the model was not ignoring an instruction - it was declining to rewrite bullets it saw no honest
route to connect to the posting, and copying was the available escape.

Two things fixed it, and the second is the substantive one:

- **Order.** The rewrite mandate now precedes the preservation constraint. Stated the other way
  round, "keep the concrete words" reads as the primary instruction and returning the input verbatim
  satisfies it perfectly.
- **v4's weak-connection paragraph** (`tailor.py:137-145`), which had not been ported. It grants the
  model a route through the case it was stuck on: attempt every block including ones with no obvious
  link, a bullet can almost always gain a light keyword or phrasing adjustment without inventing
  anything, and *that is exactly the case that most needs a genuine attempt*. The examples in it are
  load-bearing - they show what an honest improvement looks like when there is no domain overlap to
  lean on. v4 repeats the point at the output contract, where a model choosing what to emit is most
  likely to take the easy path, and so does this now.

## Anti-fabrication parity with v4

Three guards v4 had and this did not, all closed. None of them changes how aggressive the rewriting
is - v4's "be aggressive, fully rewrite phrasing, framing and emphasis" is carried unchanged, and the
aggressive guidance is unconditional in both (v4 kept a `tailoring_style` field only to overwrite it
to "aggressive" and never read it).

- **Skills boundary in the prompt** (`tailor.py:123-125`). The candidate's own declared skills are
  named as an explicit allow-list. Without it the only thing between a job description mentioning
  Kubernetes and a resume claiming it was the model's restraint. Derived per-resume, not from a
  global profile, for the reason `resumeSkillsBoundary()` records.
- **Fabrication watchlist on bullets** (`tailor.py:225-234`). A bullet introducing a watchlisted tool
  or certification present in neither the job description nor the candidate's skills is reverted.
  Multi-word entries like "six sigma" are matched as phrases, which v4's token-only check misses.
- **Length guard** (`tailor.py:252-258`). A bullet grown past 2.5x its original is padding, and it
  blows the one-page budget the compactor then has to claw back.

The last two live in a **repair-first** pass (`repairTailoredModel`), ported from v4's philosophy
rather than folded into the validator: the right answer to one overreaching bullet is a targeted
revert, not a verdict on the whole model. A bullet that claimed Kubernetes costs that bullet; its
neighbours keep their rewrite and the run does not burn a retry on one bad line. Where the model
returns a different bullet count for a role, the whole role reverts - there is no "the original of
this bullet" to fall back to, and reverting one of a re-split pair would leave a repaired bullet
beside an unrepaired neighbour that shared its claim.

Repairs surface in the popup even on an approved run, since "approved" can now mean "one bullet was
silently rolled back" - the one part of the document that did not get tailored.

Two guards that look redundant are not: per-bullet length stops one bullet padding into a paragraph,
the word budget stops an aggregate that is merely long. A resume can breach either alone.

## Test coverage

- `npm run test:unit` - 230 tests, pure logic, no browser: parser heuristics against 3 real TXT
  resumes (a full one, a standard one, and a deliberately sparse edge case with zero section
  headers), the LLM client's error taxonomy and retry/backoff behavior via injected-fetch and
  injected-sleep mocking, the word-budget compactor, prompt-construction leak checks, DOCX text
  extraction against a real `.docx`, HTML render (including an XSS-escaping check, since this HTML
  is opened as a live page), cover-letter validation (word/paragraph bounds, the 5% tolerance band,
  AI-cliche phrases, em-dash rejection, and the fabrication check against the resume's own skills),
  preference validation and prompt-section building, and the tailoring validator's
  professional-identity and dropped-bullet checks, the skills retention guard (including that a
  wholesale replacement reverts rather than being accepted), and provider rotation (failover order,
  cooldown expiry, quota-vs-rate-limit cooldown lengths, and that a 400 is not retried across the
  chain), the semantic judge (that it fails open on error, malformed output, and a missing `passed`
  field; that it skips the call when nothing changed; and that it is not called when the
  deterministic validator already failed), and per-model chain expansion and interleaving.
- `npm run test:e2e` — 22 tests, real Chromium, real unpacked extension load, real
  `chrome.downloads` calls: pasted-text vertical slice (DOCX download + HTML preview tab, both
  checked), real `.docx` upload, real `.pdf` upload, and the resume library round trip — a `.docx`
  uploaded once, the popup closed, then reopened and tailored with the saved resume and no second
  upload. LLM calls are answered by a real local HTTP
  server (`mockLlmServer.mjs`) rather than `context.route()`, which does not intercept
  offscreen-document fetches — confirmed by direct experiment, not found in any doc.
