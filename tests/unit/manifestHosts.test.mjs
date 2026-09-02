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
import {
  PROVIDERS, TASK_MODEL_POLICY, ROUTES, DEPRECATED_MODEL_IDS, modelsForProvider,
} from '../../extension/engine/providers.js';

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

test('every model named in a task policy is reachable through some route', () => {
  // A preferred model that no route can reach is silently unreachable: the
  // policy ranks it first and rotation never has an entry to rank. This is the
  // shape of typo that produces "why is it not using the model I chose".
  //
  // Two legitimate exceptions, and they are the reason this is not a strict
  // membership check:
  //
  //   - a RETIRED model. The .env still ranks ling-3.0-flash:free, and v4
  //     drops it at load. Ranking a model that never appears is harmless.
  //   - a model reachable in principle but not named by the task's own chain.
  //     `gemini-2.5-flash` is ranked last for JSON and is in no chain, which
  //     is the .env recording a preference order, not a promise of presence.
  //
  // What would be a real bug is a preferred model that is a TYPO -- reachable
  // through no route at all and not deliberately retired.
  const routable = new Set(Object.keys(PROVIDERS).flatMap((id) => modelsForProvider(id)));
  const knownUnreachable = new Set([
    ...DEPRECATED_MODEL_IDS,
    'gemini-2.5-flash', // ranked by the .env, named by no chain
  ]);

  for (const [task, policy] of Object.entries(TASK_MODEL_POLICY)) {
    for (const model of policy.preferred) {
      assert.ok(
        routable.has(model) || knownUnreachable.has(model),
        `${task} prefers "${model}", which no route can reach and which is not a known-retired id — likely a typo`,
      );
    }
  }
});

test('every route model is reachable via its provider, so ROUTES and PROVIDERS agree', () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    const reachable = modelsForProvider(route.providerId);
    for (const model of route.models) {
      if (DEPRECATED_MODEL_IDS.has(model)) continue;
      assert.ok(
        reachable.includes(model),
        `route "${name}" names ${model}, which modelsForProvider('${route.providerId}') does not report`,
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
