// server/runs/runner.mjs — when runs execute, how many at once, and when to try again.
//
// Runs are queued and executed at most `maxConcurrent` at a time, so a batch
// of scheduled applications queues instead of hitting every free-tier rate
// limit in the same second.
//
// A run that fails because providers are TEMPORARILY unavailable is retried
// once, after the wait the error itself suggests. This is not speculative:
// M2's first live run failed exactly that way (both Gemini models briefly
// unavailable), and the identical retry a minute later succeeded. Anything
// else -- a bad key, a missing resume, an unexpected error -- fails at once,
// because waiting would not change the answer.
//
// The runner owns the run record's status: queued -> running -> (retrying ->
// running ->) done | failed.

const TERMINAL = new Set(['done', 'failed']);

/**
 * @returns {number|null} milliseconds to wait before retrying, or null for "do not retry".
 */
export function retryDelayMs(err, { defaultWaitSeconds = 30, maxWaitSeconds = 90 } = {}) {
  const kind = err && err.kind;
  const after = err && err.detail && err.detail.retryAfterSeconds;
  const transient = kind === 'providers_temporarily_unavailable'
    || kind === 'rate_limited'
    || (kind === 'quota_exhausted' && Number.isFinite(after) && after <= maxWaitSeconds);
  if (!transient) return null;
  const seconds = Number.isFinite(after) ? after : defaultWaitSeconds;
  return Math.min(Math.max(seconds, 1), maxWaitSeconds) * 1000;
}

export function createRunner({
  store, execute, sleep, now, log = () => {}, scrub = (m) => m,
  maxConcurrent = 2, maxAttempts = 2, retry = {},
}) {
  const queue = [];
  const completions = new Map(); // run_id -> { promise, resolve }
  const inFlight = new Set();
  let active = 0;

  const completionFor = (runId) => {
    if (!completions.has(runId)) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      completions.set(runId, { promise, resolve });
    }
    return completions.get(runId);
  };

  const save = async (runId, changes) => {
    const run = await store.getRun(runId);
    const next = { ...run, ...changes, updated_at: new Date(now()).toISOString() };
    await store.putRun(next);
    return next;
  };

  async function process(runId) {
    const run = await store.getRun(runId);
    const resume = run && await store.getResume(run.input.resume_id);
    if (!resume) {
      return save(runId, { status: 'failed', error: { kind: 'resume_missing', message: 'The resume for this run was deleted.' } });
    }

    for (let attempt = 1; ; attempt += 1) {
      await save(runId, { status: 'running', attempts: attempt });
      try {
        const { summary, fileTokens } = await execute(run, resume);
        log({ event: 'run_done', run_id: runId, attempts: attempt });
        return save(runId, { status: 'done', result: summary, file_tokens: fileTokens, error: null });
      } catch (err) {
        const error = { kind: (err && err.kind) || 'internal_error', message: scrub(String((err && err.message) || err)) };
        const delay = attempt < maxAttempts ? retryDelayMs(err, retry) : null;
        log({ event: delay === null ? 'run_failed' : 'run_retrying', run_id: runId, attempts: attempt, kind: error.kind });
        if (delay === null) return save(runId, { status: 'failed', error });
        await save(runId, { status: 'retrying', error });
        await sleep(delay);
      }
    }
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const runId = queue.shift();
      active += 1;
      const job = process(runId)
        .catch((err) => save(runId, { status: 'failed', error: { kind: 'internal_error', message: scrub(String(err && err.message)) } }))
        .then((final) => completionFor(runId).resolve(final))
        .finally(() => {
          active -= 1;
          inFlight.delete(job);
          completions.delete(runId);
          pump();
        });
      inFlight.add(job);
    }
  }

  return {
    /** Queue a stored run. Resolves with the final run record. */
    submit(runId) {
      const { promise } = completionFor(runId);
      queue.push(runId);
      pump();
      return promise;
    },

    /** The run once it finishes, or null if `ms` passes first. */
    async wait(runId, ms) {
      const current = await store.getRun(runId);
      if (!current || TERMINAL.has(current.status)) return current;
      if (!completions.has(runId)) return null; // not queued in this process
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(() => r(null), ms); });
      try {
        return await Promise.race([completions.get(runId).promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    /** Resolves once nothing is queued or running. */
    async idle() {
      while (inFlight.size || queue.length) await Promise.all([...inFlight]);
    },
  };
}
