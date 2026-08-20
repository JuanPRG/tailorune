# Tailorune — Backend Elimination Plan

Porting HirePilot v4 (Python backend + Chrome extension) to a **standalone Chrome extension**.

Motivation: user feedback that a backend install deters adoption. Today's install is a
**490 MB installer** (101 MB of it Playwright) for a resume-tailoring tool that runs inside
Chrome. Target: a ~5 MB Web Store extension, one click, cross-platform, auto-updating.

---

## 1. What the analysis found

Four parallel deep-dives over `backend/hirepilot_v4/` (11,077 LOC) and `extension/` (6,919 LOC).

### 1.1 The headline: the compromises are mostly already made

The single most important finding. Three of the "sacrifices" in this migration **already exist
in the shipped product**:

| Assumed sacrifice | Reality in v4 today |
|---|---|
| "Lose formatting preservation" | DOCX **output** already builds from a blank template (`docx_export.py:94` — `docx.Document()` with no argument) and *deliberately discards* the source's own `docDefaults` (`docx_export.py:117-120`, with a documented rationale). |
| "Standardize on one template" | Already exists and is tested: `fallback_txt_pdf.py` normalizes every `.txt`/`.pdf` input to a house template — `_GENERIC_STYLE_KWARGS:158-173`, `_GENERIC_PAGE:145` (Arial, 18pt centered name, black section rule). |
| "DOCX fidelity is rich and will be missed" | What actually survives a `.docx` is **11 scalar properties per paragraph**, and even those are unreliable: `python-docx` returns `None` when formatting comes from a *style* rather than a direct run override, so a resume with styled headings yields `bold=None`. Paragraph formatting is also taken from `runs[0]` only (`docx_ingest.py:212-228`). |

On top of that, v4 already overrides source fidelity on purpose in several places, each
self-documented in the code: margins are clamped (`docx_ingest.py:336-364`, comment calls it
*"an explicit override of 'preserve original formatting exactly'"*), the section-header rule
colour is invented (`render.py:182-186`, *"entirely a hirepilot_v4 design choice"*), tables are
linearized and **reordered widest-cell-first** (`docx_ingest.py:405-406`), and the one-page
compaction loop uniformly shrinks all fonts/spacing by up to 15% (`render.py:202`).

**Therefore:** "standardized template only" is not a downgrade. It is *promoting the
already-written, already-tested `fallback_txt_pdf` path to be the only path.* That single
decision deletes `docx_export.py` entirely, all of `docx_ingest.py`'s style extraction, and
`render.py`'s `_style_to_css` — while keeping the ~250 lines of classification logic that
actually matter.

### 1.2 Most of the backend is pure logic

| Property | Finding |
|---|---|
| Tokenizer | **None.** Char-count estimate: `ceil(chars/3.3) + 6*msgs`, output assumed 25% of prompt, floor 128 (`llm.py:634-639`). |
| async | **None.** Zero `async`/`await`/`asyncio` in the entire package. All LLM calls synchronous. |
| Streaming | **None.** Plain `POST` + `resp.json()`. No `stream=`, no `iter_lines`. |
| Prompts | Plain f-strings + `"\n".join`. No Jinja, no templating engine. |
| Section detection | **100% regex/heuristic, zero LLM** (`docx_ingest.py:67-89`, `resume_profile.py:25-57`). |
| Autofill mapper | Pure regex + dict matching. **Zero Python-only regex features** — no named groups, no lookbehind, no `re.VERBOSE`, no inline flags. |
| HTTP surface | 5 `httpx` calls total: `Client(timeout=)`, `.post()`, `.raise_for_status()`, `.json()`, `.headers`. No HTTP/2, no custom TLS, no proxies, no pooling config. |

The LLM layer's 2,427 lines are ~1,500 lines of **portable logic** (chain building, rotation,
cooldown bookkeeping, rate-limit math, failure classification, response shape extraction) around
~300 lines of `httpx`/`threading`/`socket` that need a different mechanism, plus dead code
(`_gemini_spec`, `_local_spec`, `_openai_spec`, `_registry_spec`, `_local_endpoint_reachable` —
all uncalled).

