// make-readme-art.mjs — the two images the README uses.
//
// SEPARATE FROM THE STORE ASSETS on purpose. Those carry headline copy baked
// into the pixels ("Two documents, named for the job"), which is right for a
// listing tile and wrong directly under a paragraph that already says it --
// the reader gets the same sentence twice, once as text and once as an image.
//
// Both are rendered from the real popup.html and styles.css for the same
// reason the store shots are: a picture of the product cannot quietly stop
// matching the product.
//
//   hero.png   1200x640  one clean popup, no words but the product's own
//              NO LONGER IN THE README -- docs/img/demo.png took that slot,
//              being an animated recording of a real run rather than a staged
//              still. Kept because it is a good single-frame image for a
//              social preview or a listing, where an APNG will not animate.
//   dataflow.png 1200x372  what leaves the machine, and what does not

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = path.join(ROOT, 'extension/popup');
const OUT = path.join(ROOT, 'docs/img');

const CANVAS = '#EFE8DA';
const PINE = '#222E28';
const DEEP_JADE = '#2F7A63';
const JADE = '#51A68B';

const css = readFileSync(path.join(POPUP, 'styles.css'), 'utf8');
const html = readFileSync(path.join(POPUP, 'popup.html'), 'utf8');
const app = html.slice(html.indexOf('<div class="app">'), html.indexOf('</body>'));

const JD = 'Northwind Systems is hiring a Backend Engineer to own the services behind '
  + 'our scheduling platform. You will work in Python and Go on AWS, and share the '
  + 'on-call rotation for systems used by several thousand people a day.';

