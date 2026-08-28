// manifestHosts.test.mjs — the provider registry and the manifest must agree.
//
// This is a release-safety check, not a unit test of behaviour.
//
// The rotation in providers.js is expected to change over time: models come
// and go, and the battle-tested list in ~/.hirepilot/.env is maintained by
// hand. Adding a MODEL to a provider already in the manifest is free. Adding a
// PROVIDER is not — MV3 blocks any request to a host outside
// `host_permissions`, and the extension would fail every call to it with no
// hint as to why, because the failure looks like a network error rather than a
// missing permission.
//
// Worse, it is exactly the kind of mistake that survives review: the code
// looks right, the tests pass, and the break only appears once a user's
// rotation reaches the new provider. So the two files are compared here
// instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROVIDERS, TASK_MODEL_POLICY } from '../../extension/engine/providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../extension/manifest.json'), 'utf8'),
);

/** Does an MV3 match pattern cover this origin? */
function patternCovers(pattern, url) {
  const { protocol, hostname } = new URL(url);
  const m = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(pattern);
  if (!m) return false;
  const [, patternScheme, patternHost] = m;
  if (patternScheme !== '*' && `${patternScheme}:` !== protocol) return false;
  if (patternHost === '*') return true;
  if (patternHost.startsWith('*.')) {
    const suffix = patternHost.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === patternHost;
}

test('every provider in the registry has a matching host permission', () => {
  const patterns = manifest.host_permissions || [];
  const missing = Object.entries(PROVIDERS)
    .filter(([, provider]) => !patterns.some((p) => patternCovers(p, provider.baseUrl)))
    .map(([id, provider]) => `${id} (${new URL(provider.baseUrl).host})`);

  assert.deepEqual(
    missing, [],
    `these providers cannot be reached — add their hosts to manifest.json host_permissions: ${missing.join(', ')}`,
  );
});

test('no host permission is granted that no provider uses', () => {
  // The other direction, and a real one for a resume tool: a stale permission
  // is a capability the extension does not need, and reviewers and users both
  // read the permission list as a statement of what it talks to.
  const baseUrls = Object.values(PROVIDERS).map((p) => p.baseUrl);
  const unused = (manifest.host_permissions || [])
    .filter((pattern) => !baseUrls.some((url) => patternCovers(pattern, url)));

  assert.deepEqual(unused, [], `unused host permissions should be removed: ${unused.join(', ')}`);
});

test('every model named in a task policy exists in some provider pool', () => {
  // A preferred model that is in no pool is silently unreachable: the policy
  // ranks it first and rotation never has an entry to rank. This is the shape
  // of typo that produces "why is it not using the model I chose".
  const pooled = new Set(Object.values(PROVIDERS).flatMap((p) => p.models));

  for (const [task, policy] of Object.entries(TASK_MODEL_POLICY)) {
    for (const model of policy.preferred) {
      assert.ok(
        pooled.has(model),
        `${task} prefers "${model}", which is in no provider's pool — it can never be selected`,
      );
    }
  }
});

test('an excluded model is either pooled or harmlessly absent, never contradictory', () => {
  // Excluding a model that is not pooled is fine (it documents a decision),
  // but a model must not be both excluded for a task AND preferred for it.
  for (const [task, policy] of Object.entries(TASK_MODEL_POLICY)) {
    const contradictory = policy.preferred.filter((m) => policy.excluded.includes(m));
    assert.deepEqual(contradictory, [], `${task} both prefers and excludes: ${contradictory.join(', ')}`);
  }
});
