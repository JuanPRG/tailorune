# Tailorune Agent API — Plan

A way for an AI agent (Meta Muse) to tailor a resume through Tailorune **in one tool call**:
your provider keys do the writing on free tiers, and the agent's own model and token meter stay
out of it.

Status: **plan only, nothing built.** Drafted 2026-10-16.

---

## 0. Assumption to confirm first

**"muse.ai" is read here as Meta Muse, the agent.** muse.ai itself is a video-hosting site with no
agent that would call your API. If you meant something else, §3 (how the agent connects) changes,
and the rest of the plan stays the same.

What the public write-ups say about Muse (vendor blogs written right after launch, which disagree in
places, so M0 checks them for real):

- Muse runs in **Meta's cloud on its own Linux VM**. Anything it calls must be on a **public HTTPS
  URL**. A server on `localhost` cannot be reached.
- It can integrate three ways:
  1. **REST API.** It reads an OpenAPI doc and writes its own client. Auth is an API-key or Bearer header.
  2. **Remote MCP server** over streamable HTTP. Some guides say this needs OAuth sign-in; others
     say Bearer works.
  3. **CLI.** It can `npm install` a package on its VM and run it.
- Keys belong in Muse's **Secure Credentials Store**, never pasted into chat. Reportedly the agent
  only ever holds a stand-in token, and the real one is inserted at the network edge.
- Meta does not review custom connectors, so whatever you expose is trusted as-is.

---

## 1. What the codebase already gives us

The work is smaller than it sounds. **The engine is already portable.**

- `extension/engine/*` is plain ES modules. `npm run test:unit` runs them in Node, and
  `tests/live/smoke.mjs` already runs the **whole real pipeline in Node** (parse → tailor → skills →
  cover letter → judge → DOCX).
- The full run is already one function: `runTailor(payload)` in
  `extension/offscreen/offscreen.entry.js` (lines 72–310). It returns a structured result with
  outputs, warnings, timings and cooldowns. That function *is* the API, minus transport.
- `tests/e2e/mockLlmServer.mjs` and the `baseUrlOverride` escape hatch already let the full
  pipeline run against a local mock. The API's integration tests get this for free.
- HirePilot v4 already settled on an API shape for exactly this job (`POST /api/tailor/jobs` →
  `GET /api/tailor/jobs/:id`, in `hirepilot/backend/hirepilot_v4/server.py`). We reuse the shape,
  not the code.

**Only four spots are tied to Chrome**, and each is small:

| Seam | In the extension | In Node |
|---|---|---|
| PDF fonts | `fetch(chrome.runtime.getURL('fonts/…'))` | `fs.readFile('extension/fonts/…')` |
| Bytes → base64 | `FileReader` | `Buffer.from(bytes).toString('base64')` |
| PDF resume input | vendored `../vendor/pdfjs/pdf.min.mjs` + worker URL | `pdfjs-dist/legacy/build/pdf.mjs` (already a dependency) |
| Resume library | `chrome.storage.local` (`resumeLibrary.js` already takes a `{get,set}` adapter) | a file or KV adapter |

**Things the previous session learned that this plan must respect:**

- **Never put a key in an identifier, a log, or a response.** Two real keys once leaked through a
  cooldown map key that reached stdout. Use `credentialFingerprint()`, and extend
  `credentialLeak.test.mjs` so it also checks the API's responses and logs.
- **Rotation chains are pinned by `chainParity.test.mjs`.** The API uses `resolveProviderChain`
  exactly as the extension does, with no second model list. Provider/model config is edited only in
  `providers.js`, using the order from `~/.hirepilot/.env`.
- **The extension's "No account. No server." promise is the product.** The API is a separate,
  personal, opt-in deployment. The Chrome extension never calls it, and the README, PRIVACY.md and
  the store listing stay true without edits.
- **OpenRouter contributes zero entries to resume tasks** (an open release decision). Give the
  server a Gemini or Groq key, or an OpenRouter-only setup fails with `provider_configuration_error`.

---

## 2. Where the token savings come from

Done by hand, an agent would read the job page (~3–8k tokens), read the resume (~1.5k), write the
resume and letter with its own model (~3–6k out), then write and run code to build a .docx/.pdf.
That is roughly **15–30k tokens per application** on Muse's meter. These are estimates, and M7
measures the real number.

With the API:

