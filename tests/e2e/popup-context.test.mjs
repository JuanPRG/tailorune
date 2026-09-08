// popup-context.test.mjs — the flows that only prove anything when run in the
// REAL browser-action popup.
//
// See realPopup.mjs for why this exists: a tab and a popup are different
// rendering contexts, and the difference has already hidden one shipped bug
// (window.prompt) that a full green suite could not see.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openRealPopup, readStorage, waitForStorage } from './realPopup.mjs';
import { openResumeManage, fillApiKey, closeSettings } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCX_FIXTURE = path.resolve(__dirname, '../fixtures/resumes/juan-rivera-tabstops.docx');

const RESUMES_KEY = 'tailorune_resumes_v1';

test('real popup: uploading a .docx extracts it, all the way through the service worker and offscreen document', async (t) => {
  const { popup } = await openRealPopup(t);

  const dialogs = [];
  popup.on('dialog', (d) => { dialogs.push(d.type()); d.dismiss().catch(() => {}); });

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(
    () => document.getElementById('resumeText').value.includes('Juan Rivera'),
    { timeout: 20000 },
  );

  const hint = await popup.textContent('#libraryHint');
  assert.match(hint, /Click Save to keep it/);
  assert.deepEqual(dialogs, [], 'the real popup must never open a JS dialog');
});

test('real popup: the name field takes the uploaded file name, replacing whatever was there', async (t) => {
  const { popup } = await openRealPopup(t);

  // Something already typed in the name field must not survive a new upload:
  // the file the user just picked is what they are naming, and a stale label
  // would silently mislabel what gets saved.
  await popup.fill('#resumeName', '123');
  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await openResumeManage(popup);
  assert.equal(await popup.inputValue('#resumeName'), 'juan-rivera-tabstops');
});

test('real popup: saving actually writes to storage — the flow that silently did nothing before', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await openResumeManage(popup);
  await popup.fill('#resumeName', 'Finance CV');
  await popup.click('#saveResumeBtn');
  await popup.waitForFunction(
    () => document.getElementById('libraryHint').textContent.includes('Saved as'),
    { timeout: 5000 },
  );

  // The assertion that matters is in STORAGE, not the DOM. A hint can be
  // written by a handler that never persisted anything.
  const stored = await readStorage(sw, RESUMES_KEY);
  assert.ok(stored, 'nothing was written to chrome.storage.local');
  assert.equal(stored.resumes.length, 1);
  assert.equal(stored.resumes[0].name, 'Finance CV');
  assert.ok(stored.resumes[0].text.includes('Juan Rivera'));
  assert.equal(stored.lastUsedId, stored.resumes[0].id);
});

test('real popup: a selected file with an empty textarea is recovered by Save, not refused', async (t) => {
  // The reported failure state: a file sits in the input, the textarea is
  // empty, and Save answers "nothing to save". Whatever caused the change
  // event to be missed, refusing is the wrong response -- the file is right
  // there. Simulated here by blanking the textarea after extraction, which
  // reproduces the state without needing to reproduce its cause.
  const { popup, sw } = await openRealPopup(t);

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  await popup.evaluate(() => { document.getElementById('resumeText').value = ''; });
  await openResumeManage(popup);
  await popup.fill('#resumeName', 'Recovered CV');

  await popup.click('#saveResumeBtn');
  await popup.waitForFunction(
    () => document.getElementById('libraryHint').textContent.includes('Saved as'),
    { timeout: 20000 },
  );

  const stored = await readStorage(sw, RESUMES_KEY);
  assert.equal(stored.resumes.length, 1, 'Save should have re-read the selected file');
  assert.equal(stored.resumes[0].name, 'Recovered CV');
  assert.ok(stored.resumes[0].text.includes('Juan Rivera'));
  // And the textarea is repopulated, so the user can see what was saved.
  await openResumeManage(popup);
  assert.ok((await popup.inputValue('#resumeText')).includes('Juan Rivera'));
});

test('real popup: settings persist as you type, without needing a tailor run', async (t) => {
  const { popup, sw } = await openRealPopup(t);

  await fillApiKey(popup, 'popup-context-key');

  const settings = await waitForStorage(sw, 'tailorune_settings_v1', (v) => Boolean(v && v.apiKey));
  assert.equal(settings.apiKey, 'popup-context-key');
});

