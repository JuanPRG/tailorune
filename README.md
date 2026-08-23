# Tailorune

Resume tailoring, as a **standalone Chrome extension** — no backend to install.

## Status

**Working vertical slice.** Paste or upload a resume (`.txt`, `.docx`, or `.pdf`) and a job
description, and it produces a tailored `.docx` (auto-downloaded) plus an HTML preview you can
print to PDF from the browser — entirely inside the extension, with one LLM call.

**Scope for this build: tailoring + resume only.** Autofill and cover letters are explicitly out
of scope for now (see `docs/MIGRATION_PLAN.md` §7). This repo is a standalone experiment — it does
not run alongside [HirePilot v4](https://github.com/JuanPRG/hirepilot) (the working Python-backed
product) and does not migrate any of its user data. Real resumes from that product are used here
only as test fixtures.

See [`docs/STATUS.md`](docs/STATUS.md) for exactly what's implemented, what's simplified from v4
on purpose, and current test coverage.

## Why

HirePilot v4 ships a **490 MB installer** — 101 MB of which is Playwright, bundled solely to
render a PDF via headless Chromium. The extension already runs inside Chrome. Tailorune is this
extension without the backend: ~3 MB, no local server, no port conflicts.

## Run it

```bash
npm install
npm run build      # bundles the offscreen engine + vendors pdf.js
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` directory.

Click the toolbar icon, paste a resume and a job description (or upload a `.docx`/`.pdf`/`.txt`
file), pick a provider, enter an API key, and click **Tailor resume**. The key is stored in
`chrome.storage.local` on your machine only — see `docs/MIGRATION_PLAN.md` §4 for what that
means and doesn't mean.

## Test it

```bash
npm run test:unit   # pure logic, no browser — parser, LLM client, word budget, HTML/DOCX render
npm run test:e2e     # real Chromium, real unpacked extension, real chrome.downloads calls
npm test             # both
```

The e2e suite answers LLM calls with a local mock HTTP server rather than network interception —
see `tests/e2e/helpers.mjs` for why `context.route()` doesn't work for this.

## Read next

- [`docs/STATUS.md`](docs/STATUS.md) — what's actually built, against the plan below.
- [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) — the architecture decisions, honest losses,
  and phased plan, with every claim backed by a measurement.
- [`docs/SPIKE_FINDINGS.md`](docs/SPIKE_FINDINGS.md) — the underlying measurements themselves
  (Unicode fidelity across PDF generators, MV3 CSP compatibility, print-dialog behavior, ATS
  vendor documentation).