### 1.3 Storage is a non-issue

Measured on the live install (`~/.hirepilot/v4_data`):

| Store | Measured | Saturated ceiling |
|---|---|---|
| 8 resumes (metadata + binary + derived profile) | **129 KB** | 17–22 KB per `.docx` |
| candidate settings + 1 revision | 12 KB | ~75 KB per revision |
| prompt preferences | 285 B | ~2.5 KB hard cap |
| answer memory | *never created* | ~1 MB (`MAX_ENTRIES=500`, LRU) |
| **Total config/state** | **~150 KB** | **~1 MB** |

`chrome.storage.local` is 10 MB. Full resume *text* is not stored — it is re-extracted on demand
(`resume_library.py:274-275`). Only the ~20 KB binary persists. Binaries go to IndexedDB.

Unbounded growth today is entirely in **output** dirs with no pruning (`tailored/` measured at
4.0 MB, `download_handoff/` 936 KB of never-cleaned staging). In the extension these become
`chrome.downloads` calls — the user's Downloads folder, not our problem.

### 1.4 ~1,400 lines of plumbing simply evaporate

`server.py` (1,210) · `tray.py` (551) · `updater.py` (385) · `diagnostics.py` (223) ·
`launcher.py` (201) · `setup_health.py` (49) · `render.py`'s Playwright thread+queue worker (~130)

Plus, on the extension side: the connection dot and 2 s ping loop, the connection-recovery panel
(`popup/index.html:56-93`), the `hirepilot://start` protocol handler, companion-startup polling,
the version-compat notice, the API-key form, and the 20 s `getPlatformInfo()` keep-alive hack.

Plus the entire **download handoff dance**: today the backend writes a PDF, the extension fetches
it back over HTTP via `/open?path=...&handoff=1`, and the backend *moves* the file to a
uniquely-named staging path first to dodge a Playwright file-handle race
(`server.py:604-630`). In-extension this is `new Blob([bytes])` → `chrome.downloads.download()`.

Plus the **`/api/fill` HTTP hop** and everything built to make it safe: the per-Fill `/api/ping`
capability probe (`background.js:934-950`), the `fill_v2` contract negotiation, and the 5-tuple
provenance binding re-checked at four points to guard against a stale mapping crossing process
boundaries (`background.js:763-792`, `:1011-1085`). In-process, that is a function call.

### 1.5 The extension already does more than half the job

Zero-backend today, survives untouched:

- **JD extraction** (`content.js:221-378`) — 3 tiers: JSON-LD `JobPosting` → 7 container selectors
  → body dump, plus a per-site Indeed adapter, MutationObserver waits for XHR-repopulated panes,
  and a `confidence` value consumed downstream to force a "Review needed" state.
- **The entire autofill stack** (1,103 lines) — `hp-accname.js` (7-tier accessible-name), `hp-scan.js`
  (12 control kinds, 4 ref-resolution strategies + WeakRef, radio-group collapsing, chrome
  exclusion), `hp-fill.js` (per-control strategies, portaled Workday listboxes, hierarchical
  multi-select tree search with backtracking, post-write DOM verification, honest `reverted`
  count), `hp-ats.js`.
- **Sensitive-field redaction** (`content.js:549-579`), per-tab session state machine with
  serialized mutation queues and run-id cancellation, pin mode, tab inheritance.
- **~765 lines of HTML + ~2,827 lines of CSS** across popup and settings — pure presentation over
  data. Structurally all of it survives.

### 1.6 Verified platform constraints

| Question | Answer | Consequence |
|---|---|---|
| MV3 service worker lifetime | 30 s idle; **5 min max per async event** | A 12-LLM-call tailor run cannot live in the SW |
| Offscreen document lifetime | **Unlimited** | This is where the engine goes |
| CORS from extension pages | **Bypassed** for `host_permissions` hosts | Direct LLM calls work — *and* we still get `Retry-After` / `x-ratelimit-*` headers, which a web page could not read. The cooldown intelligence survives intact. |
| MV3 remote code | Forbidden | All libraries vendored locally |

---

## 2. Target architecture