test('real popup: the resume card stays compact, and says what is loaded', async (t) => {
  // The contract of the compact resume card, which is easy to regress by
  // accident because every piece of it still exists in the DOM.
  //
  //   EMPTY  -- the disclosure is OPEN. Folding the textarea away is the
  //             point of the layout, but in an empty card it is also the only
  //             way to paste a resume; closing it there would hide the
  //             primary input behind a control labelled "Text & library".
  //   LOADED -- the disclosure is CLOSED and a pill states the name and word
  //             count. That pill is the whole argument for the redesign: the
  //             textarea's real job was reassurance, and it cost 110px to do
  //             it badly, showing three lines from wherever the document
  //             happened to be scrolled.
  const { popup } = await openRealPopup(t);
  const cardHeight = () => popup.$eval(
    'main.scroll > section.card:first-of-type',
    (el) => Math.round(el.getBoundingClientRect().height),
  );

  assert.equal(await popup.$eval('#resumeManage', (el) => el.open), true,
    'an empty resume card must leave the paste box reachable');
  assert.equal(await popup.isVisible('#resumeMeta'), false, 'nothing is loaded, so nothing to summarise');

  await popup.setInputFiles('#resumeFile', DOCX_FIXTURE);
  await popup.waitForFunction(() => document.getElementById('resumeText').value.length > 0, { timeout: 20000 });

  assert.equal(await popup.$eval('#resumeManage', (el) => el.open), false,
    'loading a resume must fold the text away -- that is the request this implements');
  assert.match(
    await popup.textContent('#resumeMeta'), /juan-rivera-tabstops · \d+ words/,
    'the pill must name the loaded resume and count its words',
  );

  // A number, so "compact" is a claim the suite can check rather than a
  // matter of opinion. The card was 317px with the textarea exposed.
  const height = await cardHeight();
  assert.ok(height < 170, `the loaded resume card should stay compact, measured ${height}px`);
});

test('real popup: the gear swaps views, and never shows two at once', async (t) => {
  // THE BUG THIS EXISTS FOR. Both scroll regions rendered at the same time,
  // stacked, so the gear appeared to append a settings page to the bottom of
  // the tailoring page instead of replacing it. Cause: `.scroll` sets
  // `display: flex`, which OUTRANKS the [hidden] attribute's user-agent rule
  // -- so the element was hidden in the DOM sense and painted anyway.
  //
  // Nothing in an assertion about #settingsView.hidden would have caught it,
  // which is the whole point of asserting on isVisible() here.
  const { popup } = await openRealPopup(t);
  const shown = async () => ({
    main: await popup.isVisible('#mainView'),
    settings: await popup.isVisible('#settingsView'),
    footer: await popup.isVisible('#appFooter'),
  });

  // A first run lands on the WORK, not on configuration -- even with no key
  // stored. The amber "No key" pill is how you get to settings.
  assert.deepEqual(await shown(), { main: true, settings: false, footer: true },
    'the popup should open on tailoring, whatever is or is not configured');

  await popup.click('#keyStatus');
  assert.deepEqual(await shown(), { main: false, settings: true, footer: false },
    'the key pill should lead to the key');

  await popup.click('#settingsBackBtn');
  assert.deepEqual(await shown(), { main: true, settings: false, footer: true },
    'back should return to tailoring, with the CTA reachable again');

  await popup.click('#settingsBtn');
  assert.deepEqual(await shown(), { main: false, settings: true, footer: false },
    'the gear should open settings');

  await popup.click('#settingsBtn');
  assert.deepEqual(await shown(), { main: true, settings: false, footer: true },
    'the gear should toggle back out again');

  // The fields really moved -- they are reachable in settings and nowhere else.
  await popup.click('#settingsBtn');
  for (const id of ['#keyGemini', '#keyGroq', '#keyOpenrouter', '#provider',
    '#resumeDensity', '#coverLetterTone']) {
    assert.equal(await popup.isVisible(id), true, `${id} should live in the settings view`);
  }
});

test('one press of the theme toggle changes the theme', async (t) => {
  // REPORTED: "the dark theme button has to be pressed twice to turn it
  // light, one to turn it back black."
  //
  // The toggle walked ['system', 'dark', 'light'] by index, knowing nothing
  // about what any of them LOOKED like. On a dark-mode machine "system" and
  // "dark" render identically, so one press of every three moved a stored
  // string and not a pixel.
  //
  // Asserted on the painted background rather than on the data-theme
  // attribute: the attribute is the implementation, and it was changing
  // correctly the whole time. What was wrong is what the user saw.
  const { popup } = await openRealPopup(t);

  for (const colorScheme of ['dark', 'light']) {
    await popup.emulateMedia({ colorScheme });
    await popup.waitForTimeout(400);

    const painted = () => popup.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    const before = await painted();
    await popup.click('#themeToggle');
    await popup.waitForTimeout(400);
    const after = await painted();

    assert.notEqual(after, before,
      `on a ${colorScheme} machine one press changed nothing: still ${before}`);

    // And it is a toggle, not a three-stop tour: pressing again comes back.
    await popup.click('#themeToggle');
    await popup.waitForTimeout(400);
    assert.equal(await painted(), before,
      `on a ${colorScheme} machine a second press did not return to ${before}`);
  }
});

