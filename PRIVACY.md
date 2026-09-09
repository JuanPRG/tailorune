# Tailorune — Privacy Policy

**Last updated: 6 September 2026**

Tailorune is a Chrome extension that tailors your resume and writes cover
letters. It has no server. There is no account, no sign-in, and no analytics.

This policy describes exactly what the extension stores, where it stores it,
and the one place your data is sent.

---

## The short version

- Everything Tailorune saves is saved **on your own computer**, in Chrome's
  local extension storage. It is never synced to your Google account and it is
  never sent to the developer.
- To tailor anything, your **resume text and the job description are sent to
  the AI provider you chose**, using the API key you supplied. That provider's
  own privacy policy then applies to that data.
- The developer of Tailorune operates no server and receives no data from you
  of any kind.

---

## What Tailorune stores on your device

All of the following lives in `chrome.storage.local`, which is private to this
extension on this browser profile. It is not encrypted; anyone with access to
your computer and your Chrome profile can read it, in the same way they could
read a `.env` file or a password stored in your browser.

| What | Why | Limit |
|---|---|---|
| Your **resume text** — which normally contains your name, contact details, work history and education | So you do not re-enter it for every application | Up to 20 saved resumes |
| Your **LLM API keys** — one per supported provider, for however many you choose to fill in | So a run can authenticate without asking each time, and can rotate to another provider when one rate-limits | Stored in plain text |
| Your **tailoring preferences** — density, tone, letter length, and any free-text notes or "points to preserve" | So runs behave consistently | — |
| A **history of jobs you have tailored for** — employer, job title, page URL, when, and how many times | So the extension can tell you when you return to a posting you already worked on | Up to 100 entries. The job description and the generated documents are deliberately **not** kept |
| Your **most recent run** — the job title, employer, the job description it used, the page URL, the names of the files produced, and the review findings | So closing and reopening the popup does not lose your result | The most recent run only |
| An **in-progress job description draft** | So losing focus mid-paste does not lose your work | — |

Tailorune does not store the generated resume or cover letter. Those are
written straight to your Downloads folder and the extension keeps only their
filenames.

## What is sent off your device, and to whom

To tailor a resume, Tailorune sends a request containing **your resume text,
the job description, and any preferences or notes you entered** to the AI
provider you selected, authenticated with your own API key.

That request goes to exactly one of these, and nowhere else:

| Provider | Endpoint | Their privacy policy |
|---|---|---|
| Google (Gemini) | `generativelanguage.googleapis.com` | https://policies.google.com/privacy |
| Groq | `api.groq.com` | https://groq.com/privacy-policy/ |
| OpenRouter | `openrouter.ai` | https://openrouter.ai/privacy |

These three are the only hosts the extension is permitted to contact; the
permission is declared in the extension's manifest and enforced by Chrome.

**Once your data reaches a provider, that provider's terms govern it.** Some
providers retain prompts, and some use them to improve their models. Read the
policy of whichever one you use — Tailorune cannot control what they do with a
request you authorised with your own key.

Tailorune sends **no** telemetry, analytics, crash reports, or usage data
anywhere. There is no third-party SDK in the extension.

## Reading the job posting

When you press **Read job description**, Tailorune reads the text of the job
posting from the tab you are currently on. It does this using Chrome's
`activeTab` permission, which Chrome grants for a single tab and only because
you clicked Tailorune's own toolbar button. Tailorune has no standing access to
any website, declares no content scripts, and cannot read pages in the
background or when you are not using it.

The text it reads is put into the job description box for you to review. It is
sent to your AI provider only if you then press Tailor.

## Removing your data

- **Clear tailoring history** — in Settings, removes the record of which jobs
  you have tailored for.
- **Reset** — clears the current job and the stored last run.
- **Delete** — removes a saved resume from your library, one at a time.
- Clearing a key field and letting it save removes that key.
- **Uninstalling Tailorune deletes everything above**, permanently. Chrome
  removes an extension's local storage when the extension is removed.

## What Tailorune does not do

- It does not sell or transfer your data to anyone. There is nobody to sell it
  to; no data reaches the developer.
- It does not use your data for advertising, credit assessment, or lending.
- It does not transfer your data for any purpose unrelated to tailoring your
  resume.

## Children

Tailorune is a tool for job applicants and is not directed at children under 13.

## Changes

If this policy changes, the "last updated" date above changes with it, and the
revision history is public in the extension's repository.

## Contact

Tailorune is open source: https://github.com/JuanPRG/tailorune

Questions or concerns about privacy can be raised as an issue on that
repository.
