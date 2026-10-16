// server/store/blobStore.mjs — the API's storage on Vercel Blob, PRIVATE access only.
//
// Same interface as fsStore.mjs; tests/unit/stores.test.mjs runs one contract
// against both. Resumes are personal data, so every blob is written and read
// with access: 'private' -- there is no public URL for anything stored here,
// and the only way to a file is the API, behind the Bearer token.
//
// Layout mirrors the disk store:
//
//   resumes/<resume_id>.json   runs/<run_id>.json   audit/<run_id>.json
//   files/<token>.bin + files/<token>.json           meta/last-sweep.json
//
// Written for few operations, since Blob bills per operation:
//   - reads bypass the cache (a run's status changes while it is polled);
//   - listRuns({sinceMs}) filters on the listing's uploadedAt before reading
//     a single record, so a POST reads only the last day's runs;
//   - the retention sweep decides from listing metadata alone (files and audit
//     records are written once, so uploadedAt is their creation time), and
//     runs at most once a day across ALL instances, coordinated by a marker.

import * as blobSdk from '@vercel/blob';
import { ID_PATTERN, TOKEN_PATTERN, checked } from './ids.mjs';

const DAY_MS = 24 * 3_600_000;
const SWEEP_MARKER = 'meta/last-sweep.json';
const PRIVATE_READ = { access: 'private', useCache: false };

export function createBlobStore({ client = blobSdk } = {}) {
  const put = (pathname, body, contentType) => client.put(pathname, body, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType,
  });
  const putJson = (pathname, value) => put(pathname, JSON.stringify(value), 'application/json');

  async function getBytes(pathname) {
    let result;
    try {
      result = await client.get(pathname, PRIVATE_READ);
    } catch (err) {
      if (err && /NotFound/i.test(err.name || '')) return null;
      throw err;
    }
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Uint8Array(await new Response(result.stream).arrayBuffer());
  }
  async function getJson(pathname) {
    const bytes = await getBytes(pathname);
    return bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
  }

  /** Every listing entry under a prefix, following the cursor to the end. */
  async function listEntries(prefix) {
    const entries = [];
    let cursor;
    do {
      const page = await client.list({ prefix, cursor, limit: 1000 });
      entries.push(...page.blobs);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return entries;
  }
  const uploadedMs = (entry) => new Date(entry.uploadedAt).getTime();
  async function readAll(entries) {
    const records = await Promise.all(entries.filter((e) => e.pathname.endsWith('.json')).map((e) => getJson(e.pathname)));
    return records.filter(Boolean);
  }
  const del = async (pathnames) => { if (pathnames.length) await client.del(pathnames); };

  const recordPath = (folder, id) => `${folder}/${checked(id, ID_PATTERN, 'id')}.json`;
  const getRecord = async (folder, id) => (ID_PATTERN.test(id) ? getJson(recordPath(folder, id)) : null);
  const filePaths = (token) => {
    const t = checked(token, TOKEN_PATTERN, 'file token');
    return { bin: `files/${t}.bin`, meta: `files/${t}.json` };
  };

  return {
    putResume: async (r) => { await putJson(recordPath('resumes', r.resume_id), r); },
    getResume: async (id) => getRecord('resumes', id),
    listResumes: async () => readAll(await listEntries('resumes/')),
    deleteResume: async (id) => del([recordPath('resumes', id)]),

    putRun: async (r) => { await putJson(recordPath('runs', r.run_id), r); },
    getRun: async (id) => getRecord('runs', id),
    /** @param {{ sinceMs?: number }} [options] only runs updated at or after this time */
    listRuns: async ({ sinceMs } = {}) => {
      const entries = await listEntries('runs/');
      return readAll(sinceMs === undefined ? entries : entries.filter((e) => uploadedMs(e) >= sinceMs));
    },
    deleteRun: async (id) => del([recordPath('runs', id)]),

    putAudit: async (a) => { await putJson(recordPath('audit', a.run_id), a); },
    getAudit: async (runId) => getRecord('audit', runId),
    listAudits: async () => readAll(await listEntries('audit/')),
    deleteAudit: async (runId) => del([recordPath('audit', runId)]),

    async putFile(token, bytes, meta) {
      const p = filePaths(token);
      await put(p.bin, bytes, meta.content_type || 'application/octet-stream');
      await putJson(p.meta, meta);
    },
    async getFile(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const p = filePaths(token);
      const meta = await getJson(p.meta);
      if (!meta) return null;
      const bytes = await getBytes(p.bin);
      return bytes ? { meta, bytes } : null;
    },
    async deleteFile(token) {
      const p = filePaths(token);
      await del([p.bin, p.meta]);
    },

    async sweepExpired(nowMs, { fileTtlMs, auditTtlMs }) {
      const marker = await getJson(SWEEP_MARKER);
      if (marker && nowMs - marker.at < DAY_MS) return;

      const expired = (entries, ttl) => entries.filter((e) => uploadedMs(e) + ttl <= nowMs).map((e) => e.pathname);
      await del(expired(await listEntries('files/'), fileTtlMs));
      await del(expired(await listEntries('audit/'), auditTtlMs));
      await del(expired(await listEntries('runs/'), auditTtlMs));
      await putJson(SWEEP_MARKER, { at: nowMs });
    },
  };
}
