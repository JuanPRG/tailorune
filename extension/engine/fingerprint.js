// fingerprint.js — a stable, non-reversible stand-in for an API key.
//
// WHY THIS EXISTS. Cooldowns and rate windows are keyed per CREDENTIAL, not
// just per model: two keys for the same model have independent quotas, so one
// exhausted credential must not sideline a model the user has another key for.
// v4 does this by putting the api_key straight into the dict key
// (llm.py:1216), which is safe there because those dicts never leave the
// process.
//
// Ours do leave. `cooldownState()` is surfaced to the popup, returned in the
// run result, and printed by the live test harness -- and the first live run
// after the key included the raw credential dumped two real API keys into a
// terminal. The harness's whole contract is that it reads keys and never
// prints them; a key embedded in a diagnostic identifier defeats that from a
// direction no amount of care at the print site can fix.
//
// So the identity of a credential is represented by a fingerprint instead.
// The raw key never enters any string that can be logged, and the property we
// actually need -- different keys produce different identifiers, the same key
// produces the same one -- is preserved.
//
// This is FNV-1a: not a cryptographic hash and not trying to be. It is a
// short identity token for high-entropy input, chosen because it needs no
// async (SubtleCrypto is promise-based, and these keys are built on hot paths
// inside synchronous map lookups).

/**
 * @param {string} apiKey
 * @returns {string} 8 hex characters, or 'none' for an absent key.
 */
export function credentialFingerprint(apiKey) {
  const text = String(apiKey ?? '');
  if (!text) return 'none';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // FNV prime, via shifts so this stays in 32-bit integer arithmetic.
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
