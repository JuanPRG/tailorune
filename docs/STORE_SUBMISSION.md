# Chrome Web Store submission

Everything the dashboard asks for, written out so it is answered the same way
every time. Each justification is the true reason the permission exists, traced
to the code that needs it — a reviewer who checks will find what this says.

**CONFIRMED: this is a same-item update.** Tailorune takes over the existing
previously published listing — same item ID, same store URL, same review
history. It is
not a new item.

Two things follow from that, and both have bitten people.

### The version must strictly increase, every upload

The packager refuses to build otherwise. It reads the live version from
`store/PUBLISHED_VERSION` (currently `2.2.5`); `--published <v>` overrides.
**Bump that file immediately after a successful upload.** It used to be a
hard-coded literal, which protected exactly one release — the moment 2.3.0 went
live, it would have happily packaged 2.3.0 over itself again.

### New host permissions disable the extension for existing users

Against the published 2.2.5, this build:

| | |
|---|---|
| **Adds** | `offscreen`, and three host permissions: `generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai` |
| **Removes** | `contextMenus`, and `http://127.0.0.1:7321/*` — the old Python backend |

`offscreen` carries no user-facing warning. **The host permissions do.** Chrome
shows "Read and change your data on…" and **disables the extension until each
existing user accepts**. Removing permissions is silent and safe; adding these
is not.

That is harmless at zero installs, which is the premise here — but it is worth
reading the dashboard's user count before publishing, because it cannot be
undone afterwards. If there ever are users, this is the update that interrupts
them.

### Also changing with the rebrand

Name, icons, description, and single purpose all change. The old listing
described a Python-backed product with autofill; Tailorune has neither. Rewrite
the store description and the privacy practices in the dashboard to match — a
same-item update inherits the old listing copy until you replace it.

---

## Store listing copy

A same-item update **inherits the old listing text until you replace it**,
and that text describes a Python-backed product with autofill. Replace all of
it. Paste these verbatim.

### Short description (132 char limit)

```
Tailor your resume and cover letter to a job posting, using your own AI provider key. No account, no server.
```

That is 108 characters, and identical to `manifest.json`'s `description` on
purpose — the two appear side by side and disagreeing reads as carelessness.

### Detailed description

Structured like the previous listing's, which passed review: what it does, features, the
user-control paragraph, the requirement, then the data-flow disclosure. Three
claims from the old copy are now FALSE and are gone — the Windows companion at
127.0.0.1, the local-model option (only three hosted providers are wired), and
autofill.

```
Tailorune adapts a resume and cover letter to the job posting you are viewing. Open Tailorune on a job page, read the posting into the form, review the detected details, and start tailoring. A tailored resume and cover letter are written to your Downloads as .docx and .pdf files.

Everything runs inside the extension. There is no companion application, no local server to install, and no operating-system restriction.

Features:

- Tailor a resume to the job posting in the active tab.
- Generate a resume and a cover letter, each as .docx and .pdf, in any combination.
- Save generated documents directly to Downloads, named for the employer and the date so several applications remain distinguishable.
- Keep a library of saved resumes, so a resume is uploaded once and reused.
- Lock a job so that switching browser tabs does not change it.
- See a notice on returning to a posting you have already tailored for.
- Optional accuracy review that flags rewrites drifting from your original wording. It is advisory and never edits or withholds a document.
- Read .txt, .docx, and .pdf resumes.

Tailorune does not fabricate experience. Your name, contact details, employers, job titles, dates, and education are treated as locked fields: they are copied through exactly as written and are never included in the part of the request the model may rewrite. Only your summary and the wording of your bullet points change.

Tailorune is user-controlled. It accesses the active tab only after you invoke the extension and press Read job description. It declares no content scripts and holds no standing access to any website. It does not read passwords, payment fields, authentication codes, government identifier fields, or file uploads. Review all generated text before submitting an application.

You provide your own API key for one of three supported providers: Google Gemini, Groq, or OpenRouter. Gemini and Groq offer free tiers that require no payment method. Provider availability, quotas, and pricing are controlled by each provider.

Your resume, your API keys, your preferences, and the list of jobs you have tailored for are stored locally in your browser. They are not synced and are never sent to the developer. There is no developer-operated server.

When you tailor, your resume text and the job description are sent directly from your browser to the AI provider you selected, authenticated with your own key. That provider's privacy policy then applies to that request. This is the only data that leaves your computer.

Resume tailoring and cover-letter generation are this extension's only functions.

Open source, MIT licensed: https://github.com/JuanPRG/tailorune
```

### Category and language

- **Category:** Productivity
- **Language:** English (United States)

### Support and homepage URLs

- Homepage: `https://github.com/JuanPRG/tailorune`
- Support: `https://github.com/JuanPRG/tailorune/issues`

---

## Single purpose

**AS SUBMITTED** (262 chars):

```
Tailorune rewrites a resume and drafts a cover letter for the job posting in the active tab, using an AI provider the user supplies their own API key for. Reading the posting, editing the job details, and downloading the two documents all serve that one purpose.
```

## Permission justifications

**AS SUBMITTED.** These are the exact strings that went into the dashboard, not
a paraphrase — paste them verbatim next time so the answers do not drift
release to release. Character counts are given so a truncated paste is
obvious.

**`storage`** (384)

