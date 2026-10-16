// server/app.mjs — wires the agent API together: store, runner, routes.
//
// Everything with a side effect is injectable (clock, sleep, log, pipeline,
// `defer`), so the tests drive the real code paths with a fake clock, and
// Vercel can pass its waitUntil as `defer` so a queued run keeps going after
// the 202 has been sent (M5).

import { runTailorPipeline } from '../extension/engine/pipeline.js';
import { providerKeysFromEnv } from './keys.mjs';
import { nodePlatform } from './platform/node.js';
import { redact } from './summary.mjs';
import { createFsStore } from './store/fsStore.mjs';
import { createRunner } from './runs/runner.mjs';
import { executeRun } from './runs/execute.mjs';
import { createApi } from './http/api.mjs';

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const defaultLog = (entry) => { console.info(JSON.stringify(entry)); };

/**
 * @param {{ dataDir: string, env?: object, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   log?: (entry: object) => void, runPipeline?: Function, platform?: object,
 *   maxConcurrent?: number, defer?: (p: Promise<unknown>) => void, store?: object }} options
 */
export function createApp({
  dataDir,
  env = process.env,
  now = Date.now,
  sleep = defaultSleep,
  log = defaultLog,
  runPipeline = runTailorPipeline,
  platform = nodePlatform,
  maxConcurrent = 2,
  defer,
  store = createFsStore(dataDir),
}) {
  const providerKeys = providerKeysFromEnv(env);
  const scrub = (message) => redact(message, providerKeys);

  const runner = createRunner({
    store,
    now,
    sleep,
    log,
    scrub,
    maxConcurrent,
    execute: (run, resume) => executeRun(run, resume, {
      store,
      runPipeline,
      platform,
      providerKeys,
      baseUrlOverride: env.TAILORUNE_LLM_BASE_URL || undefined,
      now,
    }),
  });

  const handle = createApi({ store, runner, env, now, log, platform, defer });
  return { handle, runner, store };
}
