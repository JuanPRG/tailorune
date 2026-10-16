// server/summary.mjs — what an agent is shown about a finished run.
//
// Shared by the CLI and the HTTP API so both describe a run identically. The
// summary is an allowlist on purpose: fields are copied out one by one, so
// nothing new in the pipeline's result -- cooldowns, demotions, a future
// diagnostic -- reaches an agent without someone deciding it should.

const seconds = (ms) => Math.round(ms / 100) / 10;

/**
 * @param {object} result  runTailorPipeline's result
 * @param {{ job: {title?: string, employer?: string}, files: object[] }} context
 *   files are shaped by the caller: paths for the CLI, URLs for the API.
 */
export function summarizeRun(result, { job, files }) {
  const letter = result.coverLetter;
  return {
    status: 'done',
    job: { title: job.title, employer: job.employer },
    resume: {
      status: result.resumeStatus,
      word_count: result.wordCount,
      warnings: result.resumeWarnings || [],
      errors: result.resumeErrors || [],
    },
    skills: { status: result.skills ? result.skills.status : null },
    cover_letter: letter
      ? { status: letter.status, word_count: letter.wordCount, warnings: letter.warnings || [], errors: letter.errors || [] }
      : null,
    cover_letter_text: letter ? letter.text : null,
    files,
    llm: { calls: result.llm.calls, seconds: seconds(result.llm.ms) },
  };
}

/** Belt and braces: the engine's errors are tested to carry no key, but this is the last stop. */
// Real provider keys are tens of characters. A shorter "key" is a broken
// configuration, and splitting on it would shred the very message that
// explains the breakage (it happened: a key truncated to "g").
const MIN_KEY_CHARS = 16;

export function redact(message, keys) {
  return Object.values(keys)
    .filter((key) => typeof key === 'string' && key.length >= MIN_KEY_CHARS)
    .reduce((text, key) => text.split(key).join('[redacted]'), String(message));
}
