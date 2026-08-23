# Tailorune — Backend Elimination Plan

Porting HirePilot v4 (Python backend + Chrome extension) to a **standalone Chrome extension**.

Motivation: user feedback that a backend install deters adoption. Today's install is a **490 MB
installer** — 101 MB of it Playwright, bundled solely to render a PDF — for a tool that runs
inside Chrome.

**Every architectural choice below is backed by a measured result in
[`SPIKE_FINDINGS.md`](SPIKE_FINDINGS.md).** Where something is unverified, it says so.

---

## 1. What the codebase analysis found

Four parallel deep-dives over `backend/hirepilot_v4/` (11,077 LOC) and `extension/` (6,919 LOC).

### 1.1 The compromises are mostly already made

Three "sacrifices" this migration appears to require already exist in the shipped product:

| Assumed sacrifice | Reality in v4 today |
|---|---|
| "Lose formatting preservation" | DOCX output already builds from a blank template (`docx_export.py:94`) and deliberately discards the source's `docDefaults` (`:117-120`), with a documented rationale. |
| "Standardize on one template" | Already exists and is tested: `fallback_txt_pdf.py` normalizes every `.txt`/`.pdf` input to a house template (`_GENERIC_STYLE_KWARGS:158-173`). |
| "DOCX fidelity will be missed" | What survives is **11 scalar properties per paragraph**, unreliably: `python-docx` returns `None` when formatting comes from a style rather than a direct override, so styled headings yield `bold=None` (`docx_ingest.py:212-228`). |

v4 also overrides source fidelity deliberately elsewhere: margins clamped (`docx_ingest.py:336-364`,
whose comment calls it *an explicit override of preserve-original-formatting-exactly*), the
section-rule colour invented (`render.py:182-186`), tables linearized and reordered widest-cell-first
(`:405-406`), and the compaction loop shrinking all fonts and spacing by up to 15% (`render.py:202`).

**"Standardized template only" is therefore a simplification, not a downgrade** — it promotes an
already-tested path and deletes `docx_export.py`, all of `docx_ingest.py`'s style extraction, and
`render.py`'s `_style_to_css`.

### 1.2 The backend is mostly pure logic

| Property | Finding |
|---|---|
| Tokenizer | **None** — `ceil(chars/3.3) + 6 x msgs` |
| Async | **None** — zero asyncio; all LLM calls synchronous |
| Streaming | **None** — plain POST plus `resp.json()` |
| Prompts | Plain f-strings; no templating engine |
| Section detection | **100% regex/heuristic, zero LLM** |
| Autofill mapper | Pure regex and dict matching, **zero Python-only regex features** |
| HTTP surface | Five `httpx` calls total |

### 1.3 Storage is a non-issue

Measured: **~150 KB** of config and state across 8 resumes; ~1 MB saturated, against
`chrome.storage.local`'s 10 MB. Full resume *text* is never stored — it is re-extracted on demand
(`resume_library.py:274-275`). Only the ~20 KB binary persists, which goes to IndexedDB.

### 1.4 ~1,400 lines of plumbing evaporate

`server.py` (1,210) · `tray.py` (551) · `updater.py` (385) · `diagnostics.py` (223) ·
`launcher.py` (201) · `setup_health.py` (49) · `render.py`'s Playwright thread/queue worker (~130).

Plus, extension-side: the connection dot and 2 s ping loop, the recovery panel, the
`hirepilot://start` protocol handler, companion-startup polling, the version-compat notice, and the
keep-alive hack.

Plus the **download handoff dance** — the backend writes a PDF, the extension fetches it back via
`/open?path=...&handoff=1`, and the backend *moves* it first to dodge a Playwright file-handle race
(`server.py:604-630`). This becomes `new Blob()` then `chrome.downloads.download()`.

Plus the **`/api/fill` hop** and everything guarding it: the per-Fill capability probe
(`background.js:934-950`), contract negotiation, and a 5-tuple provenance binding re-checked at four
points (`:763-792`, `:1011-1085`). In-process, that is a function call.

### 1.5 The extension already does half the job

