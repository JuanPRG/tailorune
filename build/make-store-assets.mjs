// make-store-assets.mjs — Chrome Web Store listing artwork.
//
// The small promo tile is the asset most responsible for whether anyone
// clicks: it is what shows in category pages and search results. It is
// 440x280, and the mascot artwork is 1.578:1 against the tile's 1.571:1 --
// so it fits at essentially native proportions with no crop and no letterbox.
//
// Also emits the 1400x560 marquee, which is 2.5:1 and therefore does NOT fit
// the mascot natively. That one is composed rather than filled: the artwork
// sits to one side with the lockup beside it, because stretching a mascot to
// 2.5:1 would be the one genuinely unforgivable thing to do to it.
//
// Output goes to store/, which is NOT part of the extension bundle -- the
// packager only walks extension/.
//
// Usage: node build/make-store-assets.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(ROOT, 'extension', 'icons');
const OUT = path.join(ROOT, 'store');

const CANVAS = '#EFE8DA';
const PINE = '#222E28';
const DEEP_JADE = '#2F7A63';
const JADE = '#51A68B';

const raccoon = readFileSync(path.join(ICONS, 'tailorune-raccoon.svg'), 'utf8');
const markSvg = readFileSync(path.join(ICONS, 'tailorune-mark.svg'), 'utf8');
const markInner = markSvg.slice(markSvg.indexOf('<g '), markSvg.lastIndexOf('</svg>'));
const markVb = /viewBox="([^"]+)"/.exec(markSvg)[1];

const lockup = (scale) => `
  <div class="lock">
    <span class="tile"><svg viewBox="${markVb}" xmlns="http://www.w3.org/2000/svg">${markInner}</svg></span>
    <span class="word">Tailorune</span>
  </div>
  <p class="tag">Tailor your resume to any job — no account, no server of ours.</p>
  <style>
    .lock{display:flex;align-items:center;gap:${14 * scale}px}
    .tile{width:${56 * scale}px;height:${56 * scale}px;border-radius:${18 * scale}px;
          background:${JADE};color:#0E1412;display:inline-flex;align-items:center;justify-content:center}
    .tile svg{width:${38 * scale}px;height:${38 * scale}px;display:block}
    .word{font-size:${42 * scale}px;font-weight:650;letter-spacing:-0.02em;color:${PINE};line-height:1}
    .tag{margin:${14 * scale}px 0 0;font-size:${17 * scale}px;line-height:1.4;color:${DEEP_JADE};max-width:${34 * scale}ch}
  </style>`;

const SHELL = (w, h, body) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;
            background:${CANVAS};
            font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  /* A hairline of brand jade along the bottom, the one piece of chrome. */
  .edge{position:absolute;left:0;right:0;bottom:0;height:6px;background:${JADE}}
  svg.art{display:block}
</style>${body}<div class="edge"></div>`;

const TILE = SHELL(440, 280, `
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;
              justify-content:space-between;padding:22px 24px 26px">
    ${lockup(0.52)}
    <svg class="art" viewBox="${/viewBox="([^"]+)"/.exec(raccoon)[1]}"
         style="width:300px;height:auto;align-self:flex-end;margin-bottom:-6px"
         xmlns="http://www.w3.org/2000/svg">${raccoon.slice(raccoon.indexOf('<path'), raccoon.lastIndexOf('</svg>'))}</svg>
  </div>`);

const MARQUEE = SHELL(1400, 560, `
  <div style="position:absolute;inset:0;display:flex;align-items:center;gap:60px;padding:0 90px">
    <div style="flex:1 1 auto">${lockup(1.15)}</div>
    <svg class="art" viewBox="${/viewBox="([^"]+)"/.exec(raccoon)[1]}"
         style="width:620px;height:auto;flex:0 0 auto"
         xmlns="http://www.w3.org/2000/svg">${raccoon.slice(raccoon.indexOf('<path'), raccoon.lastIndexOf('</svg>'))}</svg>
  </div>`);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, w, h, html] of [
    ['promo-tile-440x280', 440, 280, TILE],
    ['marquee-1400x560', 1400, 560, MARQUEE],
  ]) {
    // deviceScaleFactor 1, NOT 2. The Chrome Web Store takes these at exact
    // pixel dimensions and rejects anything else -- and at 2 every file was
    // written at double the size its own name promised: promo-tile-440x280.png
    // was 880x560, marquee-1400x560.png was 2800x1120. The viewport is already
    // the target size, so the content composes identically either way.
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(html);
    writeFileSync(path.join(OUT, `${name}.png`), await p.screenshot());
    await ctx.close();
    console.log(`  wrote store/${name}.png`);
  }
} finally {
  await browser.close();
}
