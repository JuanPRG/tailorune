// pageIdentity.js — "is this still the same job posting?"
//
// Reported: tailor a job, move to a different posting, open the popup, and
// the whole previous run is still there -- "Re-tailor" for a job you left,
// its findings, its save-as-PDF buttons -- and the job description never
// updates until you press Reset.
//
// Nothing was wrong with any single piece of that. The popup simply had no
// way to tell "reopened on the same posting" from "moved on to another one",
// so it treated both as the former. v4 had the answer and it was omitted in
// the port: it stamped each session with `page_url` and keyed sessions per
// tab, so a different page was a different session.
//
// Shared by the service worker (which stamps a finished run) and the popup
// (which decides whether to restore one), so the two cannot disagree about
// what counts as the same page. Pure functions, no chrome.* -- which is also
// the only way this logic can be tested: reading a tab's URL needs an
// activeTab grant, and that comes from a user clicking the toolbar, never
// from the programmatic openPopup() a test has to use.

/**
 * The identity of a page, for staleness purposes.
 *
 * origin + pathname + query, dropping ONLY the hash. Ported from v4, whose
 * comment gives the reason: many job boards encode which posting you are
 * looking at entirely in the query string (Indeed's `?vjk=`), while in-page
 * anchors and tab fragments are never job identity.
 *
 * Over-strictness fails safe. If a site appends a tracking parameter that
 * varies between visits, one posting looks like two, the popup re-reads the
 * page, and the user gets the same job back -- a wasted local scrape and
 * nothing worse.
 */
export function normalizePageUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return String(value == null ? '' : value);
  }
}

/**
 * Does something saved for one page still belong to the page in front of us?
 *
 * Guards two things, and both would be the same bug without it: a finished
 * RUN (whose results must not follow the user to the next posting) and a job
 * DRAFT (whose pasted description must not either).
 *
 * FAILS OPEN, deliberately, in both unknown cases:
 *
 *   No stamp -- it was saved before these carried one. An old record is not
 *   evidence of a different job, so it is used as it always was.
 *
 *   No readable page -- a chrome:// page, the extension's own pages, or any
 *   URL the extension has no grant for. None of those is a job posting, so
 *   there is nothing newer to show, and withholding what the user had would
 *   lose them work for no reason.
 *
 * Only something stamped with a page that is definitely NOT this one is
 * withheld.
 */
export function isStampedForThisPage(saved, herePageUrl) {
  const stamped = saved && saved.pageUrl ? normalizePageUrl(saved.pageUrl) : '';
  const here = herePageUrl ? normalizePageUrl(herePageUrl) : '';
  if (!stamped || !here) return true;
  return stamped === here;
}
