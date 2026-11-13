// MixAI mark geometry: the single source for every icon, lockup and logo animation (ADR-0016, WP22-05).
//
// Idea: "many sources, one signal". Lines are the sources, the dot is the signal.
// Grid: 48 units (master) or 16 units (micro, drawn for exactly 16 px, centre lines on whole pixels).
// Every line is a stroke of `w` units with round caps and joins; the dot is a filled circle [cx, cy, r].
// Path data: absolute commands only (M L H V C Q A Z).
//
// Optical sizes: micro = 16 px and below; small = 17 to 40 px (master geometry, stroke x 1.12, dot x 1.06);
// master = above 40 px. brand/scripts/lib/draw.mjs applies the rule.
//
// Owner decisions (2026-11-12): concept K1 "Punct de mix", family S1 (parent mark + a glyph per product),
// dark tile, ivory signal, parent mark in two colours (stream A = TV colour, stream B = Music colour).

import { roundRect } from '../scripts/lib/path.mjs';

/** Parent mark: the letter M from two streams that meet in one point. `role` picks stream colour A or B. */
export const MARK = {
  master: {
    grid: 48,
    w: 6,
    lines: [
      { d: 'M9 39V9L18.37 22.74', role: 'a' },
      { d: 'M39 39V9L29.63 22.74', role: 'b' },
    ],
    dot: [24, 31, 4.5],
  },
  micro: {
    grid: 16,
    w: 2,
    lines: [
      { d: 'M3 13V3L6.2 7.3', role: 'a' },
      { d: 'M13 13V3L9.8 7.3', role: 'b' },
    ],
    dot: [8, 10.5, 1.7],
  },
};

/** Product glyphs: same grammar (lines + exactly one dot), one colour per product. Order = family order. */
export const GLYPHS = {
  // a screen on a stand; the signal is what plays
  tv: {
    master: { grid: 48, w: 5, lines: [{ d: roundRect(8, 10, 32, 22, 4) }, { d: 'M17 39H31' }], dot: [24, 21, 4] },
    micro: { grid: 16, w: 2, lines: [{ d: roundRect(2, 3, 12, 8, 1.5) }, { d: 'M6 14H10' }], dot: [8, 7, 1.5] },
  },
  // a note whose head is the signal
  music: {
    master: { grid: 48, w: 5, lines: [{ d: 'M24.5 33V9C25.5 15 33.5 14 33.5 22' }], dot: [19.5, 33.5, 5.25] },
    micro: { grid: 16, w: 2, lines: [{ d: 'M9 11V3L12.5 5' }], dot: [6.5, 11.5, 2.5] },
  },
  // a platter with its spindle
  decks: {
    master: { grid: 48, w: 5, lines: [{ d: 'M24 10A14 14 0 1 1 23.99 10Z' }], dot: [24, 24, 4.25] },
    micro: { grid: 16, w: 2, lines: [{ d: 'M8 3A5 5 0 1 1 7.99 3Z' }], dot: [8, 8, 1.5] },
  },
  // a voice going out in both directions
  live: {
    master: {
      grid: 48,
      w: 5,
      lines: [
        { d: 'M17.64 17.64A9 9 0 0 0 17.64 30.36' },
        { d: 'M30.36 17.64A9 9 0 0 1 30.36 30.36' },
        { d: 'M12.33 12.33A16.5 16.5 0 0 0 12.33 35.67' },
        { d: 'M35.67 12.33A16.5 16.5 0 0 1 35.67 35.67' },
      ],
      dot: [24, 24, 3.75],
    },
    micro: { grid: 16, w: 2, lines: [{ d: 'M3.76 3.76A6 6 0 0 0 3.76 12.24' }, { d: 'M12.24 3.76A6 6 0 0 1 12.24 12.24' }], dot: [8, 8, 2] },
  },
  // three channel faders, one of them set
  studio: {
    master: { grid: 48, w: 5, lines: [{ d: 'M11 10V38' }, { d: 'M24 10V38' }, { d: 'M37 10V38' }], dot: [24, 18, 5.25] },
    micro: { grid: 16, w: 2, lines: [{ d: 'M3 3V13' }, { d: 'M8 3V13' }, { d: 'M13 3V13' }], dot: [8, 6, 2] },
  },
  // a metronome; the weight on the arm is the signal
  keybpm: {
    master: { grid: 48, w: 5, lines: [{ d: 'M13 39L18.5 9H23.5L29 39Z' }, { d: 'M21 32L33.5 15.5' }], dot: [34.5, 14, 4.25] },
    micro: { grid: 16, w: 2, lines: [{ d: 'M4 13L6.5 3H8.5L11 13Z' }, { d: 'M7.5 10.5L11.5 5' }], dot: [12.5, 3.5, 1.6] },
  },
  // one box that serves; the lit dot says it is on
  server: {
    master: { grid: 48, w: 5, lines: [{ d: roundRect(7, 14, 34, 20, 4) }, { d: 'M25 24H33' }], dot: [16, 24, 3.75] },
    micro: { grid: 16, w: 2, lines: [{ d: roundRect(2, 4, 12, 8, 1.5) }, { d: 'M9 8H11' }], dot: [5.5, 8, 1.3] },
  },
  // a plug that brings a source in
  connector: {
    master: { grid: 48, w: 5, lines: [{ d: 'M19 7V15' }, { d: 'M29 7V15' }, { d: 'M13 15H35V22A11 11 0 0 1 13 22Z' }, { d: 'M24 33V41' }], dot: [24, 22.5, 3.75] },
    micro: { grid: 16, w: 2, lines: [{ d: 'M6 2V5' }, { d: 'M10 2V5' }, { d: 'M4 5H12V7.5A4 4 0 0 1 4 7.5Z' }, { d: 'M8 11.5V14' }], dot: [8, 7.5, 1.3] },
  },
};

/** `mark` (the family) plus the eight products, in family order. */
export const IDS = ['mark', ...Object.keys(GLYPHS)];

export function geometry(id) {
  const set = id === 'mark' ? MARK : GLYPHS[id];
  if (!set) throw new Error(`unknown mark id: ${id}`);
  return set;
}

/** Wordmark rules: lettering is outlined Space Grotesk (brand/src/lettering.json); the dot of the "i" is the signal. */
export const WORDMARK = {
  capHeight: 24, // units of the 48 grid when set beside the symbol (two thirds of the mark's height)
  baseline: 36,
  gap: 12, // from the symbol box (48) to the first letter
  descriptorGap: 240, // font units between "MixAI" and the product name
  iDot: { cx: 133, cy: 640, r: 88 }, // font units; a true circle, wider than the stem, replaces the type's own dot
};

/** Tile (app icon plate): corner radius as a share of the side; symbol scale: micro <= 16 px, small <= 32 px. */
export const TILE = { radius: 0.225, scale: { large: 0.8, small: 0.875, micro: 1 } };
