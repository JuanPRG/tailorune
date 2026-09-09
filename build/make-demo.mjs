// make-demo.mjs — record the real extension doing a real run, as an APNG.
//
//   TAILORUNE_ENV_FILE=~/.hirepilot/.env node build/make-demo.mjs
//
// This drives the ACTUAL unpacked extension in Chromium and makes REAL calls
// to a real provider with the user's own key. Nothing about the tailored text
// is staged: what the recording shows is what the model returned.
//
// A STORYBOARD, NOT A VIDEO. Twelve frames held about a second each, rather
// than 30fps of the same thing. A UI demo is read, not watched -- the viewer
// needs time on each state -- and it keeps the file to a few hundred KB
// instead of several MB in a README that loads on every visit.
//
// TWO THINGS IT DELIBERATELY DOES NOT SHOW.
//
// "Read job description" is absent. activeTab is granted only by a REAL
// toolbar click, never by driving the popup programmatically, so that chain
// cannot be scripted -- and staging it (filling the fields, then screenshotting
// as though the page had been read) would show a capability working when it
// had not. The job text is typed instead, which is a real supported path: the
// README already tells people to paste a posting that will not parse.
//
// The resume is a SYNTHETIC fixture -- Jordan Lee, example.com, a 555 number.
// The juan-rivera fixtures are a real person's resume and this file is
// published in a README.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApng } from './apng.mjs';
import { loadEnvFiles, PROVIDER_ENV } from '../tests/live/liveEnv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(ROOT, 'extension');
// A FULL synthetic resume, not the test fixture. jordan-lee-standard.txt is 57
// words -- fine as a parser fixture, and it tailors down to about 100 words,
// which undersells the product in the one asset most people will judge it by.
// This one is realistic in length and detail, and still obviously fictional
// (example.com, a reserved 555 number, Microsoft's sample company names).
// Named as a person would name it, because the filename IS the library
// label now and appears in the pill: "demo-resume.txt" reads as scaffolding.
const RESUME = path.join(ROOT, 'build/jordan-lee-resume.txt');
const OUT = path.join(ROOT, 'docs/img');

const JOB_TITLE = 'Senior Product Analyst';
const EMPLOYER = 'Contoso Retail';
const JOB = 'Contoso Retail is hiring a Senior Product Analyst to own the metrics behind '
  + 'our merchandising platform. You will build dashboards in SQL and Python, run '
  + 'experiments end to end, and partner with merchandising leads to turn findings into '
  + 'pricing decisions. We are looking for someone who has shortened reporting cycles and '
  + 'can show the business impact of the analysis they shipped.';

const frames = [];

// COMPOSITED, not screenshotted raw. A bare 420px popup on its own dark
// background sits badly beside hero.png and dataflow.png, which are both
// framed on the same warm canvas -- and this is the top image in the README,
// so looking out of place there costs more than the extra pixels.
//
// Done by handing the popup's own screenshot to a second page as a data URI
// and photographing that. The popup cannot simply be rendered inside a styled
// wrapper: it has to be its own extension page for chrome.* to exist at all.
//
// The backdrop is FLAT, not the gradient hero.png uses. PNG has no gradient primitive, so a
// gradient becomes dithered per-pixel noise that defeats the filters -- the
// same recording cost 882KB gradient against ~300KB flat, for a backdrop
// nobody looks at. The colour is the canvas the other README art sits on.
const CANVAS = '#EFE8DA';
const STAGE = (dataUri) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:760px;height:680px;overflow:hidden;background:${CANVAS};
    display:flex;align-items:center;justify-content:center}
  img{width:420px;height:600px;border-radius:16px;display:block;
    box-shadow:0 24px 56px rgba(34,46,40,0.26)}