```
tailorune/
├─ manifest.json                 MV3; host_permissions for 4 LLM hosts + localhost
├─ src/
│  ├─ sw/                        service worker: routing, tab events, downloads
│  ├─ engine/                    ← runs in the OFFSCREEN DOCUMENT (unlimited lifetime)
│  │  ├─ llm/                    provider chain, rotation, cooldown, rate limit
│  │  ├─ pipeline/               tailor · cover-letter · jd-cleanup orchestration
│  │  ├─ parse/                  pdf.js · docx (JSZip) · txt → normalized ResumeModel
│  │  ├─ profile/                resume_profile + resume_analysis ports
│  │  ├─ layout/                 ResumeModel → measured layout → PDF
│  │  └─ store/                  chrome.storage.local + IndexedDB
│  ├─ fill/                      fill_rules · fill_mapper · answer_memory ports
│  ├─ page/                      hp-accname · hp-ats · hp-scan · hp-fill (lifted as-is)
│  ├─ ui/                        popup · settings (lifted, connection UI stripped)
│  └─ shared/                    text utils, regex-ported helpers, types
├─ vendor/                       pdf.js · jspdf · jszip (pinned, local)
└─ tests/                        node:test (pure logic) + Playwright (DOM/live)
```

**Why offscreen, not the service worker:** worst case is 12 sequential LLM calls
(1 JD cleanup + 6 resume + 2 skills + 3 cover letter), each up to a 45 s timeout. That
exceeds the 5-minute event ceiling. The offscreen document has no such limit.

**Resumability.** Job state persists to `chrome.storage.session` between LLM calls so a
memory-pressure reclaim resumes instead of losing the run. Note this is *better* than today:
`_TAILOR_JOBS` is an in-memory dict (`server.py:155`) lost on every backend restart.

**Storage split.** JSON stores → `chrome.storage.local`. Resume binaries and generated PDFs →
IndexedDB. `unlimitedStorage` requested for headroom. Content-addressing keeps working:
`crypto.subtle.digest('SHA-256', …)` is native.

---

## 3. The four hard problems

### 3.1 PDF generation — the only real risk

Today: HTML string → Playwright `page.pdf()` → CDP `Page.printToPDF`.

| Option | Fidelity | Cost |
|---|---|---|
| **A.** `chrome.debugger` + `Page.printToPDF` | Perfect (identical CDP call) | Persistent *"[Extension] is debugging this browser"* infobar; `debugger` is the heaviest permission there is; heavy Web Store scrutiny. **Defeats the whole point of reducing friction.** |
| **B.** Vendored jsPDF, real-text layout | Good; we control it | ~350 KB; layout written by hand |
| **C.** `window.print()` in a tab | Perfect | A print dialog per export |

**Recommendation: B, with C as an opt-in "print for exact fidelity" escape hatch.**

Why B is the right call and not a concession:

- jsPDF ships the 14 standard PDF fonts. Helvetica is metrically compatible with Arial — which
  is what the template already uses (`render.py:231`). **Zero font embedding**, tiny output,
  guaranteed-parseable text.
- Real `text()` calls produce genuine selectable text. No rasterization, so ATS parsers read it.
- **Page fit becomes arithmetic, not a retry loop.** `getTextWidth()` + `splitTextToSize()` let us
  compute exact height *before* drawing. Today's approach renders in Chromium, counts pages with
  pypdf, shrinks 5%, and re-renders — up to 4 times — then **deletes the output** if it still
  overflows (`render.py:244-280`). We replace that with a solved-for scale, and can binary-search
  the optimum.
- The standardized template is precisely what makes hand-rolled layout bounded work.

**This is gated behind a spike (Phase 0). If it fails, we re-plan before writing the port.**

### 3.2 PDF text extraction (input)

`pypdf.extract_text()` → **pdf.js**. Mature, extension-proven, ~1 MB with worker. Worker must be
a bundled file under MV3 CSP. The `MIN_EXTRACTABLE_WORDS = 20` scanned-PDF rejection
(`fallback_txt_pdf.py:42`) ports directly.

### 3.3 DOCX read

`python-docx` + lxml → **JSZip + DOMParser** over `word/document.xml`.