| Design rule | Why it saves tokens |
|---|---|
| **One call runs the whole pipeline** | All 3–9 LLM calls (resume, judge, skills, cover letter) run server-side on *your* free-tier keys, never through the agent |
| **Upload a resume once, then refer to it by `resume_id`** | The agent never resends ~1.5k tokens of resume per job |
| **Pass the job as a URL** | The server reads the page, so the agent never pulls the full posting into context. Text is the fallback |
| **The response is ~200 tokens of JSON** | Status, title/employer, word count, warnings, and **short-lived download links**. Never base64 file bytes unless asked: a single .docx as base64 is ~10–20k tokens |
| **Same resume + same job + same preferences returns the cached run** | No repeat quota spend. `jobHistory.js`/`fingerprint.js` already do this kind of matching |
| **Small tool surface (4 tools)** | Tool schemas cost tokens on every turn, so keep descriptions short |

Target: **under 1k agent tokens per application**, including the tool schema.

### The API surface

```
POST   /v1/resumes          {filename, content_base64 | text}   -> {resume_id, name, word_count}
GET    /v1/resumes                                               -> [{resume_id, name, updated_at}]
DELETE /v1/resumes/{id}                                          -> 204
POST   /v1/runs             {resume_id, job_title, employer,
                             job_text | job_url,
                             constraints?, cover_letter?: true,
                             judge?: false, wait?: 0..120}       -> 202 {run_id, status}
                                                                    | 200 {…finished run…} if done within `wait`
GET    /v1/runs/{run_id}[?inline=base64]                         -> {status, result?, error?}
GET    /v1/runs/{run_id}/audit                                   -> the stored inputs and outputs for that run
GET    /v1/files/{token}                                         -> the .docx / .pdf (signed, expires in 24h)
GET    /openapi.json                                             -> what Muse reads to build its client
POST   /mcp                                                      -> optional (M6); Muse used REST in M0
```

**Decided with Muse (2026-10-16)**, after it proposed its own contract:

- **Async by default.** `POST /v1/runs` returns a `run_id` at once. Muse runs applications on a
  schedule in batches, so it should not hold a connection open per run. `wait` stays available for
  single interactive runs (M0 measured 90s working on Vercel).
- **`constraints` maps to the existing validated preferences**, not to free text inserted into the
  prompt. Accepted keys: `resume_notes` and `cover_letter_notes` (≤800 chars each),
  `preserve_points` (≤600), `resume_density`, `keyword_alignment`, `emphasis_areas`,
  `cover_letter_length` and `cover_letter_tone`. `validatePreferences()` checks them, and the
  engine already treats them as style guidance only. Truthfulness comes from structure, not from
  instructions: locked fields (name, contact, employers, titles, dates, education) never enter a
  prompt, and validators flag rewrites that drop numbers or drift from the original wording.
  Unknown keys are rejected with 400, so a typo cannot silently do nothing.
- **Model routing stays on the server.** Per-task chains (resume, skills, cover letter, judge) are
  tuned and pinned by `chainParity.test.mjs`. There is no per-call model override, because one
  would bypass rotation and bring back failures already fixed. (Muse suggested "Grok" for cover
  letters; the key is **Groq**, a different provider.)
- **The result includes `cover_letter_text`** (the paragraphs as plain text, for pasting into
  application forms), alongside the file links.
- **Files are links by default.** `?inline=base64` adds `content_base64` to each file, for clients
  that would rather not make a second request.

A finished run, which is all the agent ever sees:

```json
{
  "run_id": "r_8f2c",
  "status": "done",
  "job": {"title": "Data Analyst", "employer": "Northwind"},
  "resume": {"status": "ok", "word_count": 486, "pages": 1, "warnings": []},
  "cover_letter": {"status": "ok", "word_count": 312, "warnings": []},
  "cover_letter_text": "Dear Hiring Team,\n\n…",
  "files": [
    {"kind": "resume", "name": "Ada_Lovelace_Northwind_Resume_1016.docx", "url": "https://…/f/…"},
    {"kind": "resume_pdf", "name": "…Resume_1016.pdf", "url": "…"},
    {"kind": "cover_letter", "name": "…Cover_1016.docx", "url": "…"}
  ],
  "llm": {"calls": 5, "seconds": 14.2},
  "cached": false
}
```

Why both async and `wait`: the pipeline usually takes 10–20s but can rotate through providers for
longer. MCP clients and agent tool calls often time out around 30–60s. `wait=25` returns inline in
the common case, and otherwise the agent polls `GET /v1/runs/{id}`, as v4 did.

---

## 3. Keys: who holds what

