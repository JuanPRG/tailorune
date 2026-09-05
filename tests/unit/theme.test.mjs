// theme.test.mjs — every press of the toggle must change what you see.
//
// It did not. The cycle ran through a list -- system, dark, light -- by index,
// with no idea what any of them actually looked like. On a dark-mode machine
// "system" and "dark" render identically, so the first press did nothing
// visible and reaching the canvas theme took two: reported as "the dark theme
// button has to be pressed twice to turn it light, one to turn it back black."
//
// A pure function over (current, systemIsDark) because the DOM half is one
// line and the deciding half is the part that was wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceOf, nextTheme } from '../../extension/engine/theme.js';

const DARK_OS = true;
const LIGHT_OS = false;

test('what a theme looks like depends on the machine only for "system"', () => {
  assert.equal(appearanceOf('system', DARK_OS), 'dark');
  assert.equal(appearanceOf('system', LIGHT_OS), 'light');
  for (const os of [DARK_OS, LIGHT_OS]) {
    assert.equal(appearanceOf('dark', os), 'dark', 'an explicit theme is a pin');
    assert.equal(appearanceOf('light', os), 'light');
  }
});

test('anything unrecognised is treated as following the system', () => {
  // Whatever is in storage came from an older build, or from nothing.
  for (const junk of ['', null, undefined, 'canvas', 'AUTO']) {
    assert.equal(appearanceOf(junk, DARK_OS), 'dark');
    assert.equal(appearanceOf(junk, LIGHT_OS), 'light');
  }
});

// --- the bug --------------------------------------------------------------

test('THE REGRESSION: one press always flips what is on screen', () => {
  for (const os of [DARK_OS, LIGHT_OS]) {
    for (const from of ['system', 'dark', 'light']) {
      const to = nextTheme(from, os);
      assert.notEqual(
        appearanceOf(to, os), appearanceOf(from, os),
        `on a ${os ? 'dark' : 'light'} machine, ${from} -> ${to} changed nothing visible`,
      );
    }
  }
});

test('and pressing twice puts it back, so the button is a toggle', () => {
  for (const os of [DARK_OS, LIGHT_OS]) {
    for (const from of ['system', 'dark', 'light']) {
      const round = nextTheme(nextTheme(from, os), os);
      assert.equal(appearanceOf(round, os), appearanceOf(from, os),
        `${from} did not survive a round trip on a ${os ? 'dark' : 'light'} machine`);
    }
  }
});

// --- "follow my system" must stay reachable -------------------------------

test('the theme matching the machine is expressed as "system", not pinned', () => {
  // The alternative -- cycling to an explicit value that happens to match --
  // silently strips the follow-the-OS behaviour the first time the button is
  // pressed, and there is then no way back to it.
  assert.equal(nextTheme('light', DARK_OS), 'system', 'back to dark on a dark machine is "system"');
  assert.equal(nextTheme('dark', LIGHT_OS), 'system', 'back to light on a light machine is "system"');
});

test('the theme opposing the machine is pinned, since "system" cannot express it', () => {
  assert.equal(nextTheme('system', DARK_OS), 'light');
  assert.equal(nextTheme('system', LIGHT_OS), 'dark');
});

test('a theme pinned against the machine still toggles out of it', () => {
  // Left over from the old cycle, or from the OS changing under a pin.
  assert.equal(nextTheme('dark', DARK_OS), 'light');
  assert.equal(nextTheme('light', LIGHT_OS), 'dark');
});