The template decision pays off here: we need only **text + coarse structure**, not the 11 style
scalars. Required XML subset is small and well-defined — `w:p`/`w:tbl` iteration for document
order, `w:t` for text, `w:numPr` *presence* for bullets, `w:b` for bold (feeds `_is_title_like`).
Everything else in `docx_ingest.py`'s extraction is deleted. The traversal logic itself is pure
logic, not native computation.

### 3.4 Service worker lifetime

Solved by the offscreen document (§2). No workaround needed.

---

## 4. Honest losses

| Loss | Severity | Notes |
|---|---|---|
| DOCX **output** | Accepted | The `docx` JS lib could restore it later — and since v4 already builds DOCX from a blank template, it'd be a clean re-implementation, not a fidelity fight. |
| Per-paragraph font/size/colour from source `.docx` | Accepted | See §1.1 — worth less than it sounds |
| Two-column / table resume layouts | Low | v4 already linearizes and reorders these badly |
| `/api/resumes/open` (open source resume in Word) | Low | Extensions cannot launch OS apps |
| Reading `~/.hirepilot/resume.docx` directly | One-time | User uploads once; the upload UI already exists (`popup/index.html:180`) |
| Transport-error granularity | Low | `fetch()` collapses DNS/refused/TLS into one opaque `TypeError`. HTTP-status classification — the bulk of it — is unaffected. |
| Ollama TCP preflight (`socket.create_connection`) | Low | Becomes `fetch()` + `AbortController`; cannot distinguish refused from timeout as cleanly |
| `qa_bank.yaml` | Trivial | Convert to JSON; drops the PyYAML dependency |

**API keys.** Move from plaintext `~/.hirepilot/.env` to plaintext `chrome.storage.local`. Not a
regression in kind — other extensions cannot read it; a local attacker can, exactly as before.
Stated plainly rather than dressed up: neither location is encrypted, and the current code has no
crypto anywhere either.

**Web Store review risk.** Four external LLM `host_permissions` plus broad content-script
injection for autofill will draw scrutiny. Needs a clear privacy policy and per-permission
justification. All code vendored (MV3 forbids remote code) — which we are doing regardless.

---

## 5. Port sizing

| Module | LOC | Portability |
|---|---|---|
| `llm.py` | 2,427 | ~1,500 portable; ~300 needs new mechanism; rest dead code |
| `fill_mapper.py` | 681 | Pure (except YAML read) |
| `tailor.py` | 518 | **Pure — zero file I/O.** Also the de-facto shared text-utils module: 5 modules import its privates (`_tokenize`, `_parse_llm_json`, `sanitize_text`). Extract these first. |
| `candidate_settings.py` | 509 | Pure logic + JSON persistence |
| `resume_profile.py` | 505 | Pure |
| `cover_letter.py` | 314 | Pure except the render call |
| `prompt_preferences.py` | 284 | Pure |
| `location_normalization.py` | 266 | Pure (`unicodedata.normalize` → native `String.normalize`) |
| `resume_analysis.py` | 236 | Pure |
| `fill_rules.py` | 209 | Pure |
| `answer_memory.py` | 206 | Pure logic + JSON |
| `profile.py` | 204 | Pure |
| `jd_cleanup.py` | 67 | Pure |
| `fill_contract.py` | 67 | Pure, zero imports |
| `docx_ingest.py` | 565 | ~250 lines of classification kept; style extraction deleted |
| `render.py` | 280 | ~150 lines HTML/CSS assembly → replaced by layout engine |

**≈ 6,000 lines Python → JS**, ~80% mechanical function-level translation.

**De-risking asset:** 594 existing backend tests, most covering pure logic. Port them as the
JS spec — `test_fill_rules` (28), `test_answer_memory` (20), `test_fill_mapper_v2` (19), etc.

### Regex dialect fixes (mechanical, but must be exhaustive)

