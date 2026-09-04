// content/extractJob.js — reads the job posting off the current tab.
//
// Ported from hirepilot_v4/extension/content.js's JD-extraction half. That
// file also carried the whole autofill stack; only four references coupled
// the two (all in its message listener), so the extraction logic itself came
// across cleanly and the autofill parts are simply absent here.
//
// This is NOT autofill. It reads a page; it never writes to one. That
// distinction matters for permissions: this needs only `activeTab` +
// `scripting` — `activeTab` is user-gesture-gated, granting access to the
// current tab solely because the user clicked the extension's own button —
// whereas autofill needs broad, persistent content-script access. Conflating
// the two is why this feature was initially dropped along with autofill.
//
// Zero LLM calls: everything here is structured data and DOM heuristics.
//
// `var`, not `const`/`let`, for top-level bindings: this file has no
// manifest `content_scripts` entry and is injected on demand via
// chrome.scripting.executeScript, landing in the same persistent isolated
// world each time. A top-level `const` throws "Identifier has already been
// declared" on a second injection into the same tab; `var` re-declares
// safely.

var _MIN_JSON_LD_DESCRIPTION_LENGTH = 100;
var _MIN_JD_CONTAINER_TEXT_LENGTH = 40;
var _DOM_WAIT_TIMEOUT_MS = 1500;
var _JOB_BOARD_NAMES = ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'monster', 'dice'];
var _INDEED_DETAIL_ROOT_SELECTOR = '[data-testid="viewjob-main-content"]';

var _JD_CONTAINER_SELECTORS = [
  '#job-details',
  '.job-description',
  '[data-automation="job-description"]',
  '.description__text',
  '#jobDescriptionText',            // Indeed
  '.show-more-less-html__markup',   // LinkedIn
  '.app-description',
];

var _EMPLOYER_PLATFORM_SELECTORS = [
  // LinkedIn
  '.topcard__org-name-link',
  '.job-details-jobs-unified-top-card__company-name a',
  '.jobs-unified-top-card__company-name a',
  // Indeed
  '[data-testid="inlineHeader-companyName"] a',
  '[data-testid="inlineHeader-companyName"]',
  '.jobsearch-InlineCompanyRating-companyHeader a',
  // Glassdoor
  '.employerName',
  '[data-test="employer-name"]',
  // Lever
  '.posting-categories .sort-by-team .posting-category',
  '.main-header-logo img[alt]',
  // Greenhouse
  '.company-name',
  '#header .company-name',
  // Workday
  '[data-automation-id="company-name"]',
  // Generic career pages
  '[class*="company-name"]',
  '[class*="employer"]',
];

// ── JSON-LD ────────────────────────────────────────────────────────────────

function _hasJobPostingType(value) {
  if (!value || typeof value !== 'object') return false;
  const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  return types.includes('JobPosting');
}

function _findJsonLdJobPosting(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const posting = _findJsonLdJobPosting(item);
      if (posting) return posting;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  if (_hasJobPostingType(value)) return value;
  if (Array.isArray(value['@graph'])) return _findJsonLdJobPosting(value['@graph']);
  return null;
}

function _extractJsonLdJobPosting() {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const posting = _findJsonLdJobPosting(JSON.parse(script.textContent));
      if (posting) return posting;
    } catch (e) { /* malformed JSON-LD, skip */ }
  }
  return null;
}

/**
 * schema.org's JobPosting.description is usually an HTML string, and
 * innerText only inserts line breaks between block elements once the
 * browser has actually laid the node out — a detached element collapses
 * everything onto one run-on line. So the container is appended off-screen
 * just long enough to read innerText, then removed.
 */
function _htmlToPlainText(html) {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.innerHTML = html;
  document.body.appendChild(container);
  const text = container.innerText || container.textContent || '';
  container.remove();
  return text.trim();
}

// ── Async DOM wait ─────────────────────────────────────────────────────────

/**
 * Resolve as soon as `check()` returns something truthy, or after the
 * timeout. Split-view job boards (Indeed, LinkedIn search results) keep one
 * URL while the detail pane is re-populated via XHR each time a listing is
 * selected, so a single synchronous read can land before the content exists.
 * MutationObserver rather than polling: the common case resolves with no
 * added latency, and only a page that never produces a match pays the wait.
 */
