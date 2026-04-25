/**
 * InstrumentSynth — drives a single continuous synth voice that follows a
 * pitch + RMS stream from the live mic input. Designed for the Live Page
 * "Instrument" widget: play a violin (or any monophonic instrument) into the
 * mic and have it re-voiced as piano / organ / strings / etc.
 *
 * Architecture (per voice):
 *
 *     pitchSrc   -> osc1.frequency  (ConstantSourceNode driving frequency
 *      (smoothed via setTargetAtTime, with portamento)
 *
 *     osc1 ─┐                                      ┌── filter ── ampGain ── output
 *     osc2 ─┤  detuned + waveform per preset       │
 *     sub  ─┤  square 1-octave below (optional)    │
 *     noise─┘  band-limited (optional, breath/airy)
 *
 *     LFO -> osc1/osc2 detune (vibrato)
 *
 *     ampGain.gain follows envelope-following input RMS, gated by detection
 *     confidence. So the synth tracks "are you currently making a sound?"
 *     and "what note?", continuously, without any onset detection.
 *
 * Public API:
 *   - new InstrumentSynth(ctx)
 *   - .output: GainNode  (connect to destination / engine bus)
 *   - .setInstrument(preset)
 *   - .setVolume(0..1)
 *   - .setMix(0..1)              dry/wet (mic vs synth output level)
 *   - .setTranspose(semitones)
 *   - .setPortamento(seconds)
 *   - .setEnabled(bool)          turn synth on/off (releases voice)
 *   - .updatePitch(midi, confidence, rms)   call from the meter loop
 *   - .destroy()
 */

export type InstrumentId =
    | "piano"
    | "epiano"
    | "organ"
    | "strings"
    | "violin"
    | "cello"
    | "flute"
    | "brass"
    | "synthLead"
    | "synthPad"
    | "bass"
    | "pluck"
    | "bell"
    | "choir"
    | "guitar"
    | "whistle";

export interface InstrumentPreset {
    id: InstrumentId;
    name: string;
    /** Display category (used for grouping in the UI). */
    family: "Keys" | "Strings" | "Winds" | "Synth" | "Bass" | "Voice";
    osc1Type: OscillatorType;
    osc2Type: OscillatorType;
    osc1Gain: number;
    osc2Gain: number;
    osc2Detune: number;        // cents
    subGain: number;           // 0 = no sub
    noiseGain: number;         // 0 = no noise (used for breath instruments)
    filterType: BiquadFilterType;
    filterCutoff: number;      // Hz at base
    filterCutoffPitchTrack: number; // 0..1 — how much filter follows pitch
    filterQ: number;
    /** Amp envelope for the steady-state portion (we run continuously). */
    attackMs: number;          // attack used when re-engaging from silence
    releaseMs: number;         // release used when going silent
    /** Pitch tracking smoothness in seconds (portamento override default). */
    portamentoMs: number;
    /** Vibrato. */
    vibratoHz: number;
    vibratoCents: number;
}

const A4_HZ = 440;
const midiToHz = (m: number) => A4_HZ * Math.pow(2, (m - 69) / 12);

