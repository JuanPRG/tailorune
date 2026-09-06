// make-icons.mjs — render extension/icons/icon{16,32,48,128}.png from the
// brand mark.
//
// The mark is extension/icons/tailorune-mark.svg, the real supplied vector.
// This script rasterises it with Playwright (already a devDependency for the
// e2e suite) rather than hand-drawing an approximation, so the toolbar icon
// and the popup header are provably the same artwork.
//
// TWO DECISIONS HERE, BOTH MEASURED RATHER THAN ASSUMED.
//
// 1. JADE TILE, CHARCOAL GLYPH -- not a jade glyph on a dark tile. Rendered
//    side by side at 16/32/48/128, the dark-glyph-on-jade version is still
//    identifiable at 16px while the jade-on-charcoal version has collapsed
//    into a faint smudge. The mark is fine line-work; at toolbar size it needs
//    a solid ground behind it, not a dark one around it. Same reason a solid
//    paper plane worked for the product this replaces.
//
// 2. THE VIEWBOX IS CROPPED. The delivered SVG declares 0 0 2048 2066 while
//    the art occupies x 401..1775, y 335..1855 -- 51% of the canvas is
//    padding. At 16px that padding is half the pixels the glyph could have
//    used, and the difference between the cropped and uncropped renders is
//    plainly visible at 16 and 32.
//
// Usage: node build/make-icons.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'icons');
const MARK = path.join(OUT, 'tailorune-mark.svg');

const SIZES = [16, 32, 48, 128];

// Brand jade, taken from the supplied vector's own fill.
const JADE = '#51A68B';
// The glyph colour: the charcoal-green the mark was delivered on, darkened
// slightly so it holds contrast against the jade rather than vibrating on it.
const CHARCOAL = '#121715';

// Rendered at 4x and downscaled by the browser's own resampler, which handles
// the mark's thin counters better than snapping them to a 16px grid.
const SUPERSAMPLE = 4;

const svg = readFileSync(MARK, 'utf8');
const inner = svg.slice(svg.indexOf('<g '), svg.lastIndexOf('</svg>'));
const viewBox = /viewBox="([^"]+)"/.exec(svg)[1];

/** Squircle-ish tile, matching the popup's .brand-mark radius ratio (9/27). */
const page = (size) => `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent}
  #t{width:${size}px;height:${size}px;background:${JADE};
     border-radius:${Math.round(size * 9 / 27)}px;
     display:flex;align-items:center;justify-content:center}
  svg{width:${Math.round(size * 0.68)}px;height:${Math.round(size * 0.68)}px;color:${CHARCOAL}}
</style><div id="t"><svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${inner}</svg></div>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const size of SIZES) {
    const big = size * SUPERSAMPLE;
    const ctx = await browser.newContext({
      viewport: { width: big, height: big },
      deviceScaleFactor: 1,
    });
    const p = await ctx.newPage();
    await p.setContent(page(big));
    const shot = await p.locator('#t').screenshot({ omitBackground: true });
    await ctx.close();

    // Downscale through a second page: the browser's image resampler is
    // better than anything worth hand-rolling here.
    const ctx2 = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const p2 = await ctx2.newPage();
    await p2.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;padding:0;background:transparent}
      img{width:${size}px;height:${size}px;display:block}
    </style><img id="i" src="data:image/png;base64,${shot.toString('base64')}">`);
    await p2.locator('#i').waitFor();
    const out = await p2.locator('#i').screenshot({ omitBackground: true });
    await ctx2.close();

    writeFileSync(path.join(OUT, `icon${size}.png`), out);
    console.log(`  wrote extension/icons/icon${size}.png`);
  }
} finally {
  await browser.close();
}
