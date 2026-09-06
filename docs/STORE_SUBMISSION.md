# Chrome Web Store submission

Everything the dashboard asks for, written out so it is answered the same way
every time. Each justification is the true reason the permission exists, traced
to the code that needs it — a reviewer who checks will find what this says.

**CONFIRMED: this is a same-item update.** Tailorune takes over the existing
HirePilot listing — same item ID, same store URL, same review history. It is
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

Name, icons, description, and single purpose all change. HirePilot's listing
described a Python-backed product with autofill; Tailorune has neither. Rewrite
the store description and the privacy practices in the dashboard to match — a
same-item update inherits the old listing copy until you replace it.

---

## Single purpose

> Tailorune rewrites a resume and drafts a cover letter for one specific job
> posting, using an AI provider the user supplies their own API key for.

Everything in the extension serves that: reading the posting, editing the
resume, and downloading the two documents.

## Permission justifications

Paste these into the matching fields.

**`storage`**
> Saves the user's resume library, their AI provider API keys, and their
> tailoring preferences on their own device, so they are not re-entered for
> every application. Nothing is synced or transmitted.

**`downloads`**
> The extension's output is a tailored resume and cover letter as .docx and
> .pdf files. This permission delivers those finished files to the user's
> Downloads folder.

**`offscreen`**
> A tailoring run makes several sequential AI calls and then renders two
> documents, which can exceed the 5-minute per-event ceiling a service worker
> is allowed. The offscreen document hosts that pipeline so a run is not killed
> partway through.

**`activeTab`**
> Reads the job posting from the tab the user is looking at, and only after
> they click the Tailorune toolbar icon. This grants access to that one tab, at
> that one moment. The extension declares no content scripts and holds no
> standing access to any site.

**`scripting`**
> Injects the job-posting reader into that single tab on demand, paired with
> activeTab. It is deliberately not declared as a `content_scripts` entry,
> precisely so the extension has no persistent presence on any page.

**Host permissions — `generativelanguage.googleapis.com`, `api.groq.com`,
`openrouter.ai`**
> The three AI providers the user can choose between. The extension calls their
> chat endpoints directly from the user's browser with the user's own API key.
> There is no backend, so these are the only servers involved, and no other
> host can be contacted.

## Remote code

**No.** Everything executed is in the package. pdf.js is vendored as a local
file, the bundles are built ahead of time, and there is no `eval`, no `new
Function`, and no remotely-loaded script anywhere in the extension.

## Data use disclosures

Tick these, and no others:

| Category | Collected | Why |
|---|---|---|
| Personally identifiable information | **Yes** | The resume the user supplies contains their name, contact details and work history |
| Authentication information | **Yes** | The user's own AI provider API keys, stored locally |
| Web history | **No** | The job history stores the URLs of postings the user *chose to tailor for*, on their device only. It is not browsing history and is never transmitted |
| Location, health, financial, personal communications, user activity | **No** | — |

Certifications — all three are true:

- Not sold or transferred to third parties outside approved use cases.
- Not used or transferred for any purpose unrelated to the single purpose above.
- Not used or transferred to determine creditworthiness or for lending.

**The one thing to state plainly:** resume text and the job description are
transmitted to the AI provider the user selects, using the user's own key. That
is the product working as described, not a hidden transfer — but it must appear
in the privacy policy, and it does.

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