// ─── Presets ────────────────────────────────────────────────────────────

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
    {
        id: "piano", name: "Piano", family: "Keys",
        osc1Type: "triangle", osc2Type: "sine",
        osc1Gain: 0.7, osc2Gain: 0.4, osc2Detune: 0,
        subGain: 0.2, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 4500, filterCutoffPitchTrack: 0.6, filterQ: 0.7,
        attackMs: 5, releaseMs: 220,
        portamentoMs: 8, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "epiano", name: "Electric Piano", family: "Keys",
        osc1Type: "sine", osc2Type: "sine",
        osc1Gain: 0.65, osc2Gain: 0.5, osc2Detune: 1200,
        subGain: 0.15, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 3500, filterCutoffPitchTrack: 0.4, filterQ: 1.2,
        attackMs: 8, releaseMs: 280,
        portamentoMs: 10, vibratoHz: 4.5, vibratoCents: 6,
    },
    {
        id: "organ", name: "Organ", family: "Keys",
        osc1Type: "sine", osc2Type: "sine",
        osc1Gain: 0.55, osc2Gain: 0.45, osc2Detune: 1900,
        subGain: 0.35, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 6000, filterCutoffPitchTrack: 0.2, filterQ: 0.5,
        attackMs: 15, releaseMs: 80,
        portamentoMs: 6, vibratoHz: 6, vibratoCents: 4,
    },
    {
        id: "strings", name: "Strings", family: "Strings",
        osc1Type: "sawtooth", osc2Type: "sawtooth",
        osc1Gain: 0.5, osc2Gain: 0.5, osc2Detune: 8,
        subGain: 0.1, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 2200, filterCutoffPitchTrack: 0.55, filterQ: 0.9,
        attackMs: 110, releaseMs: 320,
        portamentoMs: 35, vibratoHz: 5, vibratoCents: 12,
    },
    {
        id: "violin", name: "Violin", family: "Strings",
        osc1Type: "sawtooth", osc2Type: "sawtooth",
        osc1Gain: 0.55, osc2Gain: 0.4, osc2Detune: 6,
        subGain: 0, noiseGain: 0.04,
        filterType: "lowpass", filterCutoff: 3200, filterCutoffPitchTrack: 0.6, filterQ: 1.4,
        attackMs: 80, releaseMs: 240,
        portamentoMs: 25, vibratoHz: 5.5, vibratoCents: 18,
    },
    {
        id: "cello", name: "Cello", family: "Strings",
        osc1Type: "sawtooth", osc2Type: "triangle",
        osc1Gain: 0.55, osc2Gain: 0.35, osc2Detune: 4,
        subGain: 0.2, noiseGain: 0.03,
        filterType: "lowpass", filterCutoff: 1600, filterCutoffPitchTrack: 0.7, filterQ: 1.2,
        attackMs: 140, releaseMs: 380,
        portamentoMs: 35, vibratoHz: 4.5, vibratoCents: 14,
    },
    {
        id: "flute", name: "Flute", family: "Winds",
        osc1Type: "sine", osc2Type: "triangle",
        osc1Gain: 0.7, osc2Gain: 0.18, osc2Detune: 0,
        subGain: 0, noiseGain: 0.12,
        filterType: "bandpass", filterCutoff: 2500, filterCutoffPitchTrack: 0.85, filterQ: 1.5,
        attackMs: 50, releaseMs: 180,
        portamentoMs: 15, vibratoHz: 5, vibratoCents: 10,
    },
    {
        id: "brass", name: "Brass", family: "Winds",
        osc1Type: "sawtooth", osc2Type: "square",
        osc1Gain: 0.55, osc2Gain: 0.3, osc2Detune: 0,
        subGain: 0.1, noiseGain: 0.02,
        filterType: "lowpass", filterCutoff: 1800, filterCutoffPitchTrack: 0.8, filterQ: 1.4,
        attackMs: 70, releaseMs: 200,
        portamentoMs: 18, vibratoHz: 4, vibratoCents: 8,
    },
    {
        id: "synthLead", name: "Synth Lead", family: "Synth",
        osc1Type: "sawtooth", osc2Type: "square",
        osc1Gain: 0.55, osc2Gain: 0.45, osc2Detune: 7,
        subGain: 0.3, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 4000, filterCutoffPitchTrack: 0.5, filterQ: 4,
        attackMs: 4, releaseMs: 80,
        portamentoMs: 12, vibratoHz: 5, vibratoCents: 6,
    },
    {
        id: "synthPad", name: "Synth Pad", family: "Synth",
        osc1Type: "sawtooth", osc2Type: "sawtooth",
        osc1Gain: 0.5, osc2Gain: 0.5, osc2Detune: 14,
        subGain: 0.25, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 1700, filterCutoffPitchTrack: 0.4, filterQ: 1.1,
        attackMs: 220, releaseMs: 600,
        portamentoMs: 50, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "bass", name: "Bass", family: "Bass",
        osc1Type: "square", osc2Type: "sawtooth",
        osc1Gain: 0.5, osc2Gain: 0.4, osc2Detune: 5,
        subGain: 0.6, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 700, filterCutoffPitchTrack: 0.6, filterQ: 4,
        attackMs: 6, releaseMs: 100,
        portamentoMs: 6, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "pluck", name: "Pluck", family: "Synth",
        osc1Type: "square", osc2Type: "triangle",
        osc1Gain: 0.6, osc2Gain: 0.35, osc2Detune: 0,
        subGain: 0.15, noiseGain: 0,
        filterType: "lowpass", filterCutoff: 3500, filterCutoffPitchTrack: 0.5, filterQ: 3,
        attackMs: 2, releaseMs: 220,
        portamentoMs: 4, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "bell", name: "Bell", family: "Keys",
        osc1Type: "sine", osc2Type: "sine",
        osc1Gain: 0.7, osc2Gain: 0.3, osc2Detune: 1500,
        subGain: 0, noiseGain: 0,
        filterType: "highpass", filterCutoff: 700, filterCutoffPitchTrack: 0, filterQ: 0.7,
        attackMs: 2, releaseMs: 600,
        portamentoMs: 6, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "choir", name: "Choir", family: "Voice",
        osc1Type: "sawtooth", osc2Type: "triangle",
        osc1Gain: 0.4, osc2Gain: 0.35, osc2Detune: 7,
        subGain: 0.15, noiseGain: 0.04,
        filterType: "bandpass", filterCutoff: 900, filterCutoffPitchTrack: 0.9, filterQ: 2.5,
        attackMs: 180, releaseMs: 420,
        portamentoMs: 40, vibratoHz: 5, vibratoCents: 14,
    },
    {
        id: "guitar", name: "Guitar", family: "Strings",
        osc1Type: "sawtooth", osc2Type: "triangle",
        osc1Gain: 0.55, osc2Gain: 0.35, osc2Detune: 4,
        subGain: 0.15, noiseGain: 0.02,
        filterType: "lowpass", filterCutoff: 2400, filterCutoffPitchTrack: 0.5, filterQ: 1.5,
        attackMs: 8, releaseMs: 320,
        portamentoMs: 6, vibratoHz: 0, vibratoCents: 0,
    },
    {
        id: "whistle", name: "Whistle", family: "Winds",
        osc1Type: "sine", osc2Type: "sine",
        osc1Gain: 0.85, osc2Gain: 0.1, osc2Detune: 0,
        subGain: 0, noiseGain: 0.08,
        filterType: "bandpass", filterCutoff: 2800, filterCutoffPitchTrack: 0.9, filterQ: 5,
        attackMs: 30, releaseMs: 140,
        portamentoMs: 12, vibratoHz: 5, vibratoCents: 6,
    },
];

