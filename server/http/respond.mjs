// server/http/respond.mjs — the API's response envelope and error type.
//
// Every JSON response is {ok, data, error}. An ApiError carries the HTTP
// status with it, so a validator deep in a call can say "413" without
// knowing anything about Responses.

export class ApiError extends Error {
  constructor(status, message, { headers, kind } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.headers = headers || {};
    this.kind = kind;
  }
}

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});
export const ok = (data, status = 200) => json(status, { ok: true, data, error: null });
export const fail = (status, error, headers) => json(status, { ok: false, data: null, error }, headers);

/** Vercel rewrites send every path to one function, carrying the original as ?path=. */
export function routePath(url) {
  const rewritten = url.searchParams.get('path');
  const raw = rewritten !== null ? `/${rewritten}` : url.pathname;
  return raw.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

/** Reads a JSON object body, refusing anything over `maxBytes` before parsing it. */
export async function readJsonBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError(413, 'Request body is too large.');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new ApiError(413, 'Request body is too large.');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'Request body must be a JSON object.');
  return body;
}
