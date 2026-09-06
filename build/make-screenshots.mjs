// make-screenshots.mjs — the listing screenshots, from the real popup.
//
// The Chrome Web Store requires at least one screenshot at EXACTLY 1280x800
// or 640x400, and there were none: the store/ directory held only the two
// promo tiles, and nothing here made anything else.
//
// These are rendered from the actual popup.html and styles.css, not mocked up
// in a drawing tool, so a screenshot can never quietly stop matching the
// product. What IS faked is the state: the popup is a static document here,
// with no chrome.* APIs and no service worker, so the content that a run
// would normally produce is written into the markup before the shot.
//
// Everything below composes at 1x. deviceScaleFactor stays 1 for the same
// reason as the promo tiles: the store takes these at exact dimensions and
// rejects anything else.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = path.join(ROOT, 'extension/popup');
const OUT = path.join(ROOT, 'store');

const CANVAS = '#EFE8DA';
const PINE = '#222E28';
const DEEP_JADE = '#2F7A63';
const JADE = '#51A68B';

const css = readFileSync(path.join(POPUP, 'styles.css'), 'utf8');
const html = readFileSync(path.join(POPUP, 'popup.html'), 'utf8');
const appMarkup = html.slice(html.indexOf('<div class="app">'), html.indexOf('</body>'));

/** The popup as it looks once a resume is loaded and a posting has been read. */
function loaded({ notice = true, run = true, settings = false } = {}) {
  let s = appMarkup;
  const swap = (a, b) => { s = s.split(a).join(b); };

  // A resume is loaded, so the mascot empty state is put away.
  swap('<div id="resumeEmpty" class="empty">', '<div id="resumeEmpty" class="empty" hidden>');
  swap('<span id="resumeMeta" class="meta-pill" hidden></span>',
    '<span id="resumeMeta" class="meta-pill">Ada_Lovelace_2026 &middot; 431 words</span>');
  swap('<option value="">No saved resumes</option>',
    '<option value="x">Ada_Lovelace_2026</option>');

  swap('<div id="extractHint" class="hint"></div>',
    '<div id="extractHint" class="hint">Read from JSON-LD. Looks complete.</div>');
  swap('placeholder="Paste the job description, or read it from the current tab..."',
    'placeholder=""');
  swap('<textarea id="jobDescription" aria-label="Job description"',
    '<textarea id="jobDescription" aria-label="Job description" data-filled="1"');

  if (notice) {
    swap('<div id="priorTailorNotice" class="prior-notice" hidden role="status">',
      '<div id="priorTailorNotice" class="prior-notice" role="status">'
      + 'You already tailored for Backend Engineer at Northwind Systems &mdash; 3 days ago.');
  }
  if (run) {
    swap('<div id="status"></div>',
      '<div id="status">Done &mdash; 431 words, 4 files in Downloads.\n'
      + '11s in 4 AI calls &mdash; resume 4.6s (1 call), skills 3.9s (2 calls), letter 1.8s (1 call).</div>');
    swap('<span id="tailorBtnLabel">Tailor resume</span>',
      '<span id="tailorBtnLabel">Re-tailor</span>');
    swap('class="secondary-btn cta-reset caution" type="button" hidden',
      'class="secondary-btn cta-reset caution" type="button"');
  }
  if (settings) {
    swap('<main class="scroll" id="mainView">', '<main class="scroll" id="mainView" hidden>');
    swap('<section class="scroll settings-view" id="settingsView" hidden',
      '<section class="scroll settings-view" id="settingsView"');
  }
  return s;
}

const JD = 'Northwind Systems is hiring a Backend Engineer to own the services behind '
  + 'our scheduling platform. You will work in Python and Go on AWS, and share the '
  + 'on-call rotation for systems used by several thousand people a day.';

const SHOTS = [
  {
    name: 'screenshot-1-tailor',
    head: 'Tailored to the posting<br>in front of you.',
    sub: 'Read the job straight off the page, then rewrite your resume against it '
       + '&mdash; without inventing a thing you did not do.',
    body: loaded({ notice: false, run: false }),
    theme: 'light',
  },
  {
    name: 'screenshot-2-result',
    head: 'Two documents,<br>named for the job.',
    sub: 'A resume and a cover letter in .docx and .pdf, in your Downloads, '
       + 'named so three applications in an afternoon stay apart.',
    body: loaded({ notice: true, run: true }),
    theme: 'dark',
  },
  {
    name: 'screenshot-3-keys',
    head: 'Your key.<br>Your provider.',
    sub: 'No account, and no server of ours. Bring a free key from Gemini, Groq '
       + 'or OpenRouter and everything else stays on your machine.',
    body: loaded({ settings: true, notice: false, run: false }),
    theme: 'light',
  },
];

const page = (shot) => `<!doctype html><html data-theme="${shot.theme}"><meta charset="utf-8">
<style>${css}</style>
<style>
  html,body{margin:0;padding:0;width:1280px;height:800px;overflow:hidden;
    background:${CANVAS};font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .stage{display:flex;align-items:center;gap:70px;height:800px;padding:0 84px;box-sizing:border-box}
  .copy{flex:1 1 auto;max-width:560px}
  h1{margin:0;font-size:52px;line-height:1.12;font-weight:650;letter-spacing:-0.02em;color:${PINE}}
  p{margin:22px 0 0;font-size:21px;line-height:1.5;color:${DEEP_JADE};max-width:30ch}
  .rule{width:64px;height:6px;background:${JADE};border-radius:3px;margin-bottom:30px}
  .frame{flex:0 0 auto;width:420px;height:600px;border-radius:16px;overflow:hidden;
    background:var(--ground);box-shadow:0 26px 60px rgba(34,46,40,0.28)}
  .app{height:600px}
</style>
<div class="stage">
  <div class="copy"><div class="rule"></div><h1>${shot.head}</h1><p>${shot.sub}</p></div>
  <div class="frame">${shot.body}</div>
</div></html>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    });
    const p = await ctx.newPage();
    await p.setContent(page(shot));
    // The job description is a textarea: its text is a property, not markup.
    await p.evaluate((jd) => {
      const el = document.getElementById('jobDescription');
      if (el && el.dataset.filled) el.value = jd;
      const t = document.getElementById('jobTitle');
      const e = document.getElementById('employer');
      if (t) t.value = 'Backend Engineer';
      if (e) e.value = 'Northwind Systems';
      const k = document.getElementById('apiKey');
      if (k) k.value = '••••••••••••••••••••••••';
      const pill = document.getElementById('keyStatus');
      if (pill) { pill.textContent = 'Gemini +1'; pill.dataset.state = 'ready'; }
      const mg = document.getElementById('resumeManage');
      if (mg) mg.open = false;
    }, JD);
    await p.waitForTimeout(250);
    writeFileSync(path.join(OUT, `${shot.name}.png`), await p.screenshot());
    console.log(`  wrote store/${shot.name}.png`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