export function getPreset(id: InstrumentId): InstrumentPreset {
    return INSTRUMENT_PRESETS.find((p) => p.id === id) ?? INSTRUMENT_PRESETS[0];
}

// ─── Synth ──────────────────────────────────────────────────────────────

export class InstrumentSynth {
    readonly output: GainNode;
    private ctx: AudioContext;

    private osc1: OscillatorNode;
    private osc2: OscillatorNode;
    private sub: OscillatorNode;
    private noise: AudioBufferSourceNode;
    private noiseGain: GainNode;
    private osc1Gain: GainNode;
    private osc2Gain: GainNode;
    private subGain: GainNode;
    private filter: BiquadFilterNode;
    private ampGain: GainNode;          // envelope-followed amplitude
    private masterGain: GainNode;       // user volume

    private vibrato: OscillatorNode;
    private vibratoDepth: GainNode;     // multiplies LFO by depth (cents)

    private preset: InstrumentPreset;
    private enabled = false;
    private transposeSemis = 0;
    private portamentoOverrideMs: number | null = null;
    private destroyed = false;
    /** Smoothed envelope follower state. */
    private envValue = 0;
    /** Last MIDI note we played (used for octave-jump rejection). */
    private lastPlayedMidi: number = -1;
    /** Recent detected (post-octave-correction) MIDI notes — for median smoothing. */
    private noteHistory: number[] = [];
    /** Number of consecutive frames where the detector wanted a different
     *  octave than our anchor. Used to allow legitimate octave jumps from
     *  the user after persistent disagreement. */
    private octaveDisagreeFrames = 0;
    /** Counts consecutive frames where the input is below the silence floor.
     *  Once it crosses a threshold we hard-mute the voice immediately so the
     *  synth doesn't sustain like an echo when the user stops playing. */
    private silentFrameCount = 0;
    /** Below this combined (rms × confidence) value we treat input as silence. */
    private static readonly SILENCE_THRESHOLD = 0.01;
    /** Frames of consecutive silence after which we force a hard release. */
    private static readonly SILENCE_FRAMES_TO_KILL = 2;
    /** Hard-release time used when silence is detected (much faster than the
     *  preset release, so the synth doesn't echo after the user stops). */
    private static readonly HARD_RELEASE_S = 0.05;