</style><img src="${dataUri}">`;

let stage = null;
const shot = async (page, delayMs = 1100) => {
  const raw = await page.screenshot();
  await stage.setContent(STAGE(`data:image/png;base64,${raw.toString('base64')}`));
  frames.push({ png: await stage.screenshot(), delayMs });
  process.stdout.write(`  frame ${String(frames.length).padStart(2)}  ${delayMs}ms\n`);
};

// --- keys, from the environment only, never printed ------------------------
loadEnvFiles();
const providerKeys = Object.fromEntries(
  Object.entries(PROVIDER_ENV)
    .map(([id, envName]) => [id, (process.env[envName] || '').trim()])
    .filter(([, key]) => key),
);
if (!Object.keys(providerKeys).length) {
  console.error('No provider key in the environment. This records a REAL run, so it needs one.');
  console.error('  TAILORUNE_ENV_FILE=~/.hirepilot/.env node build/make-demo.mjs');
  process.exit(1);
}
console.log(`providers available: ${Object.keys(providerKeys).join(', ')}\n`);

mkdirSync(OUT, { recursive: true });

// A FRESH PROFILE EVERY RUN, for two reasons. The recording opens on the empty
// state, and a profile that already holds Jordan Lee in its library does not
// have one -- frame 1 would silently become "a resume is already loaded". And
// re-launching onto the previous run's directory closed the page before the
// first screenshot could be taken.
const userDataDir = path.join(ROOT, '.demo-profile');
rmSync(userDataDir, { recursive: true, force: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,          // an extension's service worker needs a real browser
  viewport: { width: 420, height: 600 },
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    '--no-first-run',
  ],
});

try {
  // The service worker is the only context that can write chrome.storage before
  // the popup opens, which is the order that matters: restoreSettings() reads
  // the keys on load, so seeding afterwards would be overwritten by the
  // popup's own persist of its then-empty fields.
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  await sw.evaluate(async (settings) => {
    await chrome.storage.local.set({ tailorune_settings_v1: settings });
  }, {
    provider: 'gemini',
    model: '',
    apiKey: '',
    providerKeys,
    includeCoverLetter: true,
    useJudge: false,
    autoDownloadPdf: true,
    theme: 'dark',
    preferences: {
      resume_density: 'detailed',
      keyword_alignment: 'balanced',
      cover_letter_length: 'standard',
      cover_letter_tone: 'direct',
      preserve_points: '',
      resume_notes: '',
      cover_letter_notes: '',
      emphasis_areas: [],
    },
  });

  // No llmBaseUrlOverride: this hits the real provider.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForTimeout(900);

  // The compositing stage, on its own page so the popup is never resized or
  // reloaded mid-recording.
  stage = await context.newPage();
  await stage.setViewportSize({ width: 760, height: 680 });

  // 1 - the empty state
  await shot(page, 1500);

  // 2 - one press adds the resume: read, named after the file, filed
  await page.setInputFiles('#resumeFile', RESUME);
  await page.waitForFunction(
    () => document.getElementById('libraryHint').textContent.startsWith('Saved '),
    { timeout: 20000 },
  );
  await page.waitForTimeout(400);
  await shot(page, 1700);

  // 3 - the job. Typed, not read off a page: see the header.
  await page.fill('#jobTitle', JOB_TITLE);
  await page.fill('#employer', EMPLOYER);
  await page.fill('#jobDescription', JOB);
  await page.waitForTimeout(500);
  await shot(page, 1700);

  // 4+ - the run, sampled while it happens
  await page.click('#tailorBtn');
  const started = Date.now();
  let done = false;
  while (Date.now() - started < 90000) {
    await page.waitForTimeout(1400);
    done = await page.evaluate(() => {
      const el = document.getElementById('result');
      return Boolean(el && el.textContent && el.textContent.length);
    });
    if (done) break;
    if (frames.length < 5) await shot(page, 1000);
  }
  if (!done) throw new Error('the run did not finish inside 90s');

  await page.waitForTimeout(900);
  const status = (await page.textContent('#status')) || '';
  console.log(`\n  run finished: ${status.split('\n')[0]}\n`);

  // final - held long, because it is the frame people actually read
  await shot(page, 3200);
  await shot(page, 3200);

  const apng = buildApng(frames);
  const outPath = path.join(OUT, 'demo.png');
  writeFileSync(outPath, apng);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${frames.length} frames, ${(apng.length / 1024).toFixed(0)} KB`);
} finally {
  await context.close();
}
