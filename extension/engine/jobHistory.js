// jobHistory.js — which jobs have already been tailored for.
//
// Asked for as an "already applied" alert. It is deliberately NOT that: this
// extension watches a resume get made, and then the user goes off to an
// application form it never sees. It knows you TAILORED. Claiming you applied
// would be a guess dressed as a fact, and the two mistakes do not cost the
// same -- a wrong "you applied" makes someone skip a job they wanted, while a
// missed repeat costs one duplicate document. So every rule here under-claims,
// and the wording says tailored.
//
// Pure, and separate from the popup, for the usual reason in this codebase:
// the matching rules are the part that can be wrong, and reading a tab's URL
// needs an activeTab grant a test can never obtain.

import { normalizePageUrl } from './pageIdentity.js';

export const HISTORY_KEY = 'tailorune_history_v1';

/**
 * Enough for a serious search, small enough to stay invisible.
 *
 * ~200 bytes an entry, so this is about 20KB against chrome.storage.local's
 * 10MB. The description is deliberately NOT kept -- it is the bulky part and
 * the sensitive part, and identity does not need it.
 */
export const MAX_HISTORY = 100;

/** Case and spacing are noise; two reads of one page rarely agree on them. */
function normalizeText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The two independent ways to recognise a posting.
 *
 * `url` alone is not enough: one Indeed posting is served from ca. and www.,
 * from desktop and mobile hosts, and with tracking parameters that vary by
 * how you arrived. `pair` covers those.
 *
 * `pair` REQUIRES BOTH employer and title. Either alone is a trap -- a large
 * employer posts dozens of roles, and "Backend Engineer" exists at every
 * company in the world -- and that trap is exactly the expensive mistake.
 */
function identify(job) {
  const employer = normalizeText(job && job.employer);
  const jobTitle = normalizeText(job && job.jobTitle);
  return {
    url: job && job.pageUrl ? normalizePageUrl(job.pageUrl) : '',
    pair: employer && jobTitle ? `${employer} ${jobTitle}` : '',
  };
}

/** Either signal is sufficient; neither present means no opinion. */
function isSameJob(a, b) {
  return Boolean((a.url && a.url === b.url) || (a.pair && a.pair === b.pair));
}

/** Storage is user-writable in principle and absent in practice on first run. */
function asEntries(history) {
  return Array.isArray(history) ? history : [];
}

/**
 * The history after tailoring for `job`, newest first.
 *
 * A repeat updates the existing entry rather than adding a second: the
 * question this answers is "have I done this one", and ten entries for one
 * job would answer it ten times.
 */
export function rememberTailoring(history, job) {
  const entries = asEntries(history);
  const id = identify(job);
  const previous = entries.find((entry) => isSameJob(identify(entry), id));

  const kept = entries.filter((entry) => entry !== previous);
  const entry = {
    at: job && job.at ? job.at : Date.now(),
    pageUrl: (job && job.pageUrl) || '',
    employer: (job && job.employer) || '',
    jobTitle: (job && job.jobTitle) || '',
    times: previous ? (previous.times || 1) + 1 : 1,
  };
  return [entry, ...kept].slice(0, MAX_HISTORY);
}

/**
 * The earlier run for this job, or null.
 *
 * Null is the safe answer and the one every uncertain case gets.
 */
export function findPriorTailoring(history, job) {
  const id = identify(job);
  if (!id.url && !id.pair) return null;
  const found = asEntries(history).find((entry) => isSameJob(identify(entry), id));
  return found || null;
}

/**
 * What to put in front of the user.
 *
 * `age` comes from the caller because the popup already words relative time
 * for the restored-run line, and two of those would drift apart.
 */
export function describePriorTailoring(entry, age) {
  const employer = String((entry && entry.employer) || '').trim();
  const jobTitle = String((entry && entry.jobTitle) || '').trim();
  const named = [jobTitle, employer].filter(Boolean).join(' at ');
  const times = (entry && entry.times) || 1;

  return `You already tailored ${named ? `for ${named}` : 'for this job'}`
    + `${times > 1 ? ` (${times} times)` : ''} — ${age || 'earlier.'}`;
}
