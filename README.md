# Tailorune

**Tailor your resume to a job posting, from inside Chrome. No account, no server.**

Read the job off the tab you are on, and get a rewritten resume and a matching cover letter —
as `.docx` and `.pdf`, named for the employer and the day — without the tool inventing a single
thing you did not do.

![Tailorune](store/screenshot-2-result.png)

### [→ Install from the Chrome Web Store](https://chromewebstore.google.com/detail/chnibpoikgjckekkgpoeejdnmempllkh)

Free. No account. Works anywhere Chrome does.

- **Privacy:** [PRIVACY.md](PRIVACY.md) · **Licence:** [MIT](LICENSE)
- Third-party notices ship inside the extension:
  [`extension/THIRD_PARTY_NOTICES.txt`](extension/THIRD_PARTY_NOTICES.txt)

---

## What it does

Paste or upload a resume (`.txt`, `.docx`, `.pdf`), press **Read job description** on a posting,
then **Tailor**. Four files land in Downloads:

```
Ada_Lovelace_Northwind_Resume_0906.docx
Ada_Lovelace_Northwind_Resume_0906.pdf
Ada_Lovelace_Northwind_Cover_0906.docx
Ada_Lovelace_Northwind_Cover_0906.pdf
```

Named that way because applicant tracking systems truncate long filenames, and because three
applications in an afternoon otherwise become `resume(1).docx` and `resume(2).docx`.

- **Lock a job** so the popup stops following your tabs while you compare postings.
- **It remembers what you already tailored for** and says so when you come back to a posting.

## Where your data goes

Saved **on your machine**: your resume library, your API keys, your preferences, and the list of
jobs you have tailored for. None of it is synced, and none of it reaches the developer — there is
no server to reach.

**Sent out:** your resume text and the job description go to the AI provider you chose (Gemini,
Groq, or OpenRouter), authenticated with your own key. That provider's privacy policy then
applies. That is the one thing that leaves your machine, and [PRIVACY.md](PRIVACY.md) says so in
full.

## Getting started

**1. [Install it](https://chromewebstore.google.com/detail/chnibpoikgjckekkgpoeejdnmempllkh).** That is the whole installation — no companion
app, no local server, nothing to configure on your machine.

**2. Get a free AI key.** This is the only fiddly step, and it takes about two
minutes. Tailorune has no server and no model of its own, so it uses yours:

| Provider | Get a key | Free tier |
|---|---|---|
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Yes — no card needed |
| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | Yes — no card needed. Very fast |
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) | Free models, shared pool, can be busy |

Any one is enough. Sign in, create a key, copy it. The same links are inside
the extension, under the gear.

**3. Paste the key into Tailorune.** Click the toolbar icon → the **gear** →
paste into **API key**. It is saved on your machine and never sent anywhere but
the provider it belongs to.

> Adding a second provider's key under *fallback keys* is worth the extra
> minute: free tiers rate-limit, and a run that hits a limit rotates to the next
> provider instead of failing.

**4. Add your resume.** **Upload** a `.txt`, `.docx` or `.pdf`, or paste the
text. Press **Save** to keep it in the library so you only ever do this once.

**5. Tailor.** Open a job posting, click Tailorune, press **Read job
description**, then **Tailor resume**. Four files land in Downloads.

### If something goes wrong

| What you see | What it means |
|---|---|
| "No key" in the header | No usable key yet. The gear, step 2 above |
| Read job description finds nothing | Some postings load their text late, or sit behind a login. Paste the description in by hand — it works exactly the same |
| "temporarily unavailable… retry in ~30s" | Your provider rate-limited you. Add a second provider's key so runs rotate instead of stalling |
| A run seems stuck | Runs take roughly 10–20 seconds. The popup closes if you click away, and the run keeps going — reopen it and the result will be there |

## Install from source

Only needed to develop it — installing from the store is the normal path.

```bash
npm install
npm run build      # bundles the offscreen engine + vendors pdf.js
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** →
pick `extension/`.

## Develop

```bash
npm run test:unit   # pure logic, no browser
npm run test:e2e    # real Chromium, real unpacked extension
npm test            # both
npm run package     # dist/tailorune-<version>.zip
```

LLM calls in e2e are answered by a local mock HTTP server rather than network interception —
`context.route()` does not intercept fetches made from an offscreen document, which is not
documented anywhere and cost an afternoon to discover. See
[`tests/e2e/mockLlmServer.mjs`](tests/e2e/mockLlmServer.mjs).

[`docs/STORE_SUBMISSION.md`](docs/STORE_SUBMISSION.md) has the permission justifications and the
pre-upload checklist.