function _waitForDom(check) {
  return new Promise((resolve) => {
    const immediate = check();
    if (immediate) { resolve(immediate); return; }

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(value);
    };
    const observer = new MutationObserver(() => {
      const result = check();
      if (result) settle(result);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => settle(check()), _DOM_WAIT_TIMEOUT_MS);
  });
}

// ── Small DOM helpers ──────────────────────────────────────────────────────

function _elementText(element) {
  return ((element && (element.innerText || element.textContent)) || '').replace(/\r/g, '').trim();
}

function _queryFirst(scope, selectors) {
  for (const selector of selectors) {
    const element = scope && scope.querySelector && scope.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function _isIndeedPage() {
  const hostname = String((globalThis.location && globalThis.location.hostname) || '').toLowerCase();
  return hostname === 'indeed.com' || /(^|\.)indeed\.[a-z.]+$/.test(hostname);
}

function _stripSectionHeading(text, heading) {
  const value = String(text || '').trim();
  const label = String(heading || '').trim();
  if (!label) return value;
  const lines = value.split('\n');
  if (lines[0] && lines[0].trim().toLowerCase() === label.toLowerCase()) lines.shift();
  return lines.join('\n').trim();
}

// ── Indeed adapter ─────────────────────────────────────────────────────────

/**
 * Read only the SELECTED Indeed detail pane. A search-results page contains
 * many company-name nodes, so every selector here is scoped to the focused
 * job rather than the document.
 */
function _extractIndeedSelectedJob() {
  const detailRoot = document.querySelector(_INDEED_DETAIL_ROOT_SELECTOR);
  const scope = detailRoot || document;

  const employerElement = _queryFirst(scope, [
    '[data-testid="company-info-metadata"] a[href*="/cmp/"]',
    '[data-testid="inlineHeader-companyName"] a',
    '[data-testid="inlineHeader-companyName"]',
    '.jobsearch-InlineCompanyRating-companyHeader a',
  ]);
  // NO unscoped 'h1' here. `scope` falls back to `document` when the detail
  // pane selector misses, and on ca.indeed.com/?vjk=... -- the HOMEPAGE with
  // a job in a side pane, not /viewjob -- the page's own h1 is the signed-in
  // greeting. That is where "Welcome, Juan" came from. An h1 is only the job
  // when it is inside the job's own pane.
  const titleElement = detailRoot
    ? _queryFirst(scope, ['[data-testid="vj-job-title"]', '[data-testid="company-info-title-row"]', 'h1'])
    : _queryFirst(scope, ['[data-testid="vj-job-title"]', '[data-testid="company-info-title-row"]']);
  const descriptionElement = _queryFirst(scope, [
    '#jobDescriptionText',
    '[data-testid="jobsearch-JobComponent-description"]',
  ]);
  const descriptionHeading = scope.querySelector && scope.querySelector('[data-testid="vj-job-description-heading"]');
  const descriptionScope = descriptionElement || (descriptionHeading && descriptionHeading.parentElement) || null;
  const description = _stripSectionHeading(_elementText(descriptionScope), _elementText(descriptionHeading));

  if (!description || description.length < _MIN_JD_CONTAINER_TEXT_LENGTH) return null;

  const employer = _elementText(employerElement);
  return {
    text: description,
    employer,
    jobTitle: _elementText(titleElement),
    source: detailRoot ? 'indeed_selected_pane' : 'indeed_job_page',
    confidence: employer ? 'high' : 'partial',
  };
}

function _findCompleteIndeedSelectedJob() {
  const result = _extractIndeedSelectedJob();
  return result && result.employer ? result : null;
}

// ── Description: three tiers ───────────────────────────────────────────────

function _findJdContainerText() {
  for (const selector of _JD_CONTAINER_SELECTORS) {
    const el = document.querySelector(selector);
    const text = el && el.innerText && el.innerText.trim();
    if (text && text.length >= _MIN_JD_CONTAINER_TEXT_LENGTH) return text;
  }
  return null;
}

function _bodyTextFallback() {
  const bodyClone = document.body.cloneNode(true);
  bodyClone.querySelectorAll('nav, footer, header, script, style, noscript, svg').forEach((el) => el.remove());
  return bodyClone.innerText.substring(0, 5000).trim();
}

async function _extractJobDescriptionResult() {
  // Tier 1: JSON-LD. Most ATS embed this for Google for Jobs indexing, so
  // it beats guessing CSS class names that change across redesigns -- and
  // it's available the moment the initial HTML parses, no waiting needed.
  const posting = _extractJsonLdJobPosting();
  if (posting && posting.description) {
    const plainText = _htmlToPlainText(posting.description);
    if (plainText.length >= _MIN_JSON_LD_DESCRIPTION_LENGTH) {
      return { text: plainText, source: 'json_ld', confidence: 'high' };
    }
  }

  // Tier 2: known container selectors -- waited for, since split-view
  // boards populate these asynchronously.
  const containerText = await _waitForDom(_findJdContainerText);
  if (containerText) {
    return { text: containerText.trim(), source: 'job_container', confidence: 'medium' };
  }

  // Tier 3: stripped body text. Always produces something, which is why
  // `confidence: 'low'` matters downstream -- the popup asks the user to
  // review rather than trusting it.
  return { text: _bodyTextFallback(), source: 'body_fallback', confidence: 'low' };
}

// ── Employer ───────────────────────────────────────────────────────────────

/**
 * Structured/reliable employer sources only. Deliberately EXCLUDES the
 * page-title heuristic: that one almost always returns something, which
 * would make `_waitForDom` resolve on its first check and never wait for a
 * detail-pane header still rendering.
 */
function _findReliableEmployerName() {
  const posting = _extractJsonLdJobPosting();
  if (posting && posting.hiringOrganization) {
    const org = posting.hiringOrganization;
    const name = typeof org === 'string' ? org : org.name;
    if (name) return String(name).trim();
  }

  const ogSiteName = document.querySelector('meta[property="og:site_name"]');
  if (ogSiteName && ogSiteName.content
      && !_JOB_BOARD_NAMES.some((b) => ogSiteName.content.toLowerCase().includes(b))) {
    return ogSiteName.content.trim();
  }

  for (const selector of _EMPLOYER_PLATFORM_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) {
      const text = el.tagName === 'IMG' ? el.alt : el.textContent;
      if (text && text.trim()) return text.trim();
    }
  }
  return null;
}

async function _extractEmployerName() {
  const reliable = await _waitForDom(_findReliableEmployerName);
  if (reliable) return reliable;

  // Last resort, not waited for (see _findReliableEmployerName's comment):
  // "Job Title at Company" / "Job Title - Company".
  const title = document.title || '';
  const atMatch = title.match(/(?:at|@)\s+([^|\-–—]+)/i);
  if (atMatch) return atMatch[1].trim();

  const dashMatch = title.match(/^[^|\-–—]+[|\-–—]\s*([^|\-–—]+)/i);
  if (dashMatch) {
    const candidate = dashMatch[1].trim();
    if (!_JOB_BOARD_NAMES.some((b) => candidate.toLowerCase().includes(b)) && candidate.length < 60) {
      return candidate;
    }
  }
  return '';
}

// ── Entry point ────────────────────────────────────────────────────────────

// A page offers plenty that is not a job title -- a signed-in greeting, a nav
// label, a banner heading. "Welcome, Juan" was scraped from a logged-in
// Indeed page and printed on a finished cover letter. This is the same
// rejection test as textUtils.js's isPlausibleJobTitle, duplicated because a
// content script is injected as a standalone file and cannot import; the
// candidate-name half of that check runs later, where the name is known.
var _TITLE_REJECT_RE = /^\s*(welcome|hello|hi|hey|dear|greetings|thanks|thank you|good (morning|afternoon|evening)|sign in|log in|apply now|save this job)\b/i;

function _plausibleJobTitle(title) {
  var text = String(title || '').trim();
  if (text.length < 2 || text.length > 100) return '';
  if (_TITLE_REJECT_RE.test(text)) return '';
  if (/[!?]/.test(text)) return '';
  if (/https?:\/\/|@/.test(text)) return '';
  return text;
}

/** Blank an untrustworthy title rather than passing it downstream. */
function _withCheckedTitle(result) {
  return Object.assign({}, result, { jobTitle: _plausibleJobTitle(result && result.jobTitle) });
}

// A page heading that is the SECTION, not the job. Whole-string matches only:
// "Careers" is not a job title, "Careers Advisor" very much is.
var _GENERIC_HEADING_RE = /^(careers?|jobs?|job search|search results|open (positions|roles)|opportunities|vacancies|job details?|job description|apply|apply now)$/i;

/**
 * The part of "Job Title - Company | Board" before the separator.
 *
 * ONLY when there IS a separator. A tab title without one is whatever the
 * site chose to call the page -- "Some Page", "Home", a product name -- and
 * accepting that put junk in the job title field on every page with no job
 * metadata, which is the same failure as the greeting it replaced. The
 * separator is the page structuring the title itself, and that structure is
 * the only reason to trust the first half of it.
 */
function _titleFromDocumentTitle() {
  var raw = String(document.title || '');
  if (!/[|–—]| - | at /.test(raw)) return '';
  return raw.split(/[|–—]| - | at /)[0].trim();
}

/**
 * The job title, from whatever the page is willing to say.
 *
 * JSON-LD was the ONLY source, which is why a posting without it produced no
 * title at all -- and why a stale one, once in the field, was never replaced
 * by anything. The description already had three tiers; the title had one.
 *
 * Ordered by how much the page is actually claiming: structured data, then
 * the social preview, then the main heading, then the tab. Every candidate
 * goes through the same plausibility check, so a greeting cannot enter here
 * either, and none may simply repeat the employer -- a heading that names the
 * company is a banner, not a role.
 *
 * TIED TO THE DESCRIPTION'S CONFIDENCE, which is the part that matters. Every
 * source below the first describes the PAGE, and on a job board's search or
 * home page the page is not the job: ca.indeed.com/?vjk=... has og:title and
 * document.title both reading "Job Search Canada | Indeed", and a signed-in
 * h1 reading "Welcome, Juan". Taking any of them would trade one wrong title
 * for another.
 *
 * A body-text fallback description is exactly the signal that no job
 * container was found, so the page's own headings are chrome. Structured data
 * still counts -- a JobPosting is a claim about the job, not the page.
 */
function _extractJobTitle(employer, descriptionResult) {
  var posting = _extractJsonLdJobPosting();
  var candidates = [];
  if (posting && typeof posting.title === 'string') candidates.push(posting.title);

  var pageIsThePosting = descriptionResult && descriptionResult.confidence !== 'low';
  if (pageIsThePosting) {
    var og = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
    if (og && og.content) candidates.push(og.content);

    var heading = document.querySelector('h1');
    if (heading && heading.textContent) candidates.push(heading.textContent);

    candidates.push(_titleFromDocumentTitle());
  }

  var company = String(employer || '').trim().toLowerCase();
  for (var i = 0; i < candidates.length; i++) {
    var candidate = _plausibleJobTitle(candidates[i]);
    if (!candidate) continue;
    if (_GENERIC_HEADING_RE.test(candidate)) continue;
    if (company && candidate.toLowerCase() === company) continue;
    if (_JOB_BOARD_NAMES.some(function (b) { return candidate.toLowerCase() === b; })) continue;
    return candidate;
  }
  return '';
}

async function extractJobContext() {
  if (_isIndeedPage()) {
    const complete = await _waitForDom(_findCompleteIndeedSelectedJob);
    const selectedJob = complete || _extractIndeedSelectedJob();
    if (selectedJob) return _withCheckedTitle(selectedJob);
    return { text: _bodyTextFallback(), employer: '', jobTitle: '', source: 'body_fallback', confidence: 'low' };
  }

  const [descriptionResult, employer] = await Promise.all([
    _extractJobDescriptionResult(),
    _extractEmployerName(),
  ]);
  return _withCheckedTitle({
    text: descriptionResult.text,
    employer,
    jobTitle: _extractJobTitle(employer, descriptionResult),
    source: descriptionResult.source,
    // Overall confidence is the description's, downgraded when no employer
    // was found -- the popup uses this to decide whether to ask for review.
    confidence: descriptionResult.confidence === 'low' ? 'low' : (employer ? 'high' : 'partial'),
  });
}

// Injected via chrome.scripting.executeScript, whose result is the value of
// the last expression evaluated -- so this promise IS the return value.
extractJobContext();
