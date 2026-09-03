// run-e2e.mjs — run the e2e suite, headed only when asked.
//
// Exists because setting one environment variable is not portable in an npm
// script: `VAR=1 node ...` is a shell-ism cmd.exe does not understand, and
// the usual fix is a `cross-env` dependency. This project has two
// devDependencies and that is worth more than the six lines below.
//
// The glob is handed to Node rather than the shell: `node --test` expands
// patterns itself, so this behaves the same whichever shell invoked it.

import { spawnSync } from 'node:child_process';

const headed = process.argv.includes('--headed');

const result = spawnSync(process.execPath, ['--test', 'tests/e2e/*.test.mjs'], {
  stdio: 'inherit',
  env: headed ? { ...process.env, TAILORUNE_HEADED: '1' } : process.env,
});

process.exit(result.status ?? 1);