test('real popup: reset is the only control tinted as caution', async (t) => {
  // Reset is the one control here that discards work, and it used to look
  // exactly like the controls that do not. Amber rather than red: it keeps
  // the resume and the API keys, so it earns caution, not alarm.
  //
  // Compared by DISTANCE, not equality. The first attempt asserted that the
  // gear and the theme toggle were the same colour and failed on
  // rgb(99,119,109) against rgb(95,114,105) -- both are var(--text-2), caught
  // mid `transition: color 0.16s`. Equality on a transitioning property is a
  // flake waiting to happen; "obviously different" and "near enough the same"
  // are the claims that actually matter.
  const { popup } = await openRealPopup(t);
  await popup.waitForTimeout(400); // let the entry transitions settle

  const rgb = async (sel) => popup.$eval(sel, (el) => {
    const [r, g, b] = getComputedStyle(el).color.match(/\d+/g).map(Number);
    return [r, g, b];
  });
  const gap = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const reset = await rgb('#resetBtn');
  const gear = await rgb('#settingsBtn');
  const theme = await rgb('#themeToggle');

  assert.ok(gap(reset, gear) > 40, `reset (${reset}) must read differently from the gear (${gear})`);
  assert.ok(gap(reset, theme) > 40, `reset (${reset}) must read differently from the theme toggle (${theme})`);
  assert.ok(gap(gear, theme) < 20, `the non-destructive icons should still match: ${gear} vs ${theme}`);

  // Amber, not red: warmer than it is cool, and not a pure alarm colour.
  assert.ok(reset[0] > reset[2], `reset should be warm-tinted, got rgb(${reset})`);

  // Both reset controls carry the same treatment, so the pair beside the CTA
  // reads the same way as the one in the header.
  assert.equal(
    await popup.$eval('#footerResetBtn', (el) => el.classList.contains('caution')), true,
    'the footer reset should be tinted too',
  );
});

test('the front page fits in the 600px Chrome allows a popup', async (t) => {
  // The whole point of the last few passes: three cards, a header and a
  // pinned footer inside 600px. It was 79px over and scrolled on every run.
  //
  // MEASURED IN A SIZED TAB, NOT THE REAL POPUP, and the first version of
  // this test got that wrong -- it asserted against the live popup and failed
  // by 409px. The popup's window height is Chrome's to choose and it came
  // back around 510px in this browser, so `max-height: 100vh` correctly
  // shrank the app to fit it. That is the layout working, not failing. The
  // claim worth pinning is about the budget the design targets: 420x600.
  //
  // Asserted as SLACK rather than "does not scroll", because zero overflow
  // and zero room are not the same state -- the first survives a hint line
  // appearing, the second does not.
  const { popup } = await openRealPopup(t);
  const page = await popup.context().newPage();
  await page.setViewportSize({ width: 420, height: 600 });
  await page.goto(popup.url());
  await page.fill('#resumeText', 'Ada Lovelace — Analytical Engine notes');
  await page.$eval('#resumeManage', (el) => { el.open = false; });
  await page.waitForTimeout(250);

  const fit = await page.evaluate(() => {
    const main = document.getElementById('mainView');
    const kids = [...main.children].filter((el) => el.getBoundingClientRect().height > 0);
    const top = main.getBoundingClientRect().top;
    const bottom = kids[kids.length - 1].getBoundingClientRect().bottom;
    const content = bottom - top + parseFloat(getComputedStyle(main).paddingBottom);
    return {
      slack: Math.round(main.clientHeight - content),
      overflow: main.scrollHeight - main.clientHeight,
    };
  });

  assert.equal(fit.overflow, 0, `the front page should not scroll, but overflows by ${fit.overflow}px`);
  assert.ok(fit.slack > 20, `and should keep room to grow, but has only ${fit.slack}px spare`);
  await page.close();
});

