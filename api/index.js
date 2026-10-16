// api/index.js — the agent API's one Vercel function. M5 of docs/AGENT_API_PLAN.md.
//
// vercel.json rewrites every path here (carrying the original as ?path=); the
// app routes it. Storage is a PRIVATE Vercel Blob store (BLOB_READ_WRITE_TOKEN
// is set when the store is connected to the project), and a queued run keeps
// going after its 202 through waitUntil, within the function's maxDuration.
//
// Secrets come from the project's environment variables only:
// TAILORUNE_API_TOKEN_SHA256 and the provider keys. See server/keys.mjs.

import { waitUntil } from '@vercel/functions';
import { createApp } from '../server/app.mjs';
import { createBlobStore } from '../server/store/blobStore.mjs';

const app = createApp({
  store: createBlobStore(),
  defer: (promise) => waitUntil(promise),
});

export const GET = (request) => app.handle(request);
export const POST = (request) => app.handle(request);
export const DELETE = (request) => app.handle(request);
