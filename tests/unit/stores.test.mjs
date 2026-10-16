// stores.test.mjs — the storage contract, run against BOTH stores.
//
// The API and runner depend on one interface; the local disk store
// (fsStore) and the Vercel Blob store (blobStore) must behave identically
// behind it. Every case below runs twice. The Blob store runs against an
// in-memory fake of @vercel/blob's put/get/list/del that keeps the SDK's
// semantics that matter here: private access only, no overwrite unless asked,
// `uploadedAt` on every listing entry, and paginated listing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFsStore } from '../../server/store/fsStore.mjs';
import { createBlobStore } from '../../server/store/blobStore.mjs';
import { fakeBlobClient } from './helpers/fakeBlobClient.mjs';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-16T12:00:00Z');
const TTL = { fileTtlMs: 24 * HOUR, auditTtlMs: 365 * 24 * HOUR };

const stores = {
  fs: (t, clock) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tailorune-store-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return createFsStore(dir);
  },
  // The fake's clock stamps uploadedAt, which is what the Blob store reads time from.
  blob: (t, clock) => createBlobStore({ client: fakeBlobClient(clock) }),
};

const iso = (ms) => new Date(ms).toISOString();
const resume = (id) => ({ resume_id: id, name: 'r.txt', text: 'Jordan Lee', created_at: iso(T0) });
const run = (id, ms, extra = {}) => ({
  run_id: id, status: 'done', created_at: iso(ms), updated_at: iso(ms), input: { resume_id: 'res_aaaaaaaaaaaaaaaa' }, ...extra,
});

for (const [kind, make] of Object.entries(stores)) {
  test(`${kind}: records round-trip, overwrite in place, and delete`, async (t) => {
    const clock = { ms: T0 };
    const store = make(t, clock);
    await store.putResume(resume('res_aaaaaaaaaaaaaaaa'));
    assert.equal((await store.getResume('res_aaaaaaaaaaaaaaaa')).text, 'Jordan Lee');
    assert.equal(await store.getResume('res_bbbbbbbbbbbbbbbb'), null);

    await store.putRun(run('run_aaaaaaaaaaaaaaaa', T0, { status: 'queued' }));
    await store.putRun(run('run_aaaaaaaaaaaaaaaa', T0, { status: 'done' }));
    assert.equal((await store.getRun('run_aaaaaaaaaaaaaaaa')).status, 'done');

    await store.deleteResume('res_aaaaaaaaaaaaaaaa');
    assert.equal(await store.getResume('res_aaaaaaaaaaaaaaaa'), null);
    assert.deepEqual(await store.listResumes(), []);
  });

  test(`${kind}: ids that are not ids are refused, never resolved as paths`, async (t) => {
    const store = make(t, { ms: T0 });
    assert.equal(await store.getResume('../../etc/passwd'), null);
    assert.equal(await store.getRun('run_../../x'), null);
    assert.equal(await store.getFile('../secrets'), null);
    await assert.rejects(() => store.putResume({ ...resume('res_x'), resume_id: '../evil' }));
  });

  test(`${kind}: listing pages through everything; runs can be listed by recency`, async (t) => {
    const clock = { ms: T0 };
    const store = make(t, clock);
    for (let i = 0; i < 5; i += 1) {
      clock.ms = T0 + i * HOUR;
      await store.putRun(run(`run_${String(i).repeat(16)}`, clock.ms));
    }
    assert.equal((await store.listRuns()).length, 5);
    const recent = await store.listRuns({ sinceMs: T0 + 3 * HOUR });
    assert.deepEqual(recent.map((r) => r.run_id).sort(), ['run_3333333333333333', 'run_4444444444444444']);
  });

  test(`${kind}: files keep their bytes and metadata`, async (t) => {
    const store = make(t, { ms: T0 });
    const token = 'A'.repeat(43);
    await store.putFile(token, new Uint8Array([1, 2, 3, 250]), { name: 'x.docx', content_type: 'application/x', expires_at: iso(T0 + HOUR) });
    const f = await store.getFile(token);
    assert.deepEqual([...f.bytes], [1, 2, 3, 250]);
    assert.equal(f.meta.name, 'x.docx');
    await store.deleteFile(token);
    assert.equal(await store.getFile(token), null);
  });

  test(`${kind}: the sweep removes expired files, audits and runs, and keeps the rest`, async (t) => {
    const clock = { ms: T0 };
    const store = make(t, clock);
    const fresh = 'F'.repeat(43);
    const stale = 'S'.repeat(43);
    await store.putFile(stale, new Uint8Array([1]), { name: 's', expires_at: iso(T0 + 24 * HOUR) });
    await store.putAudit({ run_id: 'run_oooooooooooooooo', created_at: iso(T0), expires_at: iso(T0 + TTL.auditTtlMs) });
    await store.putRun(run('run_oooooooooooooooo', T0));

    clock.ms = T0 + 25 * HOUR;
    await store.putFile(fresh, new Uint8Array([2]), { name: 'f', expires_at: iso(clock.ms + 24 * HOUR) });
    await store.sweepExpired(clock.ms, TTL);
    assert.equal(await store.getFile(stale), null, 'a day-old file is gone');
    assert.notEqual(await store.getFile(fresh), null, 'a fresh file stays');
    assert.notEqual(await store.getAudit('run_oooooooooooooooo'), null, 'audit kept for a year');

    clock.ms = T0 + TTL.auditTtlMs + HOUR;
    await store.sweepExpired(clock.ms, TTL);
    assert.equal(await store.getAudit('run_oooooooooooooooo'), null);
    assert.equal(await store.getRun('run_oooooooooooooooo'), null);
  });
}

test('blob: everything is private, and the sweep runs at most once a day across instances', async () => {
  const clock = { ms: T0 };
  const client = fakeBlobClient(clock); // throws on any non-private access
  const a = createBlobStore({ client });
  const b = createBlobStore({ client }); // a second "instance"

  await a.sweepExpired(clock.ms, TTL);
  const listsAfterFirst = client.ops.list;
  assert.ok(listsAfterFirst > 0, 'the first sweep lists');

  clock.ms += HOUR;
  await b.sweepExpired(clock.ms, TTL);
  assert.equal(client.ops.list, listsAfterFirst, 'another instance an hour later skips it');

  clock.ms += 24 * HOUR;
  await b.sweepExpired(clock.ms, TTL);
  assert.ok(client.ops.list > listsAfterFirst, 'a day later it sweeps again');
});
