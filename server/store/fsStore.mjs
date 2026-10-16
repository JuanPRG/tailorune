// server/store/fsStore.mjs — the API's storage, on local disk.
//
// One small interface the rest of the server depends on, so M5 can put
// Vercel Blob/KV behind the same calls without touching the API or the
// runner. Records are JSON files, one per resume / run / audit, plus raw
// bytes for generated files:
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
//
// Personal scale on purpose: listing reads every record. That is a few
// hundred small files a year, not a reason for an index.

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ID = /^(res|run)_[A-Za-z0-9]{16,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

function checked(value, pattern, what) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

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

  const recordFile = (dir, id) => path.join(dir, `${checked(id, ID, 'id')}.json`);
  const blobFiles = (token) => {
    const t = checked(token, TOKEN, 'file token');
    return { bin: path.join(dirs.files, `${t}.bin`), meta: path.join(dirs.files, `${t}.json`) };
  };

  return {
    putResume: (r) => atomicWrite(recordFile(dirs.resumes, r.resume_id), JSON.stringify(r)),
    getResume: (id) => (ID.test(id) ? readJson(recordFile(dirs.resumes, id)) : null),
    listResumes: () => listJson(dirs.resumes),
    deleteResume: (id) => remove(recordFile(dirs.resumes, id)),

    putRun: (r) => atomicWrite(recordFile(dirs.runs, r.run_id), JSON.stringify(r)),
    getRun: (id) => (ID.test(id) ? readJson(recordFile(dirs.runs, id)) : null),
    listRuns: () => listJson(dirs.runs),
    deleteRun: (id) => remove(recordFile(dirs.runs, id)),

    putAudit: (a) => atomicWrite(recordFile(dirs.audit, a.run_id), JSON.stringify(a)),
    getAudit: (runId) => (ID.test(runId) ? readJson(recordFile(dirs.audit, runId)) : null),
    listAudits: () => listJson(dirs.audit),
    deleteAudit: (runId) => remove(recordFile(dirs.audit, runId)),

    async putFile(token, bytes, meta) {
      const f = blobFiles(token);
      await atomicWrite(f.bin, bytes);
      await atomicWrite(f.meta, JSON.stringify(meta));
    },
    async getFile(token) {
      if (!TOKEN.test(token)) return null;
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
    listFileMetas: async () => {
      await ensureDirs();
      const names = (await readdir(dirs.files)).filter((n) => n.endsWith('.json'));
      const metas = await Promise.all(names.map(async (n) => ({
        token: n.slice(0, -'.json'.length),
        meta: await readJson(path.join(dirs.files, n)),
      })));
      return metas.filter((m) => m.meta);
    },
    async deleteFile(token) {
      const f = blobFiles(token);
      await Promise.all([remove(f.bin), remove(f.meta)]);
    },
  };
}
