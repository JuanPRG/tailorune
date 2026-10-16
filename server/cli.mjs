#!/usr/bin/env node
// server/cli.mjs — tailor a resume from the command line. M2 of docs/AGENT_API_PLAN.md.
//
//   node server/cli.mjs tailor --resume resume.pdf --title "Data Analyst" \
//     --employer "Northwind" --job-file posting.txt [--out dir] \
//     [--constraints constraints.json] [--no-cover] [--no-pdf] [--judge]
//
// Runs engine/pipeline.js -- the exact pipeline the extension runs -- writes
// the files to --out, and prints a short JSON summary on stdout. That summary
// is what an agent reads, so it carries no file bytes and no internals: a
// resume as base64 is ~10-20k tokens, the summary is a few hundred.
//
// Provider keys come from the environment or env files only (server/keys.mjs),
// never from an argument, and never appear in anything this prints.
//
// Exit codes: 0 done, 1 the run failed, 2 bad usage or configuration.

import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runTailorPipeline } from '../extension/engine/pipeline.js';
import { validatePreferences, PreferenceError } from '../extension/engine/preferences.js';
import { loadEnvFiles, providerKeysFromEnv, PROVIDER_ENV } from './keys.mjs';
import { nodePlatform } from './platform/node.js';
import { summarizeRun, redact } from './summary.mjs';

export { summarizeRun };

const MAX_RESUME_BYTES = 2 * 1024 * 1024;
const MAX_JOB_CHARS = 50_000;
const RESUME_EXTENSIONS = new Set(['.txt', '.docx', '.pdf']);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const USAGE = `Usage:
  node server/cli.mjs tailor --resume <file> --title <job title> --employer <name>
                             (--job-file <file> | --job-text <text>)
                             [--out <dir>] [--constraints <file.json>]
                             [--no-cover] [--no-pdf] [--judge]

Keys are read from the environment (${Object.values(PROVIDER_ENV).join(', ')}),
or from .env.local / the file TAILORUNE_ENV_FILE points at. Never pass one as an argument.
`;

const OPTIONS = {
  resume: { type: 'string' },
  title: { type: 'string' },
  employer: { type: 'string' },
  'job-file': { type: 'string' },
  'job-text': { type: 'string' },
  'job-url': { type: 'string' },
  out: { type: 'string' },
  constraints: { type: 'string' },
  'no-cover': { type: 'boolean', default: false },
  'no-pdf': { type: 'boolean', default: false },
  judge: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

/** Anything that looks like a key flag is refused by name, before the parser can echo its value. */
const KEY_FLAG = /^--?(api[-_]?key|key|token|secret)(=|$)/i;

/**
 * @param {string[]} argv  arguments after the script name
 * @returns {{ command: 'tailor'|'help', options?: object }}
 */
export function parseCliArgs(argv) {
  if (argv.some((a) => KEY_FLAG.test(a))) {
    throw new UsageError(
      `Provider keys are read from the environment (${Object.values(PROVIDER_ENV).join(', ')}), `
      + 'never from an argument, which would land in your shell history.',
    );
  }
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return { command: 'help' };
  if (command !== 'tailor') throw new UsageError(`Unknown command "${command}". The only command is "tailor".`);

  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (values.help) return { command: 'help' };

  for (const required of ['resume', 'title', 'employer']) {
    if (!values[required] || !values[required].trim()) throw new UsageError(`--${required} is required.`);
  }
  if (values['job-url']) {
    throw new UsageError('--job-url is not supported yet (reading a posting from its URL is milestone M4). Use --job-file or --job-text.');
  }
  const sources = ['job-file', 'job-text'].filter((k) => values[k] !== undefined);
  if (sources.length !== 1) throw new UsageError('Give exactly one of --job-file or --job-text.');

  return {
    command: 'tailor',
    options: {
      resume: values.resume,
      title: values.title.trim(),
      employer: values.employer.trim(),
      jobFile: values['job-file'],
      jobText: values['job-text'],
      out: values.out || 'tailorune-out',
      constraints: values.constraints,
      coverLetter: !values['no-cover'],
      pdf: !values['no-pdf'],
      judge: values.judge,
    },
  };
}


function readJob({ jobFile, jobText }) {
  const text = jobFile !== undefined ? readFileSync(jobFile, 'utf8') : jobText;
  if (!text || !text.trim()) throw new UsageError('The job description is empty.');
  if (text.length > MAX_JOB_CHARS) throw new UsageError(`The job description is over ${MAX_JOB_CHARS} characters.`);
  return text;
}

function readResume(file) {
  const ext = path.extname(file).toLowerCase();
  if (!RESUME_EXTENSIONS.has(ext)) throw new UsageError(`--resume must be a .txt, .docx or .pdf file, not "${ext || 'no extension'}".`);
  if (statSync(file).size > MAX_RESUME_BYTES) throw new UsageError('--resume is over 2 MB.');
  return { resumeFileBase64: readFileSync(file).toString('base64'), resumeFileExt: ext };
}

function readConstraints(file) {
  if (!file) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new UsageError(`--constraints is not valid JSON: ${err.message}`);
  }
  try {
    return validatePreferences(raw);
  } catch (err) {
    if (err instanceof PreferenceError) throw new UsageError(`--constraints: ${err.message}`);
    throw err;
  }
}