test('it still fits once the alerts are up', async (t) => {
  // REPORTED: "the alerts are making it a little bit cumbersome to watch."
  //
  // The budget test above measures a QUIET page -- no hint, no notice, no
  // status, no findings -- and passed with room to spare while the loaded
  // popup overflowed by 44px on every finished run. That is the blind spot,
  // not a second opinion about the same thing: the surfaces that push it over
  // are precisely the ones that only exist after a run.
  //
  // Set directly rather than driven through a run, because this is a claim
  // about LAYOUT under a given amount of text. The strings are the ones from
  // the report: a two-line status with timings, and a notice that wraps.
  const load = async (page, { findings }) => {
    await page.fill('#resumeText', 'Juan Rivera — Analytical Engine notes');
    await page.$eval('#resumeManage', (el) => { el.open = false; });
    await page.fill('#jobDescription', 'Conair Consumer Products ULC is a privately owned '
      + 'company and part of Conair LLC, a global organization operating in 120 countries.');
    await page.fill('#jobTitle', 'Consumer Service Representative');
    await page.fill('#employer', 'Conair Consumer Products');
    await page.evaluate((withFindings) => {
      document.getElementById('extractHint').textContent =
        'Read from indeed_selected_pane. Looks complete.';
      const notice = document.getElementById('priorTailorNotice');
      notice.hidden = false;
      notice.textContent = 'You already tailored for Consumer Service Representative '
        + 'at Conair Consumer Products — 3 days ago.';
      document.getElementById('status').textContent =
        'Done — 393 words, 4 files in Downloads. 10s in 4 AI calls — resume 4.3s (1 call), '
        + 'skills 3.8s (2 calls), letter 1.6s (1 call), render 0.0s.';
      document.getElementById('tailorBtnLabel').textContent = 'Re-tailor';
      document.getElementById('footerResetBtn').hidden = false;
      if (withFindings) {
        document.getElementById('warnings').innerHTML =
          '<details class="finding"><summary>Skills — 2 notes'
          + '<span class="finding-count">2</span></summary><ul><li>a note</li></ul></details>';
      }
    }, findings);
    await page.waitForTimeout(400);
  };

  const measure = (page) => page.evaluate(() => {
    const main = document.getElementById('mainView');
    const kids = [...main.children].filter((el) => el.getBoundingClientRect().height > 0);
    const top = main.getBoundingClientRect().top;
    const bottom = kids[kids.length - 1].getBoundingClientRect().bottom;
    const content = bottom - top + parseFloat(getComputedStyle(main).paddingBottom);
    const cta = document.getElementById('tailorBtn').getBoundingClientRect();
    return {
      slack: Math.round(main.clientHeight - content),
      overflow: main.scrollHeight - main.clientHeight,
      ctaBottom: Math.round(cta.bottom),
      viewport: window.innerHeight,
    };
  });

  const { popup } = await openRealPopup(t);

  // The reported case: a finished run, no findings. It has to have ROOM, not
  // merely fit -- zero overflow and zero slack are not the same state.
  const page = await popup.context().newPage();
  await page.setViewportSize({ width: 420, height: 600 });
  await page.goto(popup.url());
  await load(page, { findings: false });
  const loaded = await measure(page);
  assert.equal(loaded.overflow, 0,
    `a finished run should not scroll the front page, but overflows by ${loaded.overflow}px`);
  assert.ok(loaded.slack > 8, `and should keep room, but has only ${loaded.slack}px spare`);
  await page.close();

  // The worst case anything can reach: the above plus a findings group. The
  // claim here is weaker on purpose -- it may sit exactly on the budget -- but
  // the button must never be the thing pushed off.
  const worst = await popup.context().newPage();
  await worst.setViewportSize({ width: 420, height: 600 });
  await worst.goto(popup.url());
  await load(worst, { findings: true });
  const full = await measure(worst);
  assert.ok(full.overflow <= 0,
    `with findings too it overflows by ${full.overflow}px`);
  assert.ok(full.ctaBottom <= full.viewport,
    `the CTA must stay on screen, but its bottom is at ${full.ctaBottom} of ${full.viewport}`);
  await worst.close();
});

