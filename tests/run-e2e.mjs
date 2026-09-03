// run-e2e.mjs — run the e2e suite, headed only when asked.
//
// Exists because setting one environment variable is not portable in an npm
// script: `VAR=1 node ...` is a shell-ism cmd.exe does not understand, and
// the usual fix is a `cross-env` dependency. This project has two
// devDependencies and that is worth more than the six lines below.
//
// The glob is handed to Node rather than the shell: `node --test` expands
// patterns itself, so this behaves the same whichever shell invoked it.
//
// --- ONE FILE AT A TIME, AND IT MUST STAY THAT WAY --------------------------
//
// `node --test` runs files in parallel by default, and these files launch real
// Chrome instances. The browser-action popup is DESTROYED the moment it loses
// focus -- that is the whole reason realPopup.mjs exists -- so two browsers
// competing for OS focus kill each other's popups, and the tests driving them
// fail on assertions about a window that no longer exists.
//
// Measured, same commit, same machine:
//
//   parallel   47 pass, 4 FAIL   21s   (the 4 all pass in isolation)
//   serial     51 pass, 0 fail   81s
//
// The four were false failures. It had been showing up for a while as the
// occasional unreproducible timeout, dismissed as a one-off; a third file
// gaining real-popup tests turned it into most of a file failing.
//
// 60 seconds is a cheap price for a suite whose failures mean something.
// Grouping the focus-sensitive files and parallelising the rest would buy
// that back, and would silently rot the day someone adds a real-popup test
// to the wrong group.

import { spawnSync } from 'node:child_process';

const headed = process.argv.includes('--headed');

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/e2e/*.test.mjs'], {
  stdio: 'inherit',
  env: headed ? { ...process.env, TAILORUNE_HEADED: '1' } : process.env,
});

process.exit(result.status ?? 1);
