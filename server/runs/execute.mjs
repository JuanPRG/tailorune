// server/runs/execute.mjs — one attempt at one run: pipeline, files, audit.
//
// The runner decides WHEN an attempt happens and whether to try again; this
// decides what an attempt is. It throws on failure (the pipeline's LlmError
// passes through untouched, so the runner can read its `kind`), and on
// success stores the generated files and the audit record and returns the
// summary an agent will read.

import { randomBytes } from 'node:crypto';
import { summarizeRun } from '../summary.mjs';

export const FILE_TTL_MS = 24 * 3_600_000;
export const AUDIT_TTL_MS = 365 * 24 * 3_600_000;

const CONTENT_TYPES = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
};
const contentTypeFor = (name) => CONTENT_TYPES[name.slice(name.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';

/** A file token is the whole of a download link's secret: 32 random bytes. */
export const newFileToken = () => randomBytes(32).toString('base64url');

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.kind = 'provider_configuration_error';
  }
}

/**
 * @param {object} run     the stored run record
 * @param {object} resume  the stored resume record (holds the extracted text)
 */
export async function executeRun(run, resume, deps) {
  const { store, runPipeline, platform, providerKeys, baseUrlOverride, now } = deps;
  const [providerId] = Object.keys(providerKeys);
  if (!providerId) throw new ConfigurationError('No provider key is configured on the server.');

  const input = run.input;
  const result = await runPipeline({
    resumeText: resume.text,
    jobDescription: input.job_text,
    jobTitle: input.job_title,
    employer: input.employer,
    preferences: input.constraints,
    providerId,
    apiKey: providerKeys[providerId],
    providerKeys,
    includeCoverLetter: input.cover_letter,
    autoDownloadPdf: true,
    useJudge: input.judge,
    baseUrlOverride,
  }, platform);
  if (!result || !result.ok) throw new Error((result && result.error) || 'The run failed.');

  const createdAt = now();
  const files = [];
  for (const output of result.outputs) {
    const token = newFileToken();
    await store.putFile(token, Buffer.from(output.base64, 'base64'), {
      run_id: run.run_id,
      kind: output.kind,
      name: output.filename,
      content_type: contentTypeFor(output.filename),
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(createdAt + FILE_TTL_MS).toISOString(),
    });
    files.push({ kind: output.kind, name: output.filename, file_token: token });
  }

  const summary = summarizeRun(result, { job: { title: input.job_title, employer: input.employer }, files });

  // What was generated, from what, by which model -- kept for a year so a
  // document can be explained long after its download link has expired.
  await store.putAudit({
    run_id: run.run_id,
    created_at: new Date(createdAt).toISOString(),
    expires_at: new Date(createdAt + AUDIT_TTL_MS).toISOString(),
    inputs: {
      resume_id: resume.resume_id,
      resume_name: resume.name,
      resume_sha256: resume.sha256,
      job_title: input.job_title,
      employer: input.employer,
      job_text: input.job_text,
      constraints: input.constraints,
      cover_letter: input.cover_letter,
      judge: input.judge,
    },
    outputs: {
      cover_letter_text: summary.cover_letter_text,
      files: result.outputs.map((o) => ({ kind: o.kind, name: o.filename, content_base64: o.base64 })),
    },
    reports: {
      resume: { status: result.resumeStatus, warnings: result.resumeWarnings || [], errors: result.resumeErrors || [], judge: result.resumeJudge || null },
      skills: result.skills || null,
      cover_letter: summary.cover_letter,
    },
    models: (result.llm && result.llm.answers) || [],
  });

  return { summary, fileTokens: files.map((f) => f.file_token) };
}