| Python | JS | Sites |
|---|---|---|
| Inline `(?i)` — **invalid in JS** | `/i` flag | `resume_profile.py` ×11, `resume_analysis.py:26` |
| `re.fullmatch` | explicit `^…$` | `docx_ingest.py:234` |
| `(?P<name>…)` | `(?<name>…)` | `resume_profile.py:74-76` |
| `\w` under `re.UNICODE` | `\p{L}` + `u` flag | `resume_analysis.py:22` (CJK/accent behaviour depends on it) |
| `(?<!\d)` lookbehind | supported as-is (ES2018) | `resume_profile.py:61` |
| `str.casefold()` | `toLowerCase()` | ~20 sites; differs only for cases like `ß`→`ss` |

---

## 6. Phased plan

Sequencing principle: **front-load risk, then get a working vertical slice fast.** No long
horizontal porting phases before something runs end to end.

### Phase 0 — Spike (GO / NO-GO gate) · ~2 days
Prove the three library bets on **real resumes from `~/.hirepilot`**, nothing else:
1. Hardcoded `ResumeModel` JSON → one-page ATS-clean PDF via jsPDF → verify text round-trips
   through pdf.js extraction.
2. Real `.pdf` resume → pdf.js → text quality vs. today's pypdf output.
3. Real `.docx` resume → JSZip + DOMParser → text + bullet/heading classification.

**Do not proceed until all three pass.** If (1) fails, revisit §3.1 options A/C and re-plan.

### Phase 1 — Skeleton · ~1 day
Repo layout, MV3 manifest (`offscreen`, `unlimitedStorage`, host permissions), vendored+pinned
libs, `node:test` + Playwright harness, CI.

### Phase 2 — Vertical thin slice · ~1 week
The narrowest path that exercises the whole spine: **TXT resume in → one LLM call → standardized
PDF in Downloads.** Touches storage, LLM client, parse, layout, offscreen, and SW routing at
minimum depth. Everything after this is broadening, not architecture.

### Phase 3 — Shared utils + pure-logic core · ~1.5 weeks
Extract `tailor.py`'s shared text utilities first (5 modules depend on them). Then port
`tailor`, `resume_profile`, `resume_analysis`, `location_normalization`, `prompt_preferences`,
`candidate_settings`, `profile`, `jd_cleanup`, `cover_letter` validation — with their Python
tests as the spec. Runs entirely in `node:test`, no browser.

### Phase 4 — LLM client, full fidelity · ~1 week
Chain building, round-robin interleaving, per-model cooldowns, rate-limit reservation +
reconciliation, the 6-way failure taxonomy, Gemini compat→native 403 escalation, strict-JSON
degradation. `fetch` + `AbortController` for timeouts. Mock-fetch tests.

### Phase 5 — Input parsing · ~1 week
TXT → PDF (pdf.js) → DOCX (JSZip), feeding the ported classifier.

### Phase 6 — Output engine · ~1.5 weeks
Standardized template layout, deterministic page-fit solve, cover letter. De-risked by Phase 0.

### Phase 7 — Full pipeline + resumable jobs · ~1 week
The real 12-call orchestration, retry/judge loops, resumable job state, progress reporting.
Opportunity: today the entire multi-minute run reports one opaque stage,
`tailoring_resume` — we can finally report real progress.

### Phase 8 — UI · ~1 week
Lift popup + settings. Strip connection/recovery/version/keep-alive UI. Capability gates become
unconditional.

### Phase 9 — Autofill rewire · ~3 days
Lift `hp-*.js` unchanged. Port `fill_rules`/`fill_mapper`/`answer_memory`. **Delete** the HTTP
hop, capability probe, and provenance-binding machinery.

### Phase 10 — Hardening + Web Store · ~1 week
E2E on real Workday/Indeed, privacy policy, permission justifications, packaging.

**≈ 9–10 weeks solo.** Phases 3–6 are largely parallelizable if split across agents.

---

## 7. Open decisions

1. **Autofill in v1, or tailoring-only first?** Shipping tailoring alone gets to the Web Store
   sooner with far lighter permission review; autofill needs broad content-script access.
2. **Keep the v4 backend alive in parallel?** Recommended — it is committed, working, and the
   fallback if a library bet fails. Tailorune is an experiment until it demonstrably wins.
3. **Migration path for existing users** — importer for `~/.hirepilot/profile.json` +
   `qa_bank.yaml`, or a clean start?
