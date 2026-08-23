// store.js — chrome.storage.local wrapper for user settings.
//
// Only provider, model, and API key for now (Phase 2 scope). Per
// MIGRATION_PLAN.md §4: plaintext in chrome.storage.local, same security
// class as v4's plaintext ~/.hirepilot/.env — not a regression in kind.
// This module only runs in an extension context (chrome.storage.local),
// so it is exercised by the Playwright e2e test, not node:test.

const KEY = 'tailorune_settings_v1';

/** @returns {Promise<{provider: string, model: string, apiKey: string} | null>} */
export async function getSettings() {
  const result = await chrome.storage.local.get(KEY);
  return result[KEY] || null;
}

export async function setSettings(settings) {
  await chrome.storage.local.set({ [KEY]: settings });
}
