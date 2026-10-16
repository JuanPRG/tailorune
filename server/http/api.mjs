// server/http/api.mjs — the agent API's routes. M3 of docs/AGENT_API_PLAN.md.
//
// One (Request) -> Response function, so the same code runs under Vercel, a
// local dev server and node:test. Routing, validation, rate limiting and
// caching live here; running a job is the runner's business, storing things
// the store's.
//
// Every route but /openapi.json needs the Bearer token -- file downloads
// included, since a resume is personal data even behind an unguessable link.
// Logs carry method, path, status and timing only: never a body, never the
// token, and file tokens are masked out of paths.

import { createHash, randomBytes } from 'node:crypto';

import { resolveResumeText } from '../../extension/engine/pipeline.js';
import { NoExtractableTextError } from '../../extension/engine/pdfText.js';
import { checkBearer } from './auth.mjs';
import { openApiDocument } from './openapi.mjs';
import { ApiError, fail, json, ok, readJsonBody, routePath } from './respond.mjs';
import { validateResumeUpload, validateRunRequest } from './validate.mjs';
import { FILE_TTL_MS, AUDIT_TTL_MS } from '../runs/execute.mjs';

const MAX_BODY_BYTES = 3.5 * 1024 * 1024; // a 2 MB file, base64'd, plus the JSON around it
const DAY_MS = 24 * 3_600_000;
const SWEEP_EVERY_MS = 3_600_000;
const DEFAULT_MAX_RUNS_PER_DAY = 30;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const iso = (ms) => new Date(ms).toISOString();
const wordCount = (text) => (text.match(/\S+/g) || []).length;

