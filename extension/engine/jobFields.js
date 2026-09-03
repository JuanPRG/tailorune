// jobFields.js — how an extracted job posting meets the fields already on screen.
//
// Split out of popup.entry.js because it is the one part of the read path with
// a failure mode that matters and no way to reach it from a test otherwise:
// activeTab is granted by a user invoking the extension from the toolbar, and
// a test can only open the real popup programmatically, so an end-to-end
// automatic read always fails in the harness whatever page is in front. That
// left the merge rule -- the rule that decides whether to overwrite something
// the user typed -- resting on inspection alone.
//
// It is a pure function over strings. No DOM, no chrome.*, and the caller
// does the assigning.

/**
 * Decide what the job fields should become after a read.
 *
 * `overwrite` is the whole difference between the button and the automatic
 * read on open:
 *
 *   BUTTON (overwrite: true) means "re-read THIS page". It replaces what is
 *   in the fields, and specifically it BLANKS a title the extractor rejected
 *   -- the extractor deliberately returns no title for a signed-in greeting
 *   or a nav label, and leaving the previous value in place would keep a
 *   rejected title alive in the field and let it reach the cover letter.
 *
 *   AUTOMATIC (overwrite: false) has no such mandate. Nobody asked, so it
 *   fills only what is empty and never blanks anything. Typing in the popup,
 *   losing focus, and coming back to find your own words replaced by the page
 *   would be the worst thing this feature could do.
 *
 * @param {{jobDescription?: string, jobTitle?: string, employer?: string}} current
 * @param {{text?: string, employer?: string, jobTitle?: string, source?: string, confidence?: string}} job
 * @param {{overwrite: boolean}} opts
 * @returns {{jobDescription: string, jobTitle: string, employer: string, note: string}}
 */
export function mergeExtractedJob(current, job, { overwrite }) {
  const has = (v) => Boolean(String(v == null ? '' : v).trim());
  const keep = (existing, found) => (overwrite && has(found) ? String(found)
    : has(existing) ? String(existing)
      : has(found) ? String(found) : '');

  const text = job && job.text;
  const title = job && job.jobTitle;
  const employer = job && job.employer;

  return {
    jobDescription: keep(current.jobDescription, text),
    // The only field that can be CLEARED, and only by an explicit re-read.
    jobTitle: overwrite ? (has(title) ? String(title) : '') : keep(current.jobTitle, title),
    employer: keep(current.employer, employer),
    note: describeExtraction(job),
  };
}

/**
 * What to tell the user about a read that found something.
 *
 * Low confidence is stated rather than hidden: the body-text fallback always
 * returns SOMETHING, so a quiet success there would be the extension inviting
 * the user to tailor against a page's navigation.
 */
export function describeExtraction(job) {
  if (!job || !String(job.text || '').trim()) return '';
  const source = job.source || 'this page';
  const titleNote = String(job.jobTitle || '').trim()
    ? ''
    : ' No usable job title found on the page — add one below if you want it on the cover letter.';
  return (job.confidence === 'high'
    ? `Read from ${source}. Looks complete.`
    : `Read from ${source} (${job.confidence || 'low'} confidence) — please check the fields below before tailoring.`)
    + titleNote;
}
