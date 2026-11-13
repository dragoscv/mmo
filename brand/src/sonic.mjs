// MixAI sonic signature (ADR-0016 item 7, WP22-09): the same idea as the mark, in sound.
// Two tones (the sources, left and right) become one tone (the signal, centre).
//
// Synthesised by brand/scripts/lib/sonic.mjs from this definition: no samples, no third-party material, so
// the result is licence-clean. Times in seconds, frequencies in Hz, pan -1 (left) .. 1 (right).
// A voice: sine partials (`partials[k]` = level of harmonic k + 1), an attack time constant, a hold, then an
// exponential decay; `to` + `glide` slide the pitch.

export const SONIC = {
  sampleRate: 48000,
  peak: 0.5, // -6 dBFS: quieter than programme audio, it must never startle
  fadeOut: 0.08,
  // Owner gate E, 2026-11-12: "Two, then one". The other two stay as reference (shown on the demo page) and
  // are not shipped in any app.
  chosen: 'twoThenOne',
  variants: {
    // two tones slide towards each other and lock into one
    converge: {
      name: 'Converge',
      length: 1.3,
      voices: [
        { from: 293.66, to: 440, glide: [0.06, 0.52], start: 0, attack: 0.03, hold: 0.55, decay: 0.28, pan: [-0.7, 0], gain: 1, partials: [1, 0.3, 0.1] },
        { from: 659.26, to: 440, glide: [0.06, 0.52], start: 0, attack: 0.03, hold: 0.55, decay: 0.28, pan: [0.7, 0], gain: 0.8, partials: [1, 0.25, 0.08] },
        { from: 880, start: 0.5, attack: 0.05, hold: 0.1, decay: 0.3, pan: [0, 0], gain: 0.35, partials: [1, 0.15] },
      ],
    },
    // one note left, one note right, then a single note in the middle
    twoThenOne: {
      name: 'Two, then one',
      length: 1.4,
      voices: [
        { from: 440, start: 0, attack: 0.006, hold: 0.02, decay: 0.22, pan: [-0.6, -0.6], gain: 0.9, partials: [1, 0.4, 0.15, 0.05] },
        { from: 659.26, start: 0.17, attack: 0.006, hold: 0.02, decay: 0.22, pan: [0.6, 0.6], gain: 0.9, partials: [1, 0.4, 0.15, 0.05] },
        { from: 880, start: 0.37, attack: 0.008, hold: 0.06, decay: 0.38, pan: [0, 0], gain: 1, partials: [1, 0.35, 0.12, 0.04] },
        { from: 440, start: 0.37, attack: 0.02, hold: 0.06, decay: 0.42, pan: [0, 0], gain: 0.5, partials: [1, 0.2] },
      ],
    },
    // a low fifth swells from both sides and resolves into one tone
    swell: {
      name: 'Swell',
      length: 1.5,
      voices: [
        { from: 220, start: 0, attack: 0.16, hold: 0.3, decay: 0.2, pan: [-0.5, 0], gain: 1, partials: [1, 0.3, 0.1] },
        { from: 329.63, start: 0, attack: 0.16, hold: 0.3, decay: 0.2, pan: [0.5, 0], gain: 0.85, partials: [1, 0.25, 0.08] },
        { from: 440, start: 0.4, attack: 0.12, hold: 0.25, decay: 0.34, pan: [0, 0], gain: 1, partials: [1, 0.3, 0.1] },
      ],
    },
  },
};
