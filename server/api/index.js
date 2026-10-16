// api/index.js — the one Vercel function. vercel.json rewrites every path
// here (carrying the original as ?path=), and the handler routes it.

import { handleProbe } from '../http/probe.js';

export const GET = (request) => handleProbe(request);
export const POST = (request) => handleProbe(request);
export const PUT = (request) => handleProbe(request);
export const DELETE = (request) => handleProbe(request);