**Recommended: Muse never sees your Gemini, Groq or OpenRouter keys.**

```
 Muse  ──(Bearer TAILORUNE_API_TOKEN, from its Credentials Store)──▶  Tailorune API
                                                                        │
                                          GEMINI_API_KEY, GROQ_API_KEY, │ host secrets / env vars,
                                          OPENROUTER_API_KEY  ◀─────────┘ never in a response or log
```

- Muse holds **one** revocable token that only works on your API. If it leaks, rotate one value.
  Your provider accounts are untouched.
- The provider keys live as host secrets (env vars), loaded the way `tests/live/liveEnv.mjs`
  already loads them (env only, never printed).
- **Possible but not recommended:** pass keys per request (`X-Provider-Keys` header). Muse would
  then hold three keys instead of one, and every request would carry them.

**Guard rails (all in scope, not extras):**

- **Rate limit per token** (e.g. 30 runs/day, 3 concurrent). Anyone holding the token spends your
  free quota.
- **Size limits** on resumes (2 MB) and job text (50 KB). Reject other file types, as the extension does.
- **SSRF guard on `job_url`**: https only, no private/loopback/link-local IPs, re-checked after
  redirects, a 5s timeout and a 2 MB cap.
- **Files expire after 24h**, and download links are random and unguessable. Resumes hold
  personal data, so they are stored encrypted at rest (host default) and can be deleted
  (`DELETE /v1/resumes/{id}`).
- **Logs carry no resume text, job text or keys**: only run ids, timings, model names, and
  `credentialFingerprint()` values.
- A **kill switch** env var (`API_DISABLED=1`) and a documented token-rotation step.
- **The server stores only a hash of the token** (`TAILORUNE_API_TOKEN_SHA256`) and compares
  SHA-256 digests in constant time. The token is 32 random bytes, so a slow password hash adds
  nothing; the plain token exists only in `.env.local` and in Muse's credential store.
- **Audit log:** each run stores its inputs (resume id plus a hash of the resume text, the job
  text, the constraints) and its outputs (the tailored text, file names, validator and judge
  reports, which models answered). It is kept **12 months**, can be read with
  `GET /v1/runs/{id}/audit`, and is deleted along with its resume. It holds personal data, so it
  is never written to the request log.