Zero-backend today and surviving untouched: **JD extraction** (3 tiers plus an Indeed adapter,
`content.js:221-378`), the **entire autofill stack** (1,103 lines — accessible-name computation, 12
control kinds, portaled Workday listboxes, hierarchical multi-select with backtracking, post-write
verification), **sensitive-field redaction**, the session state machine, and **~765 lines of HTML
plus ~2,827 lines of CSS**.

---

## 2. Verified platform findings

Full detail and method in [`SPIKE_FINDINGS.md`](SPIKE_FINDINGS.md).

| Question | Result |
|---|---|
| MV3 service worker lifetime | 30 s idle, **5 min max per event** — too short for a 12-call run |
| Offscreen document lifetime | **Unlimited** — the engine goes here |
| CORS from extension pages | **Bypassed** for `host_permissions` hosts, and rate-limit headers stay readable |
| Current v4 output | **57/57** untagged `Skia/PDF`, one page, clean extraction |
| `window.print()` fidelity | **Same renderer.** `page.pdf()` is CDP `Page.printToPDF` is Chrome print-to-PDF |
| `@page` CSS margins | **Honored** — confirmed in the real print dialog (Margins=Default, 2 sheets, 44 lines on page 1, matching headless exactly) |
| Chrome print headers/footers | **ON by default**, injects date + title + URL + page number. **Not CSS-suppressible** |
| Chrome print background graphics | **OFF by default** — template must not rely on fills |
| `docx` lib under MV3 CSP | **Passes**, 0 violations, 8.6 KB output |
| pdf.js under MV3 CSP | **Passes**, 0 violations, **no `wasm-unsafe-eval` needed** |
| jsPDF | **Rejected** — see below |
| DOCX one-page budget | **~570-600 words** (571 fits one page, 649 spills to two) |

### Why jsPDF was rejected

jsPDF with standard fonts **corrupts accented characters**. The glyphs render, but any line
containing one extracts letter-spaced:

```
Input:  José García / Müller / François / Łukasz
Out:    J o s é   G a r c í a  /  M ü l l e r  ...     <- "José" is not a findable token
        Łukasz -> Aukasz                               <- silent data corruption
```

For a resume tool, where the candidate's own name is the most important string in the document,
this is disqualifying. Fixing it requires embedding a Unicode TTF, which adds bundle weight and its
own verification burden. Chromium and the `docx` library both get this right for free.

### What ATS vendors actually document

| Source | Accepted | Stated preference |
|---|---|---|
| Greenhouse | `.doc .docx .pdf .rtf .txt` | **None** |
| Workday | not enumerated | **None.** Only guidance: use resumes without images or image-based styles |
| Textkernel (engine behind many ATS) | 70+ formats | **None — explicitly no ranking** |

No primary source distinguishes PDF from DOCX for parsing accuracy, and none mentions PDF tagging.
The common "use .docx for ATS" advice is unsupported by every vendor doc checked — **an earlier
claim in this plan asserting DOCX parses better was wrong and is retracted.** The risks vendors
actually flag are image-based content and reading order, neither of which is a container-format
choice.

---

## 3. Target architecture

```
INPUT    .txt  ·  .pdf (pdf.js)  ·  .docx (JSZip + DOMParser)
              |
              v
         ResumeModel  - structured; locked fields (name, titles, dates, employers,
              |         education) held separate from editable fields (summary,
              |         bullets, skills)
              v
LLM      editable fields + JD  ->  JSON      (locked fields never enter the prompt)
              |
              v
VALIDATE anti-fabrication checks · word budget <= ~570
              |
              v
RENDER   one content model, two exits
         |-- HTML template  ->  in-extension preview  ->  browser print -> PDF
         `-- docx library   ->  Blob  ->  chrome.downloads         <- primary