function writeOutputs(outputs, outDir) {
  mkdirSync(outDir, { recursive: true });
  return outputs.map((o) => {
    const filePath = path.resolve(outDir, o.filename);
    writeFileSync(filePath, Buffer.from(o.base64, 'base64'));
    return { kind: o.kind, name: o.filename, path: filePath };
  });
}

/**
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const fail = (code, message) => {
    stderr.write(`${JSON.stringify({ status: 'error', error: message })}\n`);
    return code;
  };

  let request;
  let keys = {};
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.command === 'help') {
      stdout.write(USAGE);
      return 0;
    }
    const { options } = parsed;

    if (!env.TAILORUNE_SKIP_ENV_FILES) loadEnvFiles();
    keys = providerKeysFromEnv(env);
    if (!Object.keys(keys).length) {
      throw new UsageError(`No provider key found. Set ${Object.values(PROVIDER_ENV).join(', ')} in the environment, `
        + 'or in .env.local (gitignored), or point TAILORUNE_ENV_FILE at a file that has them.');
    }

    const [providerId] = Object.keys(keys);
    request = {
      options,
      payload: {
        ...readResume(options.resume),
        jobDescription: readJob(options),
        jobTitle: options.title,
        employer: options.employer,
        preferences: readConstraints(options.constraints),
        providerId,
        apiKey: keys[providerId],
        providerKeys: keys,
        includeCoverLetter: options.coverLetter,
        autoDownloadPdf: options.pdf,
        useJudge: options.judge,
        // Points every provider at one OpenAI-compatible endpoint: the test
        // suite's local mock, or a self-hosted model. Not for normal use.
        baseUrlOverride: env.TAILORUNE_LLM_BASE_URL || undefined,
      },
    };
  } catch (err) {
    if (err instanceof UsageError) return fail(2, `${err.message}\n\n${USAGE}`);
    if (err && err.code === 'ENOENT') return fail(2, `File not found: ${err.path}`);
    throw err;
  }

  let result;
  try {
    result = await runTailorPipeline(request.payload, nodePlatform);
  } catch (err) {
    return fail(1, redact((err && err.message) || err, keys));
  }
  if (!result || !result.ok) return fail(1, redact((result && result.error) || 'The run failed.', keys));

  const files = writeOutputs(result.outputs, request.options.out);
  const summary = summarizeRun(result, {
    job: { title: request.options.title, employer: request.options.employer },
    files,
  });
  stdout.write(`${redact(JSON.stringify(summary, null, 2), keys)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