    constructor(ctx: AudioContext) {
        this.ctx = ctx;
        this.preset = INSTRUMENT_PRESETS[0];

        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = 0.6;

        this.ampGain = ctx.createGain();
        this.ampGain.gain.value = 0;

        this.filter = ctx.createBiquadFilter();
        this.filter.type = this.preset.filterType;
        this.filter.frequency.value = this.preset.filterCutoff;
        this.filter.Q.value = this.preset.filterQ;

        // Output bus
        this.output = ctx.createGain();
        this.output.gain.value = 1;

        // ──── Source layer ────
        this.osc1 = ctx.createOscillator();
        this.osc1.type = this.preset.osc1Type;
        this.osc1Gain = ctx.createGain();
        this.osc1Gain.gain.value = this.preset.osc1Gain;
        this.osc1.connect(this.osc1Gain).connect(this.filter);

        this.osc2 = ctx.createOscillator();
        this.osc2.type = this.preset.osc2Type;
        this.osc2.detune.value = this.preset.osc2Detune;
        this.osc2Gain = ctx.createGain();
        this.osc2Gain.gain.value = this.preset.osc2Gain;
        this.osc2.connect(this.osc2Gain).connect(this.filter);

        this.sub = ctx.createOscillator();
        this.sub.type = "sine";
        this.subGain = ctx.createGain();
        this.subGain.gain.value = this.preset.subGain;
        this.sub.connect(this.subGain).connect(this.filter);

        // Noise (1s loop of white noise)
        const noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        this.noise = ctx.createBufferSource();
        this.noise.buffer = noiseBuf;
        this.noise.loop = true;
        this.noiseGain = ctx.createGain();
        this.noiseGain.gain.value = this.preset.noiseGain;
        this.noise.connect(this.noiseGain).connect(this.filter);

        this.filter.connect(this.ampGain).connect(this.masterGain).connect(this.output);

        // ──── Vibrato LFO ────
        this.vibrato = ctx.createOscillator();
        this.vibrato.frequency.value = this.preset.vibratoHz || 0.0001;
        this.vibratoDepth = ctx.createGain();
        this.vibratoDepth.gain.value = this.preset.vibratoCents;
        this.vibrato.connect(this.vibratoDepth);
        this.vibratoDepth.connect(this.osc1.detune);
        this.vibratoDepth.connect(this.osc2.detune);

        // Initial frequency — silent, so anything is fine
        const f = midiToHz(60);
        this.osc1.frequency.value = f;
        this.osc2.frequency.value = f;
        this.sub.frequency.value = f / 2;

        const t = ctx.currentTime;
        this.osc1.start(t);
        this.osc2.start(t);
        this.sub.start(t);
        this.noise.start(t);
        this.vibrato.start(t);
    }

    // ─── Public API ───────────────────────────────────────────────

    setInstrument(id: InstrumentId): void {
        this.preset = getPreset(id);
        const t = this.ctx.currentTime;

        this.osc1.type = this.preset.osc1Type;
        this.osc2.type = this.preset.osc2Type;
        this.osc2.detune.setTargetAtTime(this.preset.osc2Detune, t, 0.02);

        this.osc1Gain.gain.setTargetAtTime(this.preset.osc1Gain, t, 0.05);
        this.osc2Gain.gain.setTargetAtTime(this.preset.osc2Gain, t, 0.05);
        this.subGain.gain.setTargetAtTime(this.preset.subGain, t, 0.05);
        this.noiseGain.gain.setTargetAtTime(this.preset.noiseGain, t, 0.05);

        this.filter.type = this.preset.filterType;
        this.filter.Q.setTargetAtTime(this.preset.filterQ, t, 0.05);

        this.vibrato.frequency.setTargetAtTime(this.preset.vibratoHz || 0.0001, t, 0.05);
        this.vibratoDepth.gain.setTargetAtTime(this.preset.vibratoCents, t, 0.05);
    }