/** One popup, staged: a page has no service worker to produce this state. */
function popup({ read = true, notice = false, done = false, settings = false } = {}) {
  let s = app;
  const swap = (a, b) => { s = s.split(a).join(b); };

  swap('<div id="resumeEmpty" class="empty">', '<div id="resumeEmpty" class="empty" hidden>');
  swap('<span id="resumeMeta" class="meta-pill" hidden></span>',
    '<span id="resumeMeta" class="meta-pill">Ada_Lovelace_2026 &middot; 431 words</span>');
  swap('<option value="">No saved resumes</option>', '<option value="x">Ada_Lovelace_2026</option>');

  if (read) {
    swap('<div id="extractHint" class="hint"></div>',
      '<div id="extractHint" class="hint">Read from JSON-LD. Looks complete.</div>');
    swap('<textarea id="jobDescription" aria-label="Job description"',
      '<textarea id="jobDescription" aria-label="Job description" data-filled="1"');
  }
  if (notice) {
    swap('<div id="priorTailorNotice" class="prior-notice" hidden role="status">',
      '<div id="priorTailorNotice" class="prior-notice" role="status">'
      + 'You already tailored for Backend Engineer at Northwind Systems &mdash; 3 days ago.');
  }
  if (done) {
    swap('<div id="status"></div>',
      '<div id="status">Done &mdash; 431 words, 4 files in Downloads.\n'
      + '11s in 4 AI calls &mdash; resume 4.6s, skills 3.9s, letter 1.8s.</div>');
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

const SHELL = (w, h, theme, extraCss, body) => `<!doctype html>
<html data-theme="${theme}"><meta charset="utf-8"><style>${css}</style><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:${CANVAS};
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:${PINE}}
  .frame{width:420px;height:600px;border-radius:16px;overflow:hidden;background:var(--ground);
    box-shadow:0 24px 56px rgba(34,46,40,0.26)}
  .app{height:600px}
  ${extraCss}
</style>${body}</html>`;

const fill = async (p) => p.evaluate((jd) => {
  const q = (id) => document.getElementById(id);
  document.querySelectorAll('#jobDescription[data-filled]').forEach((el) => { el.value = jd; });
  if (q('jobTitle')) q('jobTitle').value = 'Backend Engineer';
  if (q('employer')) q('employer').value = 'Northwind Systems';
  if (q('apiKey')) q('apiKey').value = '•'.repeat(24);
  if (q('keyStatus')) { q('keyStatus').textContent = 'Gemini +1'; q('keyStatus').dataset.state = 'ready'; }
  if (q('resumeManage')) q('resumeManage').open = false;
  document.querySelectorAll('[data-filled]').forEach((el) => { el.value = jd; });
}, JD);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  // --- hero: one popup, nothing written over it --------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 640 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.setContent(SHELL(1200, 640, 'dark', `
      body{display:flex;align-items:center;justify-content:center;
        background:linear-gradient(160deg,#F4EFE4 0%,#E4DCCB 100%)}
      .frame{transform:scale(0.94)}
    `, `<div class="frame">${popup({ read: true, notice: true, done: true })}</div>`));
    await fill(p);
    await p.waitForTimeout(300);
    writeFileSync(path.join(OUT, 'hero.png'), await p.screenshot());
    console.log('  wrote docs/img/hero.png');
    await ctx.close();
  }

  // --- dataflow: the claim this product actually turns on ----------------
  //
  // NOT three screenshots of the popup. The first attempt was exactly that,
  // and the three panels were ~90% identical -- a reader learns nothing from
  // the same picture three times, and the duplicate element ids across the
  // copies meant only the first one even got its data filled.
  //
  // What is worth a picture is the sentence people actually want checked:
  // what leaves the machine, and what does not. That is prose in the README,
  // and prose is the wrong shape for it.
  {
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 372 }, deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;width:1200px;height:372px;background:${CANVAS};overflow:hidden;
        font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:${PINE}}
      .row{display:flex;align-items:center;justify-content:center;gap:0;height:300px;padding:0 46px}
      .box{border:2px solid ${PINE};border-radius:16px;padding:20px 24px;background:#FFFDF8;
        box-shadow:0 8px 20px rgba(34,46,40,0.10)}
      .box.you{width:400px}
      .box.them{width:330px}
      h3{margin:0 0 12px;font-size:19px;font-weight:700}
      ul{margin:0;padding-left:19px;font-size:15.5px;line-height:1.75;color:${DEEP_JADE}}
      .tag{display:inline-block;margin-top:14px;font-size:13px;font-weight:700;
        color:${DEEP_JADE};background:rgba(81,166,139,0.16);border-radius:999px;padding:4px 11px}
      .arrow{flex:0 0 auto;width:220px;text-align:center;padding:0 8px}
      .arrow .lbl{font-size:14.5px;font-weight:650;color:${PINE};margin-bottom:8px;line-height:1.4}
      .arrow .line{height:3px;background:${JADE};position:relative;border-radius:2px}
      .arrow .line::after{content:"";position:absolute;right:-2px;top:-6px;
        border-left:13px solid ${JADE};border-top:8px solid transparent;border-bottom:8px solid transparent}
      .arrow .key{font-size:13px;color:${DEEP_JADE};margin-top:8px;font-weight:600}
      .foot{text-align:center;font-size:16px;font-weight:650;color:${PINE};margin-top:6px}
      .foot span{color:${DEEP_JADE};font-weight:500}
    </style>
    <div class="row">
      <div class="box you">
        <h3>Your computer</h3>
        <ul>
          <li>Your resume library</li>
          <li>Your API keys</li>
          <li>Your preferences</li>
          <li>Which jobs you have tailored for</li>
        </ul>
        <div class="tag">never synced &middot; never sent to us</div>
      </div>
      <div class="arrow">
        <div class="lbl">resume text +<br>job description</div>
        <div class="line"></div>
        <div class="key">with your own key</div>
      </div>
      <div class="box them">
        <h3>The AI provider<br>you chose</h3>
        <ul>
          <li>Google Gemini</li>
          <li>Groq</li>
          <li>OpenRouter</li>
        </ul>
        <div class="tag">their privacy policy applies</div>
      </div>
    </div>
    <div class="foot">There is no Tailorune server. <span>Nothing reaches the developer, because there is nowhere for it to go.</span></div>`);
    await p.waitForTimeout(250);
    writeFileSync(path.join(OUT, 'dataflow.png'), await p.screenshot());
    console.log('  wrote docs/img/dataflow.png');
    await ctx.close();
  }
} finally {
  await browser.close();
}
