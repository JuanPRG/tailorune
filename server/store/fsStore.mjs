// server/store/fsStore.mjs — the API's storage, on local disk (dev and tests).
//
// One interface, two implementations: this one, and blobStore.mjs for
// Vercel. tests/unit/stores.test.mjs runs the same contract against both.
// Records are JSON files, one per resume / run / audit, plus raw bytes for
// generated files:
//
//   <dir>/resumes/<resume_id>.json
//   <dir>/runs/<run_id>.json
//   <dir>/audit/<run_id>.json
//   <dir>/files/<token>.bin + <token>.json   (bytes, and their metadata)
//
// Every id is checked against a strict pattern BEFORE it becomes part of a
// path, so a crafted id ("../../x") is refused rather than resolved. Writes go
// to a temp file and are renamed into place, so a crash mid-write never
// leaves a half-written record for the next read to choke on.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ID_PATTERN, TOKEN_PATTERN, checked } from './ids.mjs';

export function createFsStore(rootDir) {
  const dirs = {
    resumes: path.join(rootDir, 'resumes'),
    runs: path.join(rootDir, 'runs'),
    audit: path.join(rootDir, 'audit'),
    files: path.join(rootDir, 'files'),
  };
  let ready = null;
  const ensureDirs = () => {
    ready = ready || Promise.all(Object.values(dirs).map((d) => mkdir(d, { recursive: true })));
    return ready;
  };

  const atomicWrite = async (file, data) => {
    await ensureDirs();
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  };
  const readJson = async (file) => {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const listJson = async (dir) => {
    await ensureDirs();
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
    const records = await Promise.all(names.map((n) => readJson(path.join(dir, n))));
    return records.filter(Boolean);
  };
  const remove = (file) => rm(file, { force: true });

  const recordFile = (dir, id) => path.join(dir, `${checked(id, ID_PATTERN, 'id')}.json`);
  const blobFiles = (token) => {
    const t = checked(token, TOKEN_PATTERN, 'file token');
    return { bin: path.join(dirs.files, `${t}.bin`), meta: path.join(dirs.files, `${t}.json`) };
  };
  const getRecord = async (dir, id) => (ID_PATTERN.test(id) ? readJson(recordFile(dir, id)) : null);

  const store = {
    putResume: async (r) => atomicWrite(recordFile(dirs.resumes, r.resume_id), JSON.stringify(r)),
    getResume: async (id) => getRecord(dirs.resumes, id),
    listResumes: async () => listJson(dirs.resumes),
    deleteResume: async (id) => remove(recordFile(dirs.resumes, id)),

    putRun: async (r) => atomicWrite(recordFile(dirs.runs, r.run_id), JSON.stringify(r)),
    getRun: async (id) => getRecord(dirs.runs, id),
    /** @param {{ sinceMs?: number }} [options] only runs updated at or after this time */
    listRuns: async ({ sinceMs } = {}) => {
      const runs = await listJson(dirs.runs);
      return sinceMs === undefined ? runs : runs.filter((r) => Date.parse(r.updated_at) >= sinceMs);
    },
    deleteRun: async (id) => remove(recordFile(dirs.runs, id)),

    putAudit: async (a) => atomicWrite(recordFile(dirs.audit, a.run_id), JSON.stringify(a)),
    getAudit: async (runId) => getRecord(dirs.audit, runId),
    listAudits: async () => listJson(dirs.audit),
    deleteAudit: async (runId) => remove(recordFile(dirs.audit, runId)),

    async putFile(token, bytes, meta) {
      const f = blobFiles(token);
      await atomicWrite(f.bin, bytes);
      await atomicWrite(f.meta, JSON.stringify(meta));
    },
    async getFile(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const f = blobFiles(token);
      const meta = await readJson(f.meta);
      if (!meta) return null;
      try {
        return { meta, bytes: new Uint8Array(await readFile(f.bin)) };
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async deleteFile(token) {
      const f = blobFiles(token);
      await Promise.all([remove(f.bin), remove(f.meta)]);
    },

    /** Deletes expired files and audit records, and runs older than the audit window. */
    async sweepExpired(nowMs, { auditTtlMs }) {
      await ensureDirs();
      const metaNames = (await readdir(dirs.files)).filter((n) => n.endsWith('.json'));
      for (const name of metaNames) {
        const meta = await readJson(path.join(dirs.files, name));
        if (meta && Date.parse(meta.expires_at) <= nowMs) await store.deleteFile(name.slice(0, -'.json'.length));
      }
      for (const audit of await listJson(dirs.audit)) {
        if (Date.parse(audit.expires_at) <= nowMs) await store.deleteAudit(audit.run_id);
      }
      for (const run of await listJson(dirs.runs)) {
        if (Date.parse(run.created_at) + auditTtlMs <= nowMs) await store.deleteRun(run.run_id);
      }
    },
  };
  return store;
}
