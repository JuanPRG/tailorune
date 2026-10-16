// fakeBlobClient.mjs — an in-memory @vercel/blob for the store and API tests.
//
// Faithful to the SDK semantics the Blob store relies on: private access only
// (anything else throws), no overwrite unless asked, `uploadedAt` on every
// listing entry, and listing in tiny pages so pagination is always exercised.

/** An in-memory @vercel/blob, faithful to the parts the store relies on. */
export function fakeBlobClient(clock) {
  const blobs = new Map(); // pathname -> { bytes, contentType, uploadedAt }
  const ops = { put: 0, get: 0, list: 0, del: 0 };
  const requirePrivate = (o) => { if (!o || o.access !== 'private') throw new Error('access must be private'); };
  return {
    ops,
    blobs,
    async put(pathname, body, options) {
      ops.put += 1;
      requirePrivate(options);
      if (options.addRandomSuffix !== false) throw new Error('store must disable random suffixes');
      if (blobs.has(pathname) && !options.allowOverwrite) throw new Error(`blob exists: ${pathname}`);
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      blobs.set(pathname, { bytes, contentType: options.contentType, uploadedAt: new Date(clock.ms) });
      return { pathname, url: `https://blob.example/${pathname}` };
    },
    async get(pathname, options) {
      ops.get += 1;
      requirePrivate(options);
      const b = blobs.get(pathname);
      if (!b) return null;
      return {
        statusCode: 200,
        stream: new Response(b.bytes).body,
        blob: { pathname, contentType: b.contentType, uploadedAt: b.uploadedAt },
      };
    },
    async list({ prefix = '', cursor, limit = 2 } = {}) {
      ops.list += 1;
      const all = [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + limit); // tiny pages, so pagination is exercised
      const next = start + limit;
      return {
        blobs: page.map((p) => ({ pathname: p, url: `https://blob.example/${p}`, uploadedAt: blobs.get(p).uploadedAt, size: blobs.get(p).bytes.length })),
        hasMore: next < all.length,
        cursor: next < all.length ? String(next) : undefined,
      };
    },
    async del(pathnames) {
      ops.del += 1;
      for (const p of [].concat(pathnames)) blobs.delete(p);
    },
  };
}
