// server/http/validate.mjs — what a resume upload and a run request may contain.
//
// Strict on purpose: an unknown field is a 400 that names it, never ignored.
// An agent that misspells `job_tilte` should hear about it on the first call,
// not discover weeks later that every letter went out with no title.

import { validatePreferences, PreferenceError } from '../../extension/engine/preferences.js';
import { ApiError } from './respond.mjs';

export const LIMITS = Object.freeze({
  resumeBytes: 2 * 1024 * 1024,
  resumeTextChars: 200_000,
  jobTextChars: 50_000,
  titleChars: 200,
  maxWaitSeconds: 120,
});

const RESUME_EXTENSIONS = new Set(['.txt', '.docx', '.pdf']);

function rejectUnknown(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k)).sort();
  if (unknown.length) throw new ApiError(400, `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
}

function requiredString(body, field, maxChars) {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${field} is required and must be a non-empty string.`);
  if (value.length > maxChars) throw new ApiError(413, `${field} is over ${maxChars} characters.`);
  return value.trim();
}

function optionalBoolean(body, field, fallback) {
  if (body[field] === undefined) return fallback;
  if (typeof body[field] !== 'boolean') throw new ApiError(400, `${field} must be true or false.`);
  return body[field];
}

/**
 * @returns {{ filename: string, ext: string, text?: string, bytes?: Uint8Array }}
 */
export function validateResumeUpload(body) {
  rejectUnknown(body, ['filename', 'text', 'content_base64']);
  const filename = requiredString(body, 'filename', LIMITS.titleChars);
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (!RESUME_EXTENSIONS.has(ext)) throw new ApiError(400, 'filename must end in .txt, .docx or .pdf.');

  const hasText = body.text !== undefined;
  const hasBytes = body.content_base64 !== undefined;
  if (hasText === hasBytes) throw new ApiError(400, 'Give exactly one of text or content_base64.');

  if (hasText) {
    if (typeof body.text !== 'string') throw new ApiError(400, 'text must be a string.');
    if (body.text.length > LIMITS.resumeTextChars) throw new ApiError(413, `text is over ${LIMITS.resumeTextChars} characters.`);
    if (!body.text.trim()) throw new ApiError(400, 'text is empty.');
    if (ext !== '.txt') throw new ApiError(400, 'text is for .txt resumes; send a .docx or .pdf as content_base64.');
    return { filename, ext, text: body.text };
  }

  if (typeof body.content_base64 !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(body.content_base64)) {
    throw new ApiError(400, 'content_base64 must be base64.');
  }
  const bytes = new Uint8Array(Buffer.from(body.content_base64, 'base64'));
  if (!bytes.length) throw new ApiError(400, 'content_base64 is empty.');
  if (bytes.length > LIMITS.resumeBytes) throw new ApiError(413, 'The resume file is over 2 MB.');
  return { filename, ext, bytes };
}

/**
 * @returns {{ resume_id: string, job_title: string, employer: string, job_text: string,
 *   constraints: object, cover_letter: boolean, judge: boolean, wait: number }}
 */
export function validateRunRequest(body) {
  rejectUnknown(body, [
    'resume_id', 'job_title', 'employer', 'job_text', 'job_url',
    'constraints', 'cover_letter', 'judge', 'wait',
  ]);
  const resumeId = requiredString(body, 'resume_id', 80);
  const jobTitle = requiredString(body, 'job_title', LIMITS.titleChars);
  const employer = requiredString(body, 'employer', LIMITS.titleChars);

  if (body.job_url !== undefined && body.job_text === undefined) {
    throw new ApiError(501, 'job_url is not supported yet (reading a posting from its URL is milestone M4). Send job_text.');
  }
  const jobText = requiredString(body, 'job_text', LIMITS.jobTextChars);

  let constraints = {};
  if (body.constraints !== undefined) {
    try {
      constraints = validatePreferences(body.constraints);
    } catch (err) {
      if (err instanceof PreferenceError) throw new ApiError(400, `constraints: ${err.message}`);
      throw err;
    }
  }

  let wait = 0;
  if (body.wait !== undefined) {
    if (!Number.isInteger(body.wait) || body.wait < 0 || body.wait > LIMITS.maxWaitSeconds) {
      throw new ApiError(400, `wait must be a whole number of seconds from 0 to ${LIMITS.maxWaitSeconds}.`);
    }
    wait = body.wait;
  }

  return {
    resume_id: resumeId,
    job_title: jobTitle,
    employer,
    job_text: jobText,
    constraints,
    cover_letter: optionalBoolean(body, 'cover_letter', true),
    judge: optionalBoolean(body, 'judge', false),
    wait,
  };
}