```

**No PDF library. No hand-rolled layout engine.**

```
tailorune/
├─ manifest.json          MV3 · offscreen · unlimitedStorage · 4 LLM hosts + localhost
├─ src/
│  ├─ sw/                 service worker: routing, tab events, downloads
│  ├─ engine/             <- OFFSCREEN DOCUMENT (unlimited lifetime)
│  │  ├─ llm/             chain, rotation, cooldown, rate limit
│  │  ├─ pipeline/        tailor · cover-letter · jd-cleanup
│  │  ├─ parse/           pdf.js · docx-in (JSZip) · txt -> ResumeModel
│  │  ├─ profile/         resume_profile + resume_analysis ports
│  │  ├─ render/          HTML template + docx-out
│  │  └─ store/           chrome.storage.local + IndexedDB
│  ├─ fill/               fill_rules · fill_mapper · answer_memory ports
│  ├─ page/               hp-accname · hp-ats · hp-scan · hp-fill  (lifted as-is)
│  ├─ ui/                 popup · settings  (lifted, connection UI stripped)
│  └─ shared/             text utils, regex-ported helpers
└─ vendor/                pdf.js · docx · jszip  (pinned, local)
```

**Why offscreen:** the worst case is 12 sequential LLM calls at up to 45 s each, past the 5-minute
event ceiling. Job state persists to `chrome.storage.session` between calls so a memory-pressure
reclaim resumes rather than losing the run. This is better than today, where `_TAILOR_JOBS` is an
in-memory dict (`server.py:155`) lost on every backend restart.

**One-page control** becomes a **word budget (~570)** enforced at generation and re-checked before
export. That replaces v4's render-count-shrink-retry loop, which could burn four Chromium renders
and then *delete the output* (`render.py:244-280`).

**Bundle budget:** pdf.js 448 KB plus its 1.3 MB worker, and `docx` at 349 KB — about **2.1 MB
vendored**, roughly 3 MB total. Against 490 MB that is a ~160x reduction. pdf.js is the largest
dependency and only loads when a PDF is actually imported.

---

## 4. Honest losses

| Loss | Severity | Note |
|---|---|---|
| Silent PDF auto-download | Medium | PDF needs the print dialog; DOCX auto-downloads. |
| **Print headers/footers** | **Medium** | Chrome injects date, title, URL and page number by default, and CSS cannot suppress it. The user must uncheck "Headers and footers" once. No programmatic fix exists, which is why DOCX is primary rather than co-equal. |
| Per-paragraph font/size/colour from source | Accepted | See §1.1 |
| Two-column and table layouts | Low | v4 already linearizes and reorders these badly |
| `/api/resumes/open` (open in Word) | Low | Extensions cannot launch OS apps |
| Reading `~/.hirepilot/resume.docx` | One-time | User uploads once; the UI already exists |
| Transport-error granularity | Low | `fetch()` collapses DNS, refused and TLS into one `TypeError`; HTTP-status classification is unaffected |
| Ollama TCP preflight | Low | Becomes `fetch()` plus `AbortController` |
| `qa_bank.yaml` | Trivial | Convert to JSON; drops PyYAML |

**API keys** move from a plaintext `.env` to plaintext `chrome.storage.local`. Not a regression in
kind — other extensions cannot read it, a local attacker can, exactly as before. Neither location
was ever encrypted.

**Residual unverified risk:** a user who deliberately sets print margins to None or Custom can break
a fitted layout on the optional PDF path. Not testable headlessly, and it is user intent rather than
a defect.

**Web Store review:** four external LLM `host_permissions` plus broad content-script injection will
draw scrutiny. This needs a privacy policy and per-permission justification. All code is vendored
anyway, since MV3 forbids remote code.

---

## 5. Port sizing

| Module | LOC | Portability |
|---|---|---|
| `llm.py` | 2,427 | ~1,500 portable; ~300 needs a new mechanism; the rest is dead code |
| `fill_mapper.py` | 681 | Pure, except the YAML read |
| `tailor.py` | 518 | **Pure — zero file I/O.** Also the de-facto shared text-utils module: five modules import its privates. Extract it first. |
| `candidate_settings.py` | 509 | Pure plus JSON persistence |
| `resume_profile.py` | 505 | Pure |
| `cover_letter.py` | 314 | Pure except the render call |
| `prompt_preferences.py` | 284 | Pure |
| `location_normalization.py` | 266 | Pure (`unicodedata.normalize` maps to native `String.normalize`) |
| `resume_analysis.py` | 236 | Pure |
| `fill_rules.py` | 209 | Pure |
| `answer_memory.py` | 206 | Pure plus JSON |
| `profile.py` | 204 | Pure |
| `jd_cleanup.py` + `fill_contract.py` | 134 | Pure |
| `docx_ingest.py` | 565 | ~250 lines of classification kept; style extraction deleted |
| `render.py` | 280 | ~150 lines become the HTML template and docx builder |

**About 6,000 lines of Python to JS**, roughly 80% mechanical. The **594 existing backend tests**
port as the specification.

### Regex dialect fixes

| Python | JS | Sites |
|---|---|---|
| Inline `(?i)` — **invalid in JS** | `/i` flag | `resume_profile.py` x11, `resume_analysis.py:26` |
| `re.fullmatch` | explicit `^...$` | `docx_ingest.py:234` |
| `(?P<name>...)` | `(?<name>...)` | `resume_profile.py:74-76` |
| `\w` under `re.UNICODE` | `\p{L}` with the `u` flag | `resume_analysis.py:22` (CJK behaviour depends on it) |
| `(?<!\d)` lookbehind | supported as-is | `resume_profile.py:61` |
| `str.casefold()` | `toLowerCase()` | ~20 sites |

---

## 6. Phases

Phase 0 is **complete** — see [`SPIKE_FINDINGS.md`](SPIKE_FINDINGS.md). The library bets are settled,
which is what shortens everything after it.

| # | Phase | Detail | Est. |
|---|---|---|---|
| 0 | ~~Spike~~ | **Done.** jsPDF rejected; `docx` and pdf.js verified under MV3 CSP; word budget measured | — |
| 1 | Skeleton | Repo layout, MV3 manifest, vendored and pinned libs, `node:test` plus Playwright harness, CI | 2-3 d |
| 2 | Vertical slice | TXT in, one LLM call, DOCX in Downloads. Exercises storage, LLM, parse, render, offscreen and SW routing at minimum depth. Everything after this is broadening, not architecture. | 1 wk |
| 3 | Pure-logic core | Extract `tailor.py`'s shared utils first (five modules need them), then the pure modules with their Python tests as spec. No browser required. | 1.5 wk |
| 4 | LLM client | Chain interleaving, per-model cooldowns, rate-limit reservation and reconciliation, the 6-way failure taxonomy, Gemini 403 escalation, strict-JSON degradation. `fetch` plus `AbortController`. | 1 wk |
| 5 | Input parsing | pdf.js (with item-spacing handling) and DOCX via JSZip, feeding the ported classifier | 4 d |
| 6 | Output | HTML template (no background fills, since they do not print by default), preview, print CSS, and a one-time "uncheck Headers and footers" hint in the print affordance; DOCX builder; word-budget enforcement; cover letter | 4 d |
| 7 | Pipeline | Real orchestration, retry and judge loops, resumable job state, and **real progress reporting** — today the entire multi-minute run reports one opaque stage | 1 wk |
| 8 | UI | Lift popup and settings; strip connection, recovery and version surfaces; capability gates become unconditional | 1 wk |
| 9 | Autofill rewire | Lift `hp-*.js` unchanged, port the mapper, delete the HTTP hop and its guard machinery | 3 d |
| 10 | Hardening | End-to-end on real Workday and Indeed, privacy policy, permission justifications, packaging | 1 wk |

**About 6.5-7 weeks solo**, down from 9-10: Phase 0 is done, and Phase 6 shrank from 1.5 weeks to
4 days now that there is no layout engine. Phases 3 through 6 parallelize across agents.

---

## 7. Open decisions

1. **Autofill in v1, or tailoring first?** Tailoring alone reaches the Web Store sooner and with far
   lighter permission review; autofill needs broad content-script access.
2. **Keep v4 running in parallel?** Recommended — it works, and it is the fallback. Tailorune is an
   experiment until it demonstrably wins.
3. **Migrate existing users** with an importer for `profile.json` and `qa_bank.yaml`, or clean start?