test('the popup renders at a usable size, not a sliver', async (t) => {
  // THE REGRESSION THIS EXISTS FOR, and it shipped past a fully green suite.
  //
  // `html, body { height: 600px }` was given `max-height: 100vh` to stop a
  // short browser window clipping the footer. Chrome sizes the popup window
  // FROM the document, so during that measurement 100vh resolved against a
  // viewport that did not exist yet, max-height clamped the body to it, and
  // the popup was sized to the clamp: 420x25px. A sliver showing the header
  // and nothing else -- "i cant see the extension".
  //
  // Nothing caught it. No console error, no exception, and every other test
  // here drives either a tab (which has a real viewport) or a popup whose
  // CONTENT it inspects rather than its SIZE. So: assert the size, in the
  // real popup, because that is the one context where the bug exists.
  const { popup } = await openRealPopup(t);
  await popup.waitForTimeout(400);

  const box = await popup.evaluate(() => {
    const r = document.body.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });

  assert.equal(box.w, 420, `the popup should be 420px wide, got ${box.w}px`);
  assert.ok(box.h > 400, `the popup collapsed to ${box.h}px tall -- it must not be a sliver`);

  // And the whole app is really laid out inside it, not merely present.
  const laid = await popup.evaluate(() => ({
    header: document.querySelector('.app-header').getBoundingClientRect().height > 0,
    cards: [...document.querySelectorAll('#mainView > section.card')]
      .filter((el) => el.getBoundingClientRect().height > 0).length,
    cta: document.getElementById('tailorBtn').getBoundingClientRect().height > 0,
  }));
  assert.deepEqual(laid, { header: true, cards: 3, cta: true },
    'header, all three cards and the CTA must have real height');
});

const RUN_WITH_FINDINGS = {
  at: Date.now(),
  jobTitle: 'Backend Engineer',
  employer: 'Acme Corp',
  jobDescription: 'A job description',
  pageUrl: '',
  wordCount: 402,
  downloads: ['a.docx', 'a.pdf'],
  htmlPreview: '<h1>preview</h1>',
  resumeStatus: 'approved',
  resumeWarnings: ["Role 2 kept only 39% of the original's specific vocabulary (aiming for 45%). "
    + 'Rephrase around these instead of replacing them: day-to-day, maintenance, owned, accountable, '
    + 'property, financial, results, grew, adjusting, seasonal, expanding, onto.'],
  resumeErrors: [],
  resumeJudge: { passed: false, issues: ['a first note', 'a second note'] },
};

test('findings collapse, and a restored run opens with them shut', async (t) => {
  // These sit in the FOOTER, above the CTA, and they run long -- a vocabulary
  // note lists every word it wants kept. Reported as five lines of amber
  // pushing the work off screen on every open.
  //
  // Shut, a group is still one legible line: what it is, and how many notes
  // it holds. A finding nobody has read yet stays open; the same finding on
  // the fourth reopen does not cost the same room as the resume card.
  const { popup } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate((run) => chrome.storage.local.set({ tailorune_last_run_v1: run }), RUN_WITH_FINDINGS);
    },
  });

  await popup.waitForSelector('#warnings .finding', { timeout: 10000 });
  const groups = await popup.$$eval('#warnings .finding', (els) => els.map((el) => ({
    open: el.open,
    summary: el.querySelector('summary').textContent,
  })));

  assert.equal(groups.length, 2, 'the judge and the resume are separate groups');
  assert.deepEqual(groups.map((g) => g.open), [false, false], 'a run being RESTORED has already been read');
  assert.match(groups[0].summary, /2 notes/, 'a shut group must still say how much it is hiding');
  assert.ok(groups[1].summary.endsWith('1 note'), 'and say it in the singular when there is one');

  // Shut is worth real space here, which is the whole point.
  const shut = await popup.$eval('#warnings', (el) => Math.round(el.getBoundingClientRect().height));
  await popup.click('#warnings .finding:last-of-type summary');
  await popup.waitForTimeout(350);
  const open = await popup.$eval('#warnings', (el) => Math.round(el.getBoundingClientRect().height));

  assert.ok(open > shut + 30, `expanding should reveal the notes: ${shut}px -> ${open}px`);
  assert.match(await popup.textContent('#warnings'), /specific vocabulary/, 'and the note itself is readable');
});

test('a finding cannot inject markup into the popup', async (t) => {
  // Findings go through innerHTML and some of them are written by a language
  // model -- the accuracy review's issues are its own prose. Unescaped, a
  // model that emitted a tag would have it parsed as markup in a document
  // holding the user's API keys. Nothing has emitted one; "nothing has yet"
  // is not a security property.
  const { popup } = await openRealPopup(t, {
    beforeOpen: async (worker) => {
      await worker.evaluate((run) => chrome.storage.local.set({
        tailorune_last_run_v1: {
          ...run,
          resumeJudge: { passed: false, issues: ['<img src=x onerror="window.__pwned = 1"> note'] },
        },
      }), RUN_WITH_FINDINGS);
    },
  });

  await popup.waitForSelector('#warnings .finding', { timeout: 10000 });
  assert.equal(await popup.$$eval('#warnings img', (els) => els.length), 0, 'no element was created');
  assert.equal(await popup.evaluate(() => window.__pwned), undefined, 'and nothing ran');
  assert.match(await popup.textContent('#warnings'), /<img src=x/, 'the text is shown verbatim instead');
});