**Hosting decision:** Vercel, not a home server over Tailscale (Muse's suggestion). Muse runs on
a schedule, and a sleeping PC would fail those runs. Joining Muse's VM to your tailnet would also,
by default, expose every device on it. If the keys must stay at home later, use Cloudflare Tunnel
to one port rather than adding Muse to the tailnet.

---

## 4. Hosting options

| Option | How Muse reaches it | Cost | Fits the pipeline? | Verdict |
|---|---|---|---|---|
| **A. npm CLI on Muse's own VM** | Muse runs `npx tailorune-cli tailor …` | $0, no server at all | Yes, it is just Node | **Best zero-infrastructure option**, but Muse needs your provider keys, and it is unverified whether its credential injection works for a CLI's outbound calls |
| **B. Vercel Functions** (serverless) | REST / OpenAPI / MCP over HTTPS | Free (Hobby) | Yes. Node runtime, up to 300s with Fluid compute; Vercel Blob for files | **Recommended for the hosted API**: JS-native, deploys from GitHub, simple secrets |
| **C. Google Cloud Run** (container, scales to zero) | Same | Free tier covers personal use | Yes. Up to 60 min per request, any Node version | Strong alternative if you want a plain container and no Vercel-specific code |
| **D. Cloudflare Workers + R2** | Same | Needs the $5/mo plan | Free plan's 10 ms CPU is too little for PDF/DOCX rendering; paid allows minutes | Fine on paid; needs a Workers-compatible pdf.js check |
| **E. AWS Lambda + Function URL + S3** | Same | Free tier | Yes, 15 min | Works, but the most setup of any option here |
| **F. Your PC + Cloudflare Tunnel** | Public tunnel URL → `localhost` | $0 | Yes | Keys never leave your machine, but **Muse fails whenever your PC is off** |
| **G. Reuse the HirePilot v4 backend** | Tunnel to its `/api/tailor/jobs` | $0 | Python, superseded, ~490 MB install | Not recommended: it is the code Tailorune replaced |
| Netlify Functions | — | — | Sync functions cap at ~10–26s, under a slow run | Only with background functions; skip |

Platform limits change; check each one when you deploy.

**Serverless caveat, worth knowing and acceptable:** rotation cooldowns (`rotatingClient.js`,
`rateWindow.js`) are in-memory `Map`s. A fresh serverless instance forgets that a model was just
rate-limited, so it may try it once more before rotating. That costs one fast failure, not a broken
run. M8 can persist cooldowns to a KV store if it ever matters.

**Recommendation:** build one Node core and put it behind **two thin entry points**: a **CLI**
(option A, and local use) and an **HTTP handler** deployed on **Vercel** (option B). Cloud Run
(option C) stays a one-file `Dockerfile` swap if Vercel's limits get in the way. The HTTP handler
is a plain `(Request) → Response` function, so it is portable to C, D and E without a rewrite.

---

## 5. Milestones

Each milestone ends green on `npm test` (476 tests, e2e included). **The published extension must
behave identically after every milestone.**

### M0 — Confirm how Muse connects (½ day)
- Deploy a 10-line "hello" endpoint on Vercel with a Bearer token, and ask Muse to build a custom
  connector from its OpenAPI doc. Then try the same as a remote MCP server.
- Answer: **Bearer or OAuth?** **REST or MCP?** How long does a tool call wait before timing out?
  Can it download a file from a link?
- **Done when:** Muse calls the hello endpoint with a token from its Credentials Store, and the
  answers are written into this doc.

**Progress (2026-10-16):** the probe (`server/http/probe.js`, 12 tests) is live at
`https://tailorune-probe.vercel.app` (Vercel project `tailorune-probe`, Hobby). Verified from
outside: `/openapi.json` is public; `/v1/ping` gives 401 without the token and with a wrong one,
200 with it; `/v1/files/sample.txt` downloads as an attachment; `/mcp` handles `initialize` and
`tools/call`; **a 90s call completes**, so Vercel is not the limit below 300s. The token is in
the gitignored `.env.local` and is stored on Vercel as a sensitive production variable.
**Muse connected (2026-10-16, 11:06–11:08 UTC), from the Vercel request logs:**

| Question | Answer | Evidence |
|---|---|---|
| Bearer or OAuth? | **Bearer works. No OAuth needed** | Two 401s from `curl` without a token, then every call with `Bearer` got 200. The token never appears in the logs |
| REST or MCP? | **REST**, via the OpenAPI doc. MCP was never called | `curl` fetched `/openapi.json`, then a **`Python-urllib/3.12`** script made every authenticated call. Muse writes its own Python client on its VM and saved it as a "connector doc plus helper" |
| Can it fetch a file link? | **Yes** | `GET /v1/files/sample.txt` → 200 from the same Python client |
| How long may a call take? | **At least 240s**: 60, 120 and 240 all returned 200 | Muse's rerun at 11:14–11:21 UTC. Responses logged at 11:15:35, 11:17:35 and 11:21:36, all 200 from `Python-urllib`. The gaps match back-to-back 60/120/240s waits. The probe caps at 280s, so Vercel's 300s is the ceiling, not Muse |

**What this changes in the plan:**
- Connectors are created **in chat**, not in Settings. Meta's help article says to ask Muse to create a custom connector, and Muse keeps the key in its Secure Credentials Store.
- **M6 (MCP) drops to optional.** Muse used REST + OpenAPI on its own, so the OpenAPI doc is the main interface. Its descriptions matter more than any MCP tool schema.
- **The timeout belongs to Muse's script, not a tool-call limit, and it held 240s.** A synchronous
  `wait` covering a whole run (typically 10–20s) is safe for single runs. Async with polling stays
  the default for scheduled batches, where holding connections open buys nothing.
- **M0 is complete.** All four questions are answered.
- **Hobby keeps runtime logs for under an hour.** Read them right after a Muse session (`vercel logs --cwd server --environment production --since 59m`).

### M1 — Pull the pipeline out of the offscreen document (1–2 days, riskiest)
- Move `runTailor` from `offscreen.entry.js` into `extension/engine/pipeline.js`, taking its four
  platform seams as injected arguments (`loadFonts`, `toBase64`, `extractPdf`, `now`).
- `offscreen.entry.js` becomes a ~30-line wrapper that injects the Chrome versions. Same
  behaviour, same bundle output.
- Add `server/platform/node.js` with the Node versions of those seams.
- **Tests first:** a unit test that runs `pipeline.js` against `mockLlmServer` in Node and gets a
  .docx and .pdf out, plus a `credentialLeak` assertion over the whole result.
- **Done when:** unit and e2e tests pass, the new Node pipeline test passes, and a 2.3.4 build
  loaded unpacked does one real tailor exactly as before. *(This milestone touches the shipped
  extension. That is why it comes first and is guarded by the full e2e suite. The alternative,
  copying `runTailor` into the server, avoids that risk but means two copies that drift apart.)*

**Progress (2026-10-16): built and committed (`ce4bc25`).**
- `extension/engine/pipeline.js` exports `runTailorPipeline(payload, platform)`. The body was moved
  byte for byte by script from `offscreen.entry.js`; the only edit passes `extractPdfText` into
  `resolveResumeText`.
- `offscreen.entry.js` is now a ~60-line wrapper that supplies Chrome's fonts, FileReader base64 and
  the vendored pdf.js.
- PDF text assembly and the scanned-PDF guard moved to `engine/pdfText.js`
  (`extractPdfTextWith(pdfjsLib, bytes)`), shared by `extractPdfText.js` (Chrome) and
  `server/platform/node.js` (pdfjs-dist legacy build, loaded lazily).
- `tests/unit/pipeline.test.mjs`: full Node runs (txt and PDF resumes → DOCX and PDF), the Node
  seams, and no provider key in the result.
- `npm test`: **408 unit + 84 e2e pass.**
- **Still to do before a release:** one manual run of the unpacked extension with a real key.
- Known noise: in Node, pdf.js warns `standardFontDataUrl` once per PDF. Extraction is unaffected,
  but silence it before M3 so it stays out of production logs.

### M2 — CLI (1 day)
- `server/cli.mjs`: `tailorune tailor --resume <file> (--job-url <u> | --job-file <f>) [--no-cover] [--pdf] [--out <dir>] [--json]`.
- Keys come only from env vars / `.env.local`, reusing `liveEnv.mjs`. Prints the compact JSON from §2.
- **Done when:** a live run through the CLI produces the four files and prints no secret
  (`npm run test:live`-style check). This is already a working local integration for any agent
  that can run a shell, Muse Code included.

**Progress (2026-10-16): done and committed (`bfedc98`).**
- As built: `node server/cli.mjs tailor --resume <file> --title <t> --employer <e>
  (--job-file <f> | --job-text <t>) [--out <dir>] [--constraints <file.json>] [--no-cover]
  [--no-pdf] [--judge]`. It always prints JSON (stdout on success, `{status:"error"}` on stderr),
  with exit codes 0 / 1 (run failed) / 2 (usage or configuration). `--job-url` waits for M4.
- Key loading moved from `tests/live/liveEnv.mjs` to **`server/keys.mjs`**, which `liveEnv`
  re-exports, so there is still one place that reads keys. Key-like flags (`--api-key`, `--token`,
  …) are refused by name, so a key never lands in shell history. The summary is an allowlist, and
  every configured key is redacted from output as a last stop.
- `--constraints` takes the preference fields from §2, and `validatePreferences()` already rejects
  unknown keys, so the CLI exits 2 before any model call.
- The pipeline result now includes `coverLetter.text`, which becomes `cover_letter_text`.
- pdf.js in Node now gets its standard fonts and `verbosity: 0`. Its warnings went to stdout and
  would have corrupted the JSON on PDF resumes.
- Tests: `tests/unit/cli.test.mjs` (12, including end-to-end child-process runs against the mock).
  `npm test`: **420 unit + 84 e2e pass.**
- **Live run** with the real keys (fictional `jordan-lee-standard.txt` against the fictional demo
  posting): **done in 20s with 3 calls**. Resume, skills and cover letter were all approved, and the
  four files were written. Every locked field was verified unchanged in the DOCX, and the PDF reads
  back. The summary is 3.3 KB (~800 tokens, half of it the letter text). A scan of stdout and
  stderr found none of the four keys, not even a 12-character prefix.
- **What the live run taught us:** the *first* attempt failed. Both Gemini models returned
  `provider_unavailable` and Groq's Qwen failed validation, so the run ended with "retry in about
  30s". The identical retry a minute later succeeded. **M3's queue must retry a run that fails as
  temporarily unavailable** (once, after the suggested wait), or Muse's scheduled batches will
  report outages as failed applications.

### M3 — HTTP API core (2 days)
- `server/http/handler.js`: the routes from §2 as one `(Request) → Response` handler. Bearer
  auth, input validation, size limits, a consistent `{ok, data, error}` envelope.
- A storage interface (`putFile`, `getFile`, `putResume`, `getRun`, …) with a **local-disk**
  version for dev and tests.
- An async run queue, with `wait` support and response caching by fingerprint. On Vercel the run
  continues after the 202 through `waitUntil` (from `@vercel/functions`), within `maxDuration`.
  Concurrency is capped at 2, so a scheduled morning batch queues instead of hitting free-tier
  rate limits all at once. A run that fails as *temporarily unavailable* is retried once after
  the wait the error suggests (M2's live run needed exactly this), and only then reported as failed.
- `constraints` → `validatePreferences()`, rejecting unknown keys; `cover_letter_text`; `?inline=base64`.
- Token auth against `TAILORUNE_API_TOKEN_SHA256`, replacing the probe's plain-token comparison.
- An audit record per run (§3), with `GET /v1/runs/{id}/audit` and the 12-month retention sweep.
- `GET /openapi.json`, written by hand and short. Its descriptions *are* the agent's instructions,
  so keep them terse.
- **Tests:** integration tests over the handler against `mockLlmServer`. Cover 401 without a
  token, 413 over the size limits, 400 for an unknown `constraints` key, the async → poll → done
  path, the cached second call, the audit record matching the result, and that no response,
  audit record or log contains a provider key or the token.
- **Done when:** the CLI and HTTP both pass the same golden-run test.

### M4 — Read the job from a URL on the server (1 day)
- Fetch the page with the SSRF guard. Run `extractJob.js`'s **JSON-LD tier** (no DOM needed), then
  readable-text extraction over the parsed HTML (`linkedom`, small and dependency-free).
- If the page is behind a login or empty (LinkedIn usually is), return `422 job_unreadable`
  with a hint to send `job_text`. Muse has a browser and can do that.
- **Done when:** the fixture postings in `tests/e2e` extract server-side with the same title and
  employer as in-browser, and private-IP URLs are refused.

### M5 — Deploy (½–1 day)
- Vercel project rooted at `server/`. Secrets: the provider keys and `TAILORUNE_API_TOKEN`.
  Storage: Vercel Blob for files, a small KV for runs, resumes and the per-token rate limit.
- Exclude `server/` from the extension package. `build/package-extension.mjs` zips only
  `extension/` already, so a test should pin that.
- **Done when:** the production smoke test (resume upload → run → download) passes against the
  live URL, and a request without a token gets 401.

### M6 — MCP endpoint (1 day). *Optional since M0: Muse connected over REST + OpenAPI without it*
- `POST /mcp` (streamable HTTP, official `@modelcontextprotocol/sdk`) exposing `save_resume`,
  `list_resumes`, `tailor_job` and `get_run`. Each is a thin call into the M3 handlers.
- Bearer auth by default. Add **OAuth (M8)** only if M0 showed Muse's connector settings need it.
- **Done when:** MCP Inspector lists and calls all 4 tools against production.

### M7 — Connect Muse, and measure (½–1 day)
- Register the connector in Muse with the token in its Credentials Store. Run **3 real postings**
  end to end.
- **Measure tokens per application**, with and without the API, and record the numbers here.
- Write `docs/AGENT_API.md`: setup, token rotation, the kill switch, deleting your data.
- **Done when:** Muse turns "tailor my resume for <link>" into files you can open, in one tool
  call plus at most one poll.

### M8 — Optional, only if needed
- Persistent cooldowns in KV (if serverless retries show up in timings).
- OAuth for MCP (if Muse requires it).
- Publish the CLI to npm for option A (only after deciding whether Muse should hold provider keys).

**Total: about 8–10 working days** for M0–M7.

---

## 6. Risks and open questions

| Risk | Mitigation |
|---|---|
| M1 refactor regresses the live extension | Tests first, the full e2e suite, and a manual unpacked run before any store upload. Ship it as its own patch release |
| Muse requires OAuth for MCP | M0 finds out on day one. The REST + OpenAPI route works with a plain Bearer token either way |
| Token leak → someone spends your free quota | Per-token rate limit, kill switch, one-line rotation. Provider keys are never exposed |
| Job boards block server-side fetches | `job_text` fallback; Muse's browser reads the page |
| Resume (personal data) stored in the cloud | Encrypted at rest, 24h file expiry, delete endpoint. Or option F if you want nothing in the cloud |
| Free-tier quotas shared between you and Muse | Same keys means the same quota. Use a separate Gemini key for the API if runs start colliding |
| Public repo, private deployment | Code in the repo, secrets only in host env vars; `.env.local` is already gitignored |