    /** Volume in 0..1. */
    setVolume(v: number): void {
        const clamped = Math.max(0, Math.min(1, v));
        this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
    }

    /** Transpose the played note by `semitones`. */
    setTranspose(semitones: number): void {
        this.transposeSemis = Math.max(-48, Math.min(48, Math.round(semitones)));
    }

    /** Override the preset's portamento, in ms. Pass null to use preset value. */
    setPortamento(ms: number | null): void {
        this.portamentoOverrideMs = ms;
    }

    /** Enable / disable the synth. When disabled, voice is muted (released). */
    setEnabled(on: boolean): void {
        this.enabled = on;
        if (!on) {
            const t = this.ctx.currentTime;
            this.ampGain.gain.cancelScheduledValues(t);
            this.ampGain.gain.setTargetAtTime(0, t, 0.05);
            this.envValue = 0;
            // Reset pitch history so re-enabling doesn't drag the new note
            // toward the previously played octave.
            this.lastPlayedMidi = -1;
            this.noteHistory.length = 0;
            this.silentFrameCount = 0;
            this.octaveDisagreeFrames = 0;
        }
    }

    get isEnabled(): boolean { return this.enabled; }
    get currentInstrument(): InstrumentId { return this.preset.id; }

    /**
     * Drive the synth voice from the live pitch detector. Call from the
     * meter loop. `midi` should be the detected MIDI note number; pass any
     * negative number / NaN to indicate "no pitch detected". `confidence`
     * 0..1 — used to gate the envelope follower. `rms` 0..1 — used as the
     * envelope target.
     */
    updatePitch(midi: number, confidence: number, rms: number): void {
        if (this.destroyed) return;
        const t = this.ctx.currentTime;

        // ── 1. Silence detection ────────────────────────────────────
        // YIN can keep reporting a pitch when the user is silent (it locks
        // on to room tone). We must not trust `midi`/`confidence` alone;
        // the actual mic level is the ground truth. If the combined energy
        // is below the floor for a couple of frames, hard-release.
        const energy = Math.max(0, rms) * Math.max(0, confidence);
        const isSilent = energy < InstrumentSynth.SILENCE_THRESHOLD;
        if (isSilent) {
            this.silentFrameCount++;
        } else {
            this.silentFrameCount = 0;
        }
        const hardSilence =
            this.silentFrameCount >= InstrumentSynth.SILENCE_FRAMES_TO_KILL;

        // ── 2. Pitch update with octave-jump rejection ──────────────
        // Only trust the detector when we have at least some signal.
        if (Number.isFinite(midi) && midi >= 0 && !hardSilence && confidence > 0.4) {
            const rawDetected = midi;
            let detected = rawDetected;

            // Hard octave-snap: pull the detection to the octave nearest the
            // anchor. YIN-style detectors very commonly mis-octave (±12) on
            // harmonic-rich monophonic input — we kill those errors entirely
            // by *always* snapping back, regardless of how big the gap is.
            //
            // Real octave moves by the user are detected separately: when
            // the detector keeps insisting on a different octave for many
            // consecutive frames, we surrender and accept the new octave.
            if (this.lastPlayedMidi >= 0) {
                let best = rawDetected;
                let bestDist = Math.abs(rawDetected - this.lastPlayedMidi);
                for (let k = -2; k <= 2; k++) {
                    if (k === 0) continue;
                    const cand = rawDetected + 12 * k;
                    const d = Math.abs(cand - this.lastPlayedMidi);
                    if (d < bestDist) { bestDist = d; best = cand; }
                }
                if (best !== rawDetected) {
                    // Detector wanted a different octave; force-snap and
                    // count this disagreement.
                    this.octaveDisagreeFrames++;
                    if (this.octaveDisagreeFrames > 10) {
                        // Persistent — the user really moved octave. Accept
                        // the raw detection and re-anchor immediately.
                        detected = rawDetected;
                        this.octaveDisagreeFrames = 0;
                        this.noteHistory.length = 0;
                        this.lastPlayedMidi = rawDetected;
                    } else {
                        detected = best;
                    }
                } else {
                    // Detector agrees with our octave — relax disagreement.
                    this.octaveDisagreeFrames = Math.max(0, this.octaveDisagreeFrames - 1);
                }
            }

            // Median-smooth across a small history window so single bad
            // detections don't make the synth jump. Median (not mean) is
            // resistant to one-off outliers.
            this.noteHistory.push(detected);
            if (this.noteHistory.length > 5) this.noteHistory.shift();
            const sorted = [...this.noteHistory].sort((a, b) => a - b);
            const smoothedMidi = sorted[Math.floor(sorted.length / 2)];

            this.lastPlayedMidi = smoothedMidi;
            const targetMidi = smoothedMidi + this.transposeSemis;
            const f = Math.max(20, Math.min(this.ctx.sampleRate / 2 - 500, midiToHz(targetMidi)));
            const portMs = this.portamentoOverrideMs ?? this.preset.portamentoMs;
            const tau = Math.max(0.001, portMs / 1000);
            this.osc1.frequency.setTargetAtTime(f, t, tau);
            this.osc2.frequency.setTargetAtTime(f, t, tau);
            this.sub.frequency.setTargetAtTime(f / 2, t, tau);

            // Filter cutoff also tracks pitch (per preset).
            const baseCutoff = this.preset.filterCutoff;
            const trackedCutoff =
                baseCutoff * Math.pow(2, this.preset.filterCutoffPitchTrack * (targetMidi - 60) / 12);
            this.filter.frequency.setTargetAtTime(
                Math.max(40, Math.min(this.ctx.sampleRate / 2 - 200, trackedCutoff)),
                t,
                Math.max(tau, 0.02),
            );
        }

        // ── 3. Envelope follower → ampGain ──────────────────────────
        if (!this.enabled) return;

        if (hardSilence) {
            // Snap envelope to zero quickly. We bypass the soft follower so
            // long-release presets (pads) don't ring on after the user stops.
            this.envValue = 0;
            this.noteHistory.length = 0;
            // Forget the anchor: the *next* note may be in a totally
            // different octave from the previous phrase, and we don't want
            // octave-snap to drag it back.
            this.lastPlayedMidi = -1;
            this.octaveDisagreeFrames = 0;
            try {
                this.ampGain.gain.cancelScheduledValues(t);
            } catch { /* */ }
            this.ampGain.gain.setTargetAtTime(0, t, InstrumentSynth.HARD_RELEASE_S / 3);
            return;
        }

        const confidentTarget = confidence > 0.4 ? Math.min(1, rms * 3) : 0;
        // Per-frame coefficient (≈30 Hz call rate). Attack tracks fast, the
        // soft release path is only used while signal is *present* — once
        // we cross the silence threshold the hard-silence branch above
        // takes over and snaps to 0.
        const a =
            confidentTarget > this.envValue
                ? Math.max(0.05, 1 / Math.max(1, this.preset.attackMs / 33))
                : Math.max(0.1, 1 / Math.max(1, this.preset.releaseMs / 33));
        this.envValue = this.envValue + (confidentTarget - this.envValue) * a;
        if (this.envValue < 1e-4) this.envValue = 0;
        this.ampGain.gain.setTargetAtTime(this.envValue, t, 0.02);
    }

    destroy(): void {
        this.destroyed = true;
        try { this.osc1.stop(); } catch { /* */ }
        try { this.osc2.stop(); } catch { /* */ }
        try { this.sub.stop(); } catch { /* */ }
        try { this.noise.stop(); } catch { /* */ }
        try { this.vibrato.stop(); } catch { /* */ }
        try { this.output.disconnect(); } catch { /* */ }
    }
}
