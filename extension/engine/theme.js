// theme.js — which theme the toggle moves to next.
//
// Split out of popup.entry.js because the DOM half of theming is one line --
// set or remove a data attribute -- and the deciding half is where the bug
// was. As a pure function over (current, systemIsDark) it can be tested on a
// machine whose own colour scheme is nobody's business.
//
// WHAT WENT WRONG: the toggle walked a list, ['system', 'dark', 'light'], by
// index. Nothing in that walk knew what any of the three looked like, and on
// a dark-mode machine "system" and "dark" look identical -- so the first
// press changed a stored string and not one pixel. Reaching the canvas theme
// took two presses and coming back took one.
//
// The cure is to stop thinking in three states. There are two APPEARANCES,
// and the button swaps them; "system" and "dark" are two spellings of the
// same one, and which spelling to write down is a separate question from
// which appearance to show.

/** The two things a user can actually see. */
const DARK = 'dark';
const LIGHT = 'light';

/**
 * What a stored theme renders as on this machine.
 *
 * Anything unrecognised -- '', null, a value from an older build -- follows
 * the system, which is what applyTheme already does with it.
 */
export function appearanceOf(theme, systemIsDark) {
  if (theme === DARK || theme === LIGHT) return theme;
  return systemIsDark ? DARK : LIGHT;
}

/**
 * The theme one press away, guaranteed to look different from this one.
 *
 * Where two spellings would give the right appearance, 'system' wins. Pinning
 * an explicit value that merely happens to match the machine would quietly
 * discard the follow-the-OS behaviour on the very first press -- and with a
 * two-state toggle there would then be no way back to it.
 */
export function nextTheme(current, systemIsDark) {
  const system = systemIsDark ? DARK : LIGHT;
  const wanted = appearanceOf(current, systemIsDark) === DARK ? LIGHT : DARK;
  return wanted === system ? 'system' : wanted;
}
