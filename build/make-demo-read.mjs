// make-demo-read.mjs — the page-read demo, as an APNG for the README.
//
//   node build/make-demo-read.mjs [path-to-demo.mp4]
//
// WHY THIS EXISTS ALONGSIDE make-demo.mjs. That script drives the extension
// with Playwright and deliberately cannot show "Read job description":
// activeTab is granted only by a REAL toolbar click, never by driving the
// popup programmatically, so the page-read chain is unscriptable. It has to be
// filmed by hand. This script turns that hand-filmed recording into an asset
// built the same way as the scripted one, so the two read as one system.
//
// A STORYBOARD, NOT A VIDEO — the same argument make-demo.mjs makes. Five
// frames held a second or two each, rather than 30fps of a mostly-static UI.
// A README image is read, not watched, and five stills keep the file to a few
// hundred KB in a page that loads on every visit.
//
// The recording is NOT in the repo. It is ~1.2MB of h264 that only this script
// consumes, and committing it would cost every clone. Pass the path in; the
// default is where the working copy lives.
//
// REQUIRES ffmpeg on PATH (or a scoop shim). apng.mjs's header says ffmpeg is
// not installed — that was true when it was written, and is why the APNG
// assembler is hand-rolled. It stays hand-rolled; ffmpeg is used here only to
// pull frames out of a container, which is the part it is actually needed for.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildApng } from './apng.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/img/demo-read.png');
const SOURCE = process.argv[2]
  || path.join(os.homedir(), 'Downloads', 'tailorune-demo-anon.mp4');

// The pillarbox is not content. The video is 1920x1080 for YouTube, but the
// browser window inside it is 1044 wide starting at x=438; the rest is the
// dark bars that letterbox a portrait-ish window into a 16:9 frame.
const CONTENT = { w: 1044, h: 1080, x: 438, y: 0 };

// 500 is a size decision, not a layout one. These frames are screenshots of
// small text, which compresses nothing like the scripted demo's flat popup:
// at 560 the same five frames came to 768KB, at 500 they come to ~650KB, and
// the read hint, the filled JOB TITLE / COMPANY fields and the output chips
// are all still legible. The README renders the 540px canvas 1:1.
const FRAME_W = 500;
const PAD = 20;
const CANVAS = '#EFE8DA'; // matches make-demo.mjs, hero.png and dataflow.png

// Timestamps into the recording. Each is a state that says something the
// previous one did not — there is no frame between 1 and 2 showing "read but
// not yet tailoring", because in the real run tailoring starts immediately.
//
// THE COVER LETTER IS NOT A FRAME OF ITS OWN. A page of dense body text costs
// ~180KB here and says the same thing the resume frame says — that a real
// formatted document came out. The downloads frame already names both files,
// so dropping it loses evidence of nothing. Five frames of screenshot text do
// not compress the way the scripted demo's flat popup does, and the README
// loads this on every visit.
const FRAMES = [
  { t: 1.20, delayMs: 1400, note: 'the posting, cursor on the toolbar button' },
  { t: 3.10, delayMs: 1900, note: 'one click: posting read, title and company filled' },
  { t: 7.60, delayMs: 1600, note: 'four files in Downloads' },
  { t: 13.90, delayMs: 1700, note: 'the tailored resume' },
  { t: 18.50, delayMs: 2300, note: 'done — 333 words, four files' },
];

function ffmpegBin() {
  const candidates = ['ffmpeg', path.join(os.homedir(), 'scoop/shims/ffmpeg.exe')];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
      return bin;
    } catch { /* try the next one */ }
  }
  throw new Error('ffmpeg not found on PATH or in scoop shims');
}

function grabFrame(bin, seconds, destination) {
  const { w, h, x, y } = CONTENT;
  execFileSync(bin, [
    '-y', '-ss', String(seconds), '-i', SOURCE, '-frames:v', '1',
    // Crop the pillarbox away FIRST, then scale — scaling first would resample
    // the bars into the content edges.
    '-vf', `crop=${w}:${h}:${x}:${y},scale=${FRAME_W}:-2:flags=lanczos`,
    '-update', '1', destination,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
}

if (!existsSync(SOURCE)) {
  console.error(`recording not found: ${SOURCE}`);
  console.error('pass the path as the first argument');
  process.exit(1);
}

const bin = ffmpegBin();
const work = path.join(os.tmpdir(), `tailorune-demo-read-${process.pid}`);
mkdirSync(work, { recursive: true });

try {
  console.log(`source ${SOURCE}`);
  const stills = FRAMES.map((frame, i) => {
    const file = path.join(work, `f${i}.png`);
    grabFrame(bin, frame.t, file);
    const png = readFileSync(file);
    console.log(`  ${String(frame.t).padStart(5)}s  ${(png.length / 1024).toFixed(0).padStart(4)}KB  ${frame.note}`);
    return { ...frame, dataUri: `data:image/png;base64,${png.toString('base64')}` };
  });

  // Compositing in a browser rather than in ffmpeg buys the rounded corner and
  // the shadow for free, and is what make-demo.mjs already does. Frames are
  // inlined as data URIs so the page has no file:// origin to fight with.
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const composed = [];
  for (const still of stills) {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:${CANVAS};}
      .stage{width:${FRAME_W + PAD * 2}px;padding:${PAD}px;box-sizing:border-box;
             background:${CANVAS};display:block;}
      img{width:${FRAME_W}px;display:block;border-radius:12px;
          box-shadow:0 1px 3px rgba(27,38,33,.18);}
    </style><div class="stage"><img src="${still.dataUri}"></div>`);
    const stage = page.locator('.stage');
    composed.push({ png: await stage.screenshot({ type: 'png' }), delayMs: still.delayMs });
  }

  await browser.close();

  const apng = buildApng(composed);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, apng);

  const loop = FRAMES.reduce((sum, f) => sum + f.delayMs, 0);
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
  console.log(`  ${composed.length} frames, ${(apng.length / 1024).toFixed(0)}KB, ${(loop / 1000).toFixed(1)}s loop`);
  if (apng.length > 1024 * 1024) {
    console.log('  OVER 1MB — drop a frame or lower FRAME_W rather than recompressing');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
