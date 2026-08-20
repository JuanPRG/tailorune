# Tailorune

Resume tailoring, cover letters, and ATS autofill — as a **standalone Chrome extension**, with
no backend to install.

## Status

**Experiment / pre-implementation.** This repo currently holds the migration analysis and plan.
No engine code has been written yet — the first milestone is a go/no-go spike.

The working product today is [HirePilot v4](https://github.com/JuanPRG/hirepilot) (Python backend
+ Chrome extension). Tailorune is an experiment to determine whether the backend can be removed
entirely.

## Why

HirePilot v4 ships a **490 MB installer** — 101 MB of which is Playwright, bundled solely to
render a PDF via headless Chromium. The extension already runs inside Chrome. User feedback was
that a backend install deters adoption, which the install size makes hard to argue with.

Target: a ~5 MB Web Store extension. One click, cross-platform, auto-updating, no local server,
no port conflicts, no antivirus false positives.

## Deliberate compromises

- **One standardized resume template.** Original formatting is not preserved. (Less of a change
  than it sounds — see the plan; v4's DOCX output already builds from a blank template.)
- **Aggressive tailoring**, preserving education and job titles verbatim.
- **PDF output** as the primary format. TXT and PDF accepted as input, plus DOCX text extraction.
- **No DOCX output** initially.

## Read next

[`docs/MIGRATION_PLAN.md`](docs/MIGRATION_PLAN.md) — full analysis of the v4 codebase, target
architecture, the four hard problems, honest losses, port sizing, and an 11-phase plan.
