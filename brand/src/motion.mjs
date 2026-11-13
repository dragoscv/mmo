// MixAI logo motion: ONE parametric definition (ADR-0016 D75, WP22-08). brand/scripts/build.mjs turns it
// into CSS keyframes, animated SVG (SMIL), Android AnimatedVectorDrawable and SwiftUI. No runtime player.
//
// Two primitives that exist on every platform: a line retracting towards its end (stroke trim start,
// 0 = whole line, 1 = gone) and a transform on the signal dot. Every animation STARTS and ENDS on the static
// mark (ADR-0016 item 6), so a skipped or interrupted animation never leaves a broken logo, and every
// animation has a reduced-motion form.
//
// Tracks are keyframe lists `[time 0..1, value, easing into this key]`. Times are shares of `duration`.
// Durations in milliseconds. Easings are cubic-bezier control points, all inside 0..1 (animated SVG / SMIL
// rejects anything else): an overshoot is written as its own keyframe, never as an easing.

export const EASE = {
  linear: [0, 0, 1, 1],
  inOut: [0.4, 0, 0.2, 1],
  out: [0.16, 1, 0.3, 1],
  draw: [0.2, 0, 0, 1], // lines: quick start, long settle
};

export const LOGO_MOTION = {
  // launch: the sources flow into the signal, then come back out ("many sources, one signal")
  intro: {
    duration: 900, // with lineSpread the last line ends at 990 ms; the Android system splash allows 1000
    loop: false,
    lineSpread: 0.1, // the LAST line starts this share of the duration late; lines in between are spaced evenly
    trimStart: [[0, 0], [0.3, 1, 'inOut'], [0.42, 1], [0.86, 0, 'draw']],
    dotScale: [[0, 1], [0.12, 1], [0.38, 1.4, 'inOut'], [0.5, 1.4], [0.82, 0.94, 'inOut'], [1, 1, 'inOut']],
    reduced: 'static mark',
  },
  // working: the signal breathes, the sources dim; loops, pause it when hidden for more than 5 s
  loading: {
    duration: 1400,
    loop: true,
    lineSpread: 0.2,
    lineOpacity: [[0, 1], [0.4, 0.4, 'inOut'], [0.8, 1, 'inOut'], [1, 1]],
    dotScale: [[0, 1], [0.5, 0.62, 'inOut'], [1, 1, 'inOut']],
    reduced: 'static mark; the screen shows a text status',
  },
  // done: one confident beat of the signal
  success: {
    duration: 320,
    loop: false,
    dotScale: [[0, 1], [0.4, 1.38, 'out'], [1, 1, 'inOut']],
    reduced: 'static mark',
  },
  // failed: a short sideways shake of the whole mark (shape, not colour); units of the 48 grid
  error: {
    duration: 180,
    loop: false,
    shakeX: [[0, 0], [0.2, -2, 'linear'], [0.5, 2, 'linear'], [0.8, -1.25, 'linear'], [1, 0, 'linear']],
    reduced: 'static mark',
  },
  // pressed (hold while down)
  press: { duration: 140, scale: 0.94, ease: 'out', reduced: 'opacity 0.8 instead of scale' },
  // splash to first screen: the sources fade, the signal grows until it covers the screen
  morph: {
    duration: 420,
    loop: false,
    lineOpacity: [[0, 1], [0.38, 0, 'out'], [1, 0]],
    dotGrow: [[0, 0], [1, 1, 'inOut']], // 0 = the dot at rest, 1 = the dot covers the whole screen
    reduced: 'cross-fade 150 ms',
  },
};

export const bezier = (name) => `cubic-bezier(${EASE[name].join(', ')})`;
