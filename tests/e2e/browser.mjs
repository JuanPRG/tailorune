// browser.mjs — the one place that decides how the test browser launches.
//
// Every extension e2e test used to carry its own `headless: false`, eight
// copies of the same decision, and running the suite threw eight Chrome
// windows in front of whoever was working.
//
// THE TWO THINGS THAT MAKE HEADLESS WORK, both established by direct
// experiment rather than from documentation:
//
//   1. `headless: true` ALONE DOES NOT WORK. Playwright's default headless
//      chromium is a separate `chromium_headless_shell` binary with no
//      extension support at all, so `--load-extension` is silently ignored
//      and the MV3 service worker never starts: the failure surfaces as
//      `waitForEvent("serviceworker")` timing out, which reads like a broken
//      extension rather than a browser that never loaded one.
//
//      `channel: 'chromium'` selects the FULL Chromium build, which runs
//      --headless=new and does support extensions. `channel: 'chrome'` --
//      stock Chrome -- does not, and fails the same silent way.
//
//   2. chrome.action.openPopup() STILL WORKS. That was the real doubt: the
//      browser-action popup needs a focused browser window to anchor to, and
//      "headless" sounds like exactly the thing that removes it. Measured on
//      both: the popup appears as a CDP target in new headless just as it
//      does headed, and realPopup.mjs needs no change beyond this module.
//
// Set TAILORUNE_HEADED=1 to watch a run. Worth keeping and worth using: more
// than one bug in this suite was found by seeing the popup misbehave rather
// than by reading an assertion, and a test that only ever runs invisibly is
// a test nobody ever looks at.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The unpacked extension every test loads. */
export const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

export const HEADED = process.env.TAILORUNE_HEADED === '1';

/**
 * Spread into chromium.launchPersistentContext options.
 *
 * `channel` is not optional -- see note 1 above. Dropping it does not make
 * the tests headed, it makes them fail obscurely.
 */
export const BROWSER = {
  headless: !HEADED,
  channel: 'chromium',
};
