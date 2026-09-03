// realPopup.mjs — drive the ACTUAL browser-action popup, not popup.html
// loaded as an ordinary tab.
//
// Every other e2e test here navigates a normal tab to
// chrome-extension://<id>/popup/popup.html. That is convenient and wrong in
// one specific way: it is a different rendering context from the real popup,
// and behaviours diverge between them. window.prompt() works in a tab and
// silently dismisses the real popup, which is how a "save" button that saved
// nothing passed a full green suite.
//
// The mechanism: Chrome exposes the popup as a normal CDP page target, so
// launching with --remote-debugging-port and reconnecting over CDP yields a
// real Playwright Page backed by the real popup.
//
// Two constraints come with it, both inherent rather than incidental:
//
//   1. The popup is opened by chrome.action.openPopup(), so there is no
//      query string -- the ?llmBaseUrlOverride= hook other tests rely on is
//      unavailable. Real-popup tests therefore cover everything up to, but
//      not including, an LLM call.
//   2. The popup is DESTROYED the moment it loses focus (verified directly).
//      Nothing in a real-popup test may focus another window or tab.
//
// It does NOT follow that any of this needs a visible browser. The popup
// wants a focused WINDOW, which new headless still has -- chrome.action
// .openPopup() was measured working headless, and the launch options come
// from browser.mjs like every other test's. See that file for why headless
// needs `channel: 'chromium'` rather than `headless: true` alone.

import { chromium } from 'playwright';
import { BROWSER } from './browser.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

/** Distinct port per process so parallel runs cannot collide. */
function debugPort() {
  return 9400 + (process.pid % 500);
}

/**
 * Launch Chrome, open the real popup, and hand back a Page driving it.
 *
 * @returns {Promise<{popup: import('playwright').Page, sw: any, context: any}>}
 */
/**
 * @param {object} [opts]
 * @param {string} [opts.hostUrl]  page to leave in front of the popup. The
 *   popup reads the ACTIVE tab, so anything testing that needs a real page
 *   there rather than the placeholder.
 * @param {(sw: any) => Promise<void>} [opts.beforeOpen]  runs with the
 *   service worker once it exists but BEFORE the popup is opened -- the only
 *   window in which to observe what the popup does on load.
 */
export async function openRealPopup(t, { hostUrl, beforeOpen } = {}) {
  const port = debugPort();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-e2e-popup-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...BROWSER,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-first-run',
      `--remote-debugging-port=${port}`,
    ],
  });

  let cdpBrowser;
  t.after(async () => {
    try { await cdpBrowser?.close(); } catch { /* already gone */ }
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');

  // chrome.action.openPopup() needs a normal focused window to anchor to --
  // and that window is also the tab the extension will read a job from, so
  // tests that care about extraction pass their own URL.
  const host = await context.newPage();
  if (hostUrl) await host.goto(hostUrl);
  else await host.setContent('<h1>host page</h1>');
  await host.bringToFront();

  if (beforeOpen) await beforeOpen(sw);

  await sw.evaluate(() => chrome.action.openPopup());

  // The popup target appears asynchronously; poll rather than sleep blindly.
  const deadline = Date.now() + 10000;
  let popup = null;
  while (Date.now() < deadline && !popup) {
    cdpBrowser = cdpBrowser || await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    popup = cdpBrowser.contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('/popup/popup.html')) || null;
    if (!popup) await new Promise((r) => setTimeout(r, 200));
  }
  if (!popup) throw new Error('the real browser-action popup never appeared as a CDP target');

  return { popup, sw, context, host };
}

/**
 * Poll the extension's stored state until `predicate` accepts it.
 *
 * Deliberately not page.waitForFunction(): an async callback there resolves to
 * a Promise, which is truthy on the very first poll, so the wait returns
 * before the value it is waiting for actually exists. Reading through the
 * service worker in a plain loop has no such trap, and checks the real store
 * rather than a DOM value that is about to be discarded.
 */
export async function waitForStorage(sw, key, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readStorage(sw, key);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`storage key "${key}" never satisfied the predicate; last value: ${JSON.stringify(last)}`);
}

/** Read the extension's own stored state, from the service worker. */
export async function readStorage(sw, key) {
  return sw.evaluate(async (k) => {
    const result = await chrome.storage.local.get(k);
    return result[k] ?? null;
  }, key);
}
