# Tailorune

Resume tailoring and cover letters, as a **standalone Chrome extension** — no account, no server.

Point it at a job posting, and it rewrites your resume against that posting and drafts a matching
cover letter. Everything runs from the extension, using an AI provider key you supply yourself.

- **Privacy:** [PRIVACY.md](PRIVACY.md)
- **Licence:** [MIT](LICENSE). Third-party notices ship with the extension in
  [`extension/THIRD_PARTY_NOTICES.txt`](extension/THIRD_PARTY_NOTICES.txt).

## What it does

Paste or upload a resume (`.txt`, `.docx`, `.pdf`), read the job description straight off the tab
you are on, and press Tailor. You get four files in Downloads — a tailored resume and a cover
letter, each as `.docx` and `.pdf` — named for the employer and the day
(`Ada_Lovelace_Northwind_Resume_0906.docx`) so several applications in an afternoon stay apart.

- **It does not invent things.** Your name, contact details, employers, titles, dates and
  education are locked and copied through verbatim; only the summary and bullet wording are
  rewritten. There is an optional accuracy review that flags rewrites drifting from your original
  wording — advisory only, it never changes or withholds a document.
- **Lock a job** to stop the popup following your tabs while you compare postings.
- **It remembers what you have already tailored for**, so returning to a posting says so.

**Autofill is deliberately out of scope**, which is why this extension declares no content scripts
and no broad host access. It reads a posting only from the tab you are on, only when you click its
toolbar icon.

## Where your data goes

Saved locally, on your machine: your resume library, your API keys, your preferences, and the list
of jobs you have tailored for. None of it is synced or sent to the developer — there is no server
to send it to.

**Sent out:** to tailor anything, your resume text and the job description go to the AI provider
you chose (Gemini, Groq, or OpenRouter), authenticated with your own key. That provider's privacy
policy then applies. This is the one thing that leaves your machine, and
[PRIVACY.md](PRIVACY.md) says so in full.

## Install

From the Chrome Web Store — or from source:

```bash
npm install
npm run build      # bundles the offscreen engine + vendors pdf.js
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select the `extension/` directory.

Click the toolbar icon, add your resume, add an API key under the gear, and press **Tailor
resume**. Gemini and Groq both have free tiers that need no card.

## Test it

```bash
npm run test:unit   # pure logic, no browser — parser, LLM client, word budget, render, cover letter
npm run test:e2e    # real Chromium, real unpacked extension, real chrome.downloads calls
npm test            # both
```

The e2e suite answers LLM calls with a local mock HTTP server rather than network interception —
see `tests/e2e/mockLlmServer.mjs` for why `context.route()` does not work for this. It runs one
file at a time on purpose: these tests drive real browser-action popups, which are destroyed on
focus loss, so parallel browsers kill each other's popups.

## Release

```bash
npm run assets:store   # promo tiles + listing screenshots, at exact store dimensions
npm run package        # dist/tailorune-<version>.zip
```

[`docs/STORE_SUBMISSION.md`](docs/STORE_SUBMISSION.md) has the permission justifications, the data
disclosures, and the pre-upload checklist. The packager refuses to build on a stale version, a
missing bundle, or a provider whose host is absent from `host_permissions`.

## Internal notes

The files below are engineering scratch, not user documentation. They record how decisions were
reached and are **not kept in sync with the shipped product** — the code and its comments are the
source of truth.

- [`docs/STATUS.md`](docs/STATUS.md) — what was built, against the plan.
- [`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) — architecture decisions and honest losses.
- [`docs/SPIKE_FINDINGS.md`](docs/SPIKE_FINDINGS.md) — the measurements behind them (Unicode
  fidelity across PDF generators, MV3 CSP compatibility, ATS vendor documentation).