```
Stores the user's resume library, their AI provider API keys, their tailoring preferences, the current job draft, and the most recent run's results on the user's own device via chrome.storage.local. This is what lets a resume be uploaded once and reused, and what restores a finished result after the popup closes. Nothing is synchronized to a Tailorune server; no such server exists.
```

**`downloads`** (269)

```
The extension's output is a tailored resume and cover letter, generated as .docx and .pdf files. This permission delivers those finished files to the user's Downloads folder. Downloads occur only after the user presses Tailor, and only in the formats the user selected.
```

**`offscreen`** (306) — new in 2.3.0, the previous release never had it, so the field
starts empty and the dashboard blocks publishing until it is filled

```
A tailoring run makes several sequential AI provider calls and then renders two documents, which together can exceed the five-minute per-event limit a Manifest V3 service worker is allowed. The offscreen document hosts that pipeline so a run is not terminated partway through. It renders no user interface.
```

**`activeTab`** (341)

```
Provides temporary access to the current tab, only after the user invokes Tailorune from its toolbar icon and presses Read job description. It is used once, to read the visible job-posting text so the user does not have to copy and paste it. Tailorune does not monitor tabs, does not run in the background, and collects no browsing activity.
```

**`scripting`** (296)

```
Injects the packaged job-posting reader into the active tab on demand, paired with activeTab, when the user presses Read job description. It is deliberately not declared as a content_scripts entry, so the extension has no persistent presence on any page. No remote code is downloaded or executed.
```

**Host permissions** (502) — the field that changed most. The old one justified
`127.0.0.1` and a Windows companion that no longer exists.

```
Three hosts, one per supported AI provider: generativelanguage.googleapis.com (Google Gemini), api.groq.com (Groq), and openrouter.ai (OpenRouter). Tailorune has no backend, so the extension calls the selected provider's chat endpoint directly from the user's browser, authenticated with the API key the user supplied for that provider. Only the provider the user selected is contacted. These permissions grant no access to job boards or any other website; reading a job posting uses activeTab instead.
```

## The dashboard will lie to you about unsaved edits

Publishing was blocked with three errors — a missing `offscreen` justification
that was visibly typed, and Homepage and Support URLs reported "not reachable"
that both returned HTTP 200 when checked directly.

None of it was true. **Every tab has its own Save Draft, and moving between
tabs discards unsaved edits.** The validator reads what is persisted, not what
is on screen, so unsaved work reports as missing or broken.

  - Save Draft on EACH tab before leaving it, not once at the end.
  - Click outside a field before saving; some inputs only commit on blur.
  - Reload and confirm the values survived before pressing Submit.
  - A trailing space from a paste — `.../tailorune ` — fails a reachability
    check while looking identical on screen.

## Remote code

**No.** Everything executed is in the package. pdf.js is vendored as a local
file, the bundles are built ahead of time, and there is no `eval`, no `new
Function`, and no remotely-loaded script anywhere in the extension.

## Data use disclosures

Tick these four, and no others:

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | **YES** | The resume carries the user's name, contact details and work history, and it is transmitted to the AI provider |
| Authentication information | **YES** | The user's own API key, stored locally and sent as the Authorization header on each provider call |
| **Website content** | **YES** | The job-posting **text is read from the page** and transmitted to the provider. This is the disclosure most easily missed, because it feels like the user typed it — they did not, the extension read it |
| Web history | **NO** | The tailoring history stores the URL, employer and title of postings the user *chose to tailor for*, on their device only. Chrome defines collection as transmitting off the device, and this never leaves it |
| Health, financial, personal communications, location, user activity | **NO** | — |

Web history is the one judgement call. The stored shape — a page URL plus a
title plus a timestamp — resembles the category's wording. It is answered NO
because it is never transmitted, and the privacy policy describes it plainly
anyway, so nothing is hidden either way.

Certifications — all three are true:

- Not sold or transferred to third parties outside approved use cases.
- Not used or transferred for any purpose unrelated to the single purpose above.
- Not used or transferred to determine creditworthiness or for lending.

## Privacy policy URL

`PRIVACY.md` at the repository root is the source text. It needs a **public
URL** before submission — GitHub renders it at:

`https://github.com/JuanPRG/tailorune/blob/main/PRIVACY.md`

That is acceptable to the store. A GitHub Pages URL is tidier if preferred.

## Listing assets

| Asset | Required | State |
|---|---|---|
| Store icon 128x128 | Yes | `extension/icons/icon128.png` |
| Screenshot 1280x800 or 640x400 | **Yes, at least one** | `store/screenshot-*.png`, generated by `npm run assets:store` |
| Small promo tile 440x280 | Optional | `store/promo-tile-440x280.png` |
| Marquee 1400x560 | Optional | `store/marquee-1400x560.png` |

All are produced at **exact** pixel dimensions. They were previously rendered at
`deviceScaleFactor: 2`, i.e. at double the size their own filenames promised,
which the store rejects.

## Before every upload

1. `npm test` — must be fully green.
2. `npm run package` — refuses (exit 1) on a stale version, a missing bundle, or
   a provider whose host is absent from `host_permissions`.
3. Upload `dist/tailorune-<version>.zip`.
4. **Bump `store/PUBLISHED_VERSION` to what you just uploaded.** Nothing else
   knows the upload happened.

Check the zip is newer than your last commit. A stale zip once contained a
build predating three shipped features.