export function createApi({ store, runner, env, now, log, platform, defer = () => {} }) {
  const maxRunsPerDay = Number(env.TAILORUNE_MAX_RUNS_PER_DAY) || DEFAULT_MAX_RUNS_PER_DAY;
  let lastSweep = -Infinity;

  // --- views -----------------------------------------------------------------

  /** A run as an agent sees it. File tokens become absolute URLs on the way out. */
  async function runView(run, origin, { inline = false, cached = false } = {}) {
    let result = null;
    if (run.result) {
      const files = [];
      for (const f of run.result.files) {
        const entry = { kind: f.kind, name: f.name, url: `${origin}/v1/files/${f.file_token}` };
        if (inline) {
          const stored = await store.getFile(f.file_token);
          if (stored && Date.parse(stored.meta.expires_at) > now()) entry.content_base64 = Buffer.from(stored.bytes).toString('base64');
        }
        files.push(entry);
      }
      result = { ...run.result, files, cached };
    }
    return {
      run_id: run.run_id,
      status: run.status,
      created_at: run.created_at,
      attempts: run.attempts || 0,
      result,
      error: run.error || null,
    };
  }

  // --- retention ---------------------------------------------------------------

  /**
   * Deletes expired files, audit records and old runs, piggybacking on requests at most hourly
   * per instance. Each store decides how to do it cheaply (the Blob store also limits itself to
   * once a day across instances). Expiry is enforced on every read regardless, so a late
   * sweep only delays reclaiming space -- it never serves an expired file.
   */
  async function sweep() {
    const t = now();
    if (t - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = t;
    try {
      await store.sweepExpired(t, { fileTtlMs: FILE_TTL_MS, auditTtlMs: AUDIT_TTL_MS });
    } catch (err) {
      log({ event: 'sweep_failed', error: String((err && err.message) || err).slice(0, 300) });
    }
  }

  // --- resumes -----------------------------------------------------------------

  async function uploadResume(request) {
    const upload = validateResumeUpload(await readJsonBody(request, MAX_BODY_BYTES));
    let text = upload.text;
    if (text === undefined) {
      try {
        text = await resolveResumeText({
          resumeFileBase64: Buffer.from(upload.bytes).toString('base64'),
          resumeFileExt: upload.ext,
        }, platform.extractPdfText);
      } catch (err) {
        if (err instanceof NoExtractableTextError) throw new ApiError(422, err.message);
        throw new ApiError(422, `Could not read ${upload.ext} file: ${err.message}`);
      }
    }
    if (!text || !text.trim()) throw new ApiError(422, 'No text could be read from the resume.');

    const t = now();
    const resume = {
      resume_id: newId('res'),
      name: upload.filename,
      ext: upload.ext,
      text,
      sha256: sha256(text),
      word_count: wordCount(text),
      created_at: iso(t),
    };
    await store.putResume(resume);
    return ok({ resume_id: resume.resume_id, name: resume.name, word_count: resume.word_count, created_at: resume.created_at }, 201);
  }

  async function listResumes() {
    const resumes = (await store.listResumes())
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((r) => ({ resume_id: r.resume_id, name: r.name, word_count: r.word_count, created_at: r.created_at }));
    return ok(resumes);
  }

  /** A resume, and everything made from it: runs, their files, their audit records. */
  async function deleteResume(resumeId) {
    if (!(await store.getResume(resumeId))) throw new ApiError(404, 'No such resume.');
    for (const run of await store.listRuns()) {
      if (run.input.resume_id !== resumeId) continue;
      for (const token of run.file_tokens || []) await store.deleteFile(token);
      await store.deleteAudit(run.run_id);
      await store.deleteRun(run.run_id);
    }
    await store.deleteResume(resumeId);
    return new Response(null, { status: 204 });
  }

  // --- runs ----------------------------------------------------------------------

  async function startRun(request, origin) {
    const req = validateRunRequest(await readJsonBody(request, MAX_BODY_BYTES));
    const resume = await store.getResume(req.resume_id);
    if (!resume) throw new ApiError(404, 'No such resume. Upload one with POST /v1/resumes.');

    const { wait, ...input } = req;
    const fingerprint = sha256(JSON.stringify({
      resume_sha256: resume.sha256,
      job_title: input.job_title,
      employer: input.employer,
      job_text: input.job_text,
      constraints: input.constraints,
      cover_letter: input.cover_letter,
      judge: input.judge,
    }));

    const t = now();
    // The cache and the daily limit only look back a day, so only the last
    // day's runs are read (on Blob, filtered before any record is fetched).
    const runs = await store.listRuns({ sinceMs: t - DAY_MS });

    // An identical request whose files are still downloadable is answered from
    // the earlier run: same documents, no quota spent. One still in progress
    // is returned too, so a retried POST cannot start a duplicate.
    const previous = runs
      .filter((r) => r.fingerprint === fingerprint && r.status !== 'failed')
      .filter((r) => r.status !== 'done' || Date.parse(r.created_at) + FILE_TTL_MS > t)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (previous) {
      const done = previous.status === 'done';
      return ok(await runView(previous, origin, { cached: done }), done ? 200 : 202);
    }

    const recent = runs.filter((r) => Date.parse(r.created_at) > t - DAY_MS);
    if (recent.length >= maxRunsPerDay) {
      const oldest = Math.min(...recent.map((r) => Date.parse(r.created_at)));
      const retryAfter = Math.max(1, Math.ceil((oldest + DAY_MS - t) / 1000));
      throw new ApiError(429, `Daily limit of ${maxRunsPerDay} runs reached.`, { headers: { 'retry-after': String(retryAfter) } });
    }

    const run = {
      run_id: newId('run'),
      status: 'queued',
      created_at: iso(t),
      updated_at: iso(t),
      attempts: 0,
      fingerprint,
      input,
      result: null,
      error: null,
      file_tokens: [],
    };
    await store.putRun(run);
    defer(runner.submit(run.run_id));

    if (wait > 0) {
      const finished = await runner.wait(run.run_id, wait * 1000);
      if (finished) return ok(await runView(finished, origin), 200);
    }
    return ok(await runView(await store.getRun(run.run_id), origin), 202);
  }

  async function getRun(runId, origin, url) {
    const run = await store.getRun(runId);
    if (!run) throw new ApiError(404, 'No such run.');
    return ok(await runView(run, origin, { inline: url.searchParams.get('inline') === 'base64' }));
  }

  async function getAudit(runId) {
    const audit = await store.getAudit(runId);
    if (!audit || Date.parse(audit.expires_at) <= now()) throw new ApiError(404, 'No audit record for this run.');
    return ok(audit);
  }

  async function downloadFile(token) {
    const stored = await store.getFile(token);
    if (!stored || Date.parse(stored.meta.expires_at) <= now()) throw new ApiError(404, 'No such file, or it has expired (files are kept 24 hours).');
    return new Response(stored.bytes, {
      status: 200,
      headers: {
        'content-type': stored.meta.content_type,
        'content-disposition': `attachment; filename="${stored.meta.name.replace(/"/g, '')}"`,
        'cache-control': 'private, no-store',
      },
    });
  }

  // --- routing -------------------------------------------------------------------

  async function route(request, url, path) {
    const origin = url.origin;
    if (path === '/openapi.json' && request.method === 'GET') return json(200, openApiDocument(origin));

    if (env.API_DISABLED === '1') return fail(503, 'The API is disabled.');
    const auth = checkBearer(request, env);
    if (auth === 'unconfigured') return fail(503, 'The API token is not configured on the server.');
    if (auth !== 'ok') return fail(401, 'Missing or invalid Bearer token.', { 'www-authenticate': 'Bearer realm="tailorune"' });

    await sweep();

    const m = request.method;
    let match;
    if (path === '/v1/resumes' && m === 'POST') return uploadResume(request);
    if (path === '/v1/resumes' && m === 'GET') return listResumes();
    if ((match = /^\/v1\/resumes\/([^/]+)$/.exec(path)) && m === 'DELETE') return deleteResume(match[1]);
    if (path === '/v1/runs' && m === 'POST') return startRun(request, origin);
    if ((match = /^\/v1\/runs\/([^/]+)$/.exec(path)) && m === 'GET') return getRun(match[1], origin, url);
    if ((match = /^\/v1\/runs\/([^/]+)\/audit$/.exec(path)) && m === 'GET') return getAudit(match[1]);
    if ((match = /^\/v1\/files\/([^/]+)$/.exec(path)) && m === 'GET') return downloadFile(match[1]);
    return fail(404, `No route for ${m} ${path}.`);
  }

  return async function handle(request) {
    const started = now();
    const url = new URL(request.url);
    const path = routePath(url);
    let response;
    try {
      response = await route(request, url, path);
    } catch (err) {
      if (err instanceof ApiError) {
        response = fail(err.status, err.message, err.headers);
      } else {
        log({ event: 'internal_error', path, error: String((err && err.message) || err).slice(0, 300) });
        response = fail(500, 'Internal error.');
      }
    }
    log({
      at: iso(started),
      method: request.method,
      path: path.replace(/^\/v1\/files\/.+$/, '/v1/files/:token'),
      status: response.status,
      ms: now() - started,
    });
    return response;
  };
}
