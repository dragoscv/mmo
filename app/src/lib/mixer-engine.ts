"use client";

import { audioPreloadCache } from "./audio-preload-cache";

/**
 * DJ Mixer Audio Engine
 *
 * Two independent decks, each with:
 * - Audio element + Web Audio nodes
 * - 3-band EQ (Low/Mid/Hi) via BiquadFilters
 * - Volume gain, kill switches
 * - Tempo (playbackRate) control with pitch preservation via detune
 * - Loop control (start/end with beat-based lengths)
 * - Key shift via detune (semitones)
 *
 * Master crossfader blends both decks.
 */

export interface DeckState {
    trackId: number | null;
    trackTitle: string;
    trackArtist: string;
    trackArtworkUrl: string | null;
    isPlaying: boolean;
    isLoaded: boolean;
    currentTime: number;
    duration: number;
    bpm: number;
    originalBpm: number;
    key: string;
    originalKey: string;
    keyShift: number; // semitones (-12 to +12)
    keyLock: boolean; // preserve pitch when changing tempo
    volume: number; // 0-2 (linear gain)
    eqLow: number; // dB, -26 to +6
    eqMid: number;
    eqHi: number;
    eqLowKill: boolean;
    eqMidKill: boolean;
    eqHiKill: boolean;
    loopEnabled: boolean;
    loopStart: number; // seconds
    loopEnd: number; // seconds
    loopBeats: number; // 0.25, 0.5, 1, 2, 4, 8, 16, 32
    hotCues: (number | null)[]; // up to 8 cue points in seconds
    filter: number; // -1 (LPF) to 0 (off) to +1 (HPF)
    filterType: FilterType;
    colorFx: number; // -1 to 0 (off) to +1
    colorFxType: ColorFxType;
    beatFxType: BeatFxType;
    beatFxAmount: number; // 0 to 1
    beatFxOn: boolean;
    beatFxBeatDiv: number; // beat division: 0.25, 0.5, 1, 2, 4
    slipMode: boolean;
    quantize: boolean;
    headphoneCue: boolean; // pre-fader listen
    padMode: PadMode;
    autoGain: number; // computed gain correction (linear)
    beatGrid: BeatGridState;
    crossfaderAssign: CrossfaderAssign; // thru / A / B
}

// ─── Filter Types ────────────────────────────────────────────────────────

export type FilterType =
    | "lpf-hpf"       // Classic LP/HP filter (default)
    | "lpf"            // Low Pass only
    | "hpf"            // High Pass only
    | "bpf"            // Band Pass
    | "notch"          // Notch / Band Reject
    | "sweep"          // Full sweep LP→HP
    | "resonance";     // Resonant filter

export type ColorFxType =
    | "echo"           // Echo effect
    | "reverb"         // Reverb wash
    | "flanger"        // Flanger
    | "phaser"         // Phaser
    | "crusher"        // Bit Crusher (simulated)
    | "noise"          // Noise gate sweep
    | "dub-echo"       // Dub Echo
    | "spiral"         // Spiral (HP + resonance build)
    | "wash"           // Reverb wash (LP + high Q)
    | "gate"           // Gate chop effect
    | "formant"        // Vowel/Formant filter
    | "pitch"          // Pitch shift feel
    | "telephone"      // Telephone/radio effect
    | "rumble"         // Sub bass rumble
    | "tinny"          // Tinny/thin
    | "vinyl"          // Vinyl crackle simulation
    | "radio";         // AM Radio

export type BeatFxType =
    | "delay"          // Beat-synced delay
    | "echo"           // Echo with feedback
    | "reverb"         // Reverb (convolver simulation via feedback delay)
    | "flanger"        // Flanger (short modulated delay)
    | "phaser"         // Phaser (allpass chain)
    | "trans"          // Transform (gate)
    | "roll"           // Beat repeat / loop roll
    | "filter"         // Filter sweep (beat-synced)
    | "spiral"         // Spiral (pitch + echo)
    | "noise"          // White noise blend
    | "crush"          // Bit crush
    | "ping-pong";     // Stereo ping-pong delay

export type PadMode = "hotcue" | "beatloop" | "beatjump" | "sampler";

export type CrossfaderCurve = "linear" | "smooth" | "sharp";
export type EQMode = "eq" | "isolator";
export type CrossfaderAssign = "thru" | "A" | "B";
export type WaveformMode = "rgb" | "blue" | "3band";
export type DeckSide = "A" | "B" | "C" | "D";
export type DeckMode = "2deck" | "4deck";

export const DECK_COLORS: Record<DeckSide, string> = {
    A: "rgb(168,85,247)",  // purple
    B: "rgb(59,130,246)",  // blue
    C: "rgb(234,179,8)",   // yellow
    D: "rgb(239,68,68)",   // red
};

// ─── Sampler Types ───────────────────────────────────────────────────────

export interface SamplerSlot {
    id: number;
    name: string;
    buffer: AudioBuffer | null;
    isPlaying: boolean;
    volume: number; // 0-1
    isLooping: boolean;
}

// ─── Beat Grid Types ─────────────────────────────────────────────────────

export interface BeatGridState {
    offset: number;    // grid offset in seconds from track start
    bpm: number;       // adjusted BPM (may differ from detected BPM)
    isLocked: boolean; // prevent accidental edits
}

// ─── Mix History / Undo ──────────────────────────────────────────────────

export interface MixAction {
    id: number;
    timestamp: number;
    type: string;       // e.g. "crossfader", "eq", "volume", "load", "play"
    deck: "A" | "B" | "C" | "D" | null;
    description: string;
    prevValue: unknown;
    newValue: unknown;
}

// ─── Automix Types ───────────────────────────────────────────────────────

export type AutomixMode = "fade" | "cut" | "smart";

export interface AutomixConfig {
    enabled: boolean;
    mode: AutomixMode;
    fadeDuration: number; // seconds (4-32)
    minPlayTime: number;  // minimum play time before transition (seconds)
}

// ─── Transition Suggestion ───────────────────────────────────────────────

export interface TransitionSuggestion {
    targetTrackId: number;
    targetTitle: string;
    targetArtist: string;
    score: number;        // 0-100
    keyCompatibility: "perfect" | "compatible" | "energy-boost" | "clash";
    bpmDiff: number;
    energyDiff: number;
    reason: string;
}

export const BEAT_FX_TYPES: { id: BeatFxType; name: string }[] = [
    { id: "delay", name: "Delay" },
    { id: "echo", name: "Echo" },
    { id: "reverb", name: "Reverb" },
    { id: "flanger", name: "Flanger" },
    { id: "phaser", name: "Phaser" },
    { id: "trans", name: "Trans" },
    { id: "roll", name: "Roll" },
    { id: "filter", name: "Filter" },
    { id: "spiral", name: "Spiral" },
    { id: "noise", name: "Noise" },
    { id: "crush", name: "Crush" },
    { id: "ping-pong", name: "Ping Pong" },
];

export const FILTER_TYPES: { id: FilterType; name: string }[] = [
    { id: "lpf-hpf", name: "LPF/HPF" },
    { id: "lpf", name: "Low Pass" },
    { id: "hpf", name: "High Pass" },
    { id: "bpf", name: "Band Pass" },
    { id: "notch", name: "Notch" },
    { id: "sweep", name: "Full Sweep" },
    { id: "resonance", name: "Resonance" },
];

export const COLOR_FX_TYPES: { id: ColorFxType; name: string; category: string }[] = [
    // Color FX
    { id: "echo", name: "Echo", category: "Color FX" },
    { id: "reverb", name: "Reverb", category: "Color FX" },
    { id: "flanger", name: "Flanger", category: "Color FX" },
    { id: "phaser", name: "Phaser", category: "Color FX" },
    { id: "crusher", name: "Bit Crusher", category: "Color FX" },
    { id: "dub-echo", name: "Dub Echo", category: "Color FX" },
    { id: "spiral", name: "Spiral", category: "Color FX" },
    { id: "wash", name: "Wash", category: "Color FX" },
    { id: "gate", name: "Gate", category: "Color FX" },
    // Character
    { id: "formant", name: "Formant", category: "Character" },
    { id: "pitch", name: "Pitch", category: "Character" },
    { id: "telephone", name: "Telephone", category: "Character" },
    { id: "rumble", name: "Rumble", category: "Character" },
    { id: "tinny", name: "Tinny", category: "Character" },
    { id: "vinyl", name: "Vinyl", category: "Character" },
    { id: "radio", name: "AM Radio", category: "Character" },
    { id: "noise", name: "Noise Gate", category: "Character" },
];

export const DEFAULT_DECK_STATE: DeckState = {
    trackId: null,
    trackTitle: "",
    trackArtist: "",
    trackArtworkUrl: null,
    isPlaying: false,
    isLoaded: false,
    currentTime: 0,
    duration: 0,
    bpm: 120,
    originalBpm: 120,
    key: "",
    originalKey: "",
    keyShift: 0,
    keyLock: false,
    volume: 1,
    eqLow: 0,
    eqMid: 0,
    eqHi: 0,
    eqLowKill: false,
    eqMidKill: false,
    eqHiKill: false,
    loopEnabled: false,
    loopStart: 0,
    loopEnd: 0,
    loopBeats: 4,
    hotCues: [null, null, null, null, null, null, null, null],
    filter: 0,
    filterType: "lpf-hpf" as FilterType,
    colorFx: 0,
    colorFxType: "echo" as ColorFxType,
    beatFxType: "delay" as BeatFxType,
    beatFxAmount: 0,
    beatFxOn: false,
    beatFxBeatDiv: 1,
    slipMode: false,
    quantize: false,
    headphoneCue: false,
    padMode: "hotcue" as PadMode,
    autoGain: 1,
    beatGrid: { offset: 0, bpm: 120, isLocked: false },
    crossfaderAssign: "thru" as CrossfaderAssign,
};

// Musical key names for display
const KEY_NAMES = [
    "C", "C#", "D", "D#", "E", "F",
    "F#", "G", "G#", "A", "A#", "B",
];

export function shiftKeyName(originalKey: string, semitones: number): string {
    if (!originalKey) return "";
    // Parse key like "8A", "11B", "Cm", "F#m" etc
    const match = originalKey.match(/^(\d+)([AB])$/);
    if (match) {
        // Camelot notation
        let num = parseInt(match[1]);
        const letter = match[2];
        num = ((num - 1 + semitones + 120) % 12) + 1;
        return `${num}${letter}`;
    }
    // Try standard notation
    const stdMatch = originalKey.match(/^([A-G]#?b?)(m?)$/i);
    if (stdMatch) {
        const note = stdMatch[1].toUpperCase();
        const minor = stdMatch[2];
        const idx = KEY_NAMES.indexOf(note);
        if (idx >= 0) {
            const newIdx = (idx + semitones + 120) % 12;
            return `${KEY_NAMES[newIdx]}${minor}`;
        }
    }
    return originalKey;
}

export class DeckEngine {
    audio: HTMLAudioElement;
    private ctx: AudioContext;
    private source: MediaElementAudioSourceNode | null = null;
    private gainNode: GainNode;
    private autoGainNode: GainNode;
    private eqLowNode: BiquadFilterNode;
    private eqMidNode: BiquadFilterNode;
    private eqHiNode: BiquadFilterNode;
    private filterNode: BiquadFilterNode;
    private colorFxNode: BiquadFilterNode;
    // Beat FX nodes
    private beatFxDry: GainNode;
    private beatFxWet: GainNode;
    private beatFxDelay: DelayNode;
    private beatFxFeedback: GainNode;
    private beatFxFilter: BiquadFilterNode;
    private beatFxActive = false; // track if beat FX feedback loop is connected
    analyser: AnalyserNode;
    private destination: GainNode; // connects to crossfader
    private cueDestination: GainNode | null = null; // headphone cue bus
    private cueSendGain: GainNode; // pre-fader send to cue
    private loopRAF: number | null = null;
    private lastTimeNotify = 0; // throttle onTimeUpdate to ~4Hz

    // Pitch bend state
    private basePlaybackRate = 1.0;
    private bendAmount = 0;
    private bendDecayRAF: number | null = null;
    private keyLock = false;
    private keyShiftCents = 0;

    // Slip mode state
    private slipActive = false;
    private slipPosition = 0;
    private slipStartTime = 0;
    private slipPlaybackRate = 1;

    // EQ mode
    private eqMode: EQMode = "eq";

    onTimeUpdate?: (time: number) => void;
    onEnded?: () => void;
    onLoaded?: (duration: number) => void;

    constructor(ctx: AudioContext, output: GainNode, cueOutput?: GainNode) {
        this.ctx = ctx;
        this.destination = output;
        this.cueDestination = cueOutput || null;

        this.audio = new Audio();
        this.audio.crossOrigin = "anonymous";
        this.audio.preload = "auto";
        this.audio.preservesPitch = false; // natural pitch follows tempo by default

        // Create source
        this.source = ctx.createMediaElementSource(this.audio);

        // EQ chain: source → autoGain → low → mid → hi → filter → colorFx → beatFx → gain → analyser → output
        this.autoGainNode = ctx.createGain();
        this.autoGainNode.gain.value = 1;

        this.eqLowNode = ctx.createBiquadFilter();
        this.eqLowNode.type = "lowshelf";
        this.eqLowNode.frequency.value = 320;
        this.eqLowNode.gain.value = 0;

        this.eqMidNode = ctx.createBiquadFilter();
        this.eqMidNode.type = "peaking";
        this.eqMidNode.frequency.value = 1000;
        this.eqMidNode.Q.value = 0.7;
        this.eqMidNode.gain.value = 0;

        this.eqHiNode = ctx.createBiquadFilter();
        this.eqHiNode.type = "highshelf";
        this.eqHiNode.frequency.value = 3200;
        this.eqHiNode.gain.value = 0;

        this.filterNode = ctx.createBiquadFilter();
        this.filterNode.type = "allpass";
        this.filterNode.frequency.value = 1000;
        this.filterNode.Q.value = 1;

        this.colorFxNode = ctx.createBiquadFilter();
        this.colorFxNode.type = "allpass";
        this.colorFxNode.frequency.value = 1000;
        this.colorFxNode.Q.value = 1;

        // Beat FX: parallel dry/wet with delay + feedback loop
        this.beatFxDry = ctx.createGain();
        this.beatFxDry.gain.value = 1;
        this.beatFxWet = ctx.createGain();
        this.beatFxWet.gain.value = 0;
        this.beatFxDelay = ctx.createDelay(4); // max 4 seconds
        this.beatFxDelay.delayTime.value = 0.5;
        this.beatFxFeedback = ctx.createGain();
        this.beatFxFeedback.gain.value = 0;
        this.beatFxFilter = ctx.createBiquadFilter();
        this.beatFxFilter.type = "lowpass";
        this.beatFxFilter.frequency.value = 8000;

        this.gainNode = ctx.createGain();
        this.gainNode.gain.value = 1;

        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;

        // Headphone cue pre-fader send
        this.cueSendGain = ctx.createGain();
        this.cueSendGain.gain.value = 0; // off by default

        // Connect main chain
        this.source.connect(this.autoGainNode);
        this.autoGainNode.connect(this.eqLowNode);
        this.eqLowNode.connect(this.eqMidNode);
        this.eqMidNode.connect(this.eqHiNode);
        this.eqHiNode.connect(this.filterNode);
        this.filterNode.connect(this.colorFxNode);

        // Beat FX: colorFx → dry path + wet path → merge → gain
        const beatFxMerge = ctx.createGain();
        this.colorFxNode.connect(this.beatFxDry);
        this.beatFxDry.connect(beatFxMerge);
        // Wet path: colorFx → delay → filter → wet gain → merge
        this.colorFxNode.connect(this.beatFxDelay);
        this.beatFxDelay.connect(this.beatFxFilter);
        this.beatFxFilter.connect(this.beatFxWet);
        this.beatFxWet.connect(beatFxMerge);
        // Feedback: filter → feedback → delay
        this.beatFxFilter.connect(this.beatFxFeedback);
        this.beatFxFeedback.connect(this.beatFxDelay);

        beatFxMerge.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        this.analyser.connect(this.destination);

        // Headphone cue: tap pre-fader (after EQ, before gain)
        this.colorFxNode.connect(this.cueSendGain);
        if (this.cueDestination) {
            this.cueSendGain.connect(this.cueDestination);
        }

        // Event listeners
        this.audio.addEventListener("loadedmetadata", () => {
            this.onLoaded?.(this.audio.duration);
        });
        this.audio.addEventListener("ended", () => {
            this.onEnded?.();
        });

        this.startTimeTracking();
    }

    private startTimeTracking() {
        const update = (now: number) => {
            if (!this.audio.paused) {
                // Throttle React state updates to ~4Hz (every 250ms) instead of 60fps
                if (now - this.lastTimeNotify >= 250) {
                    this.lastTimeNotify = now;
                    this.onTimeUpdate?.(this.audio.currentTime);
                }

                // Loop logic (must still check every frame)
                if (this.audio.dataset.loopEnabled === "true") {
                    const loopEnd = parseFloat(this.audio.dataset.loopEnd || "0");
                    if (loopEnd > 0 && this.audio.currentTime >= loopEnd) {
                        const loopStart = parseFloat(this.audio.dataset.loopStart || "0");
                        this.audio.currentTime = loopStart;
                    }
                }
            }
            this.loopRAF = requestAnimationFrame(update);
        };
        this.loopRAF = requestAnimationFrame(update);
    }

    /** Smoothly ramp an AudioParam to avoid clicks/zipper noise.
     *  Uses cancel → snapshot → linearRamp pattern for glitch-free transitions. */
    private rampParam(param: AudioParam, value: number, rampTime = 0.01) {
        const now = this.ctx.currentTime;
        param.cancelScheduledValues(now);
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(value, now + rampTime);
    }

    /** Read current playback time directly — no React overhead. Use in rAF draw loops. */
    getCurrentTime(): number {
        return this.audio.currentTime;
    }

    /** Read duration directly */
    getDuration(): number {
        return this.audio.duration || 0;
    }

    /** Check if currently playing */
    getIsPlaying(): boolean {
        return !this.audio.paused;
    }

    loadTrack(trackId: number) {
        // Use cached blob URL if available, start preloading in background
        this.audio.src = audioPreloadCache.getUrl(trackId);
        this.audio.load();
        // Ensure track is fully cached for resilience
        audioPreloadCache.preload(trackId).then(url => {
            // Upgrade to blob URL if we're still on this track and using streaming
            if (this.audio.src !== url && this.audio.src.includes(`/api/audio/${trackId}`)) {
                const wasTime = this.audio.currentTime;
                const wasPlaying = !this.audio.paused;
                this.audio.src = url;
                this.audio.load();
                this.audio.addEventListener("loadedmetadata", () => {
                    if (wasTime > 0 && wasTime < this.audio.duration) {
                        this.audio.currentTime = wasTime;
                    }
                    if (wasPlaying) this.audio.play().catch(() => { });
                }, { once: true });
            }
        }).catch(() => { /* fallback: keep streaming URL */ });
    }

    play() {
        if (this.ctx.state === "suspended") this.ctx.resume();
        this.audio.play().catch(() => { });
    }

    pause() {
        this.audio.pause();
    }

    seek(time: number) {
        this.audio.currentTime = Math.max(0, Math.min(time, this.audio.duration || 0));
    }

    /** Nudge playback forward/backward by a small amount (for beatmatching) */
    /** Nudge: temporary pitch bend that decays back to base tempo.
     *  Positive = speed up (push track forward), Negative = slow down (pull back).
     *  Amount is a percentage of playback rate (e.g., 0.04 = 4% speed boost). */
    nudge(amount: number) {
        this.bendAmount = Math.max(-0.15, Math.min(0.15, amount));
        this.audio.playbackRate = Math.max(0.5, Math.min(2.0, this.basePlaybackRate + this.bendAmount));
    }

    /** Release nudge — smoothly decay bend back to zero */
    releaseNudge() {
        if (this.bendDecayRAF) cancelAnimationFrame(this.bendDecayRAF);

        const decay = () => {
            if (Math.abs(this.bendAmount) < 0.001) {
                this.bendAmount = 0;
                this.audio.playbackRate = this.basePlaybackRate;
                this.bendDecayRAF = null;
                return;
            }
            this.bendAmount *= 0.85; // exponential decay
            this.audio.playbackRate = Math.max(0.5, Math.min(2.0, this.basePlaybackRate + this.bendAmount));
            this.bendDecayRAF = requestAnimationFrame(decay);
        };
        this.bendDecayRAF = requestAnimationFrame(decay);
    }

    /** Quick nudge for button press: apply a burst then auto-release */
    nudgeBurst(direction: number, strength: number = 0.04) {
        if (this.bendDecayRAF) cancelAnimationFrame(this.bendDecayRAF);
        this.bendAmount = direction > 0 ? strength : -strength;
        this.audio.playbackRate = Math.max(0.5, Math.min(2.0, this.basePlaybackRate + this.bendAmount));
        // Auto-release after brief hold
        setTimeout(() => this.releaseNudge(), 150);
    }

    setVolume(vol: number) {
        const v = Math.max(0, Math.min(2, vol));
        const now = this.ctx.currentTime;
        this.gainNode.gain.cancelScheduledValues(now);
        this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
        this.gainNode.gain.linearRampToValueAtTime(v, now + 0.015);
    }

    setEQ(band: "low" | "mid" | "hi", gain: number) {
        const node = band === "low" ? this.eqLowNode : band === "mid" ? this.eqMidNode : this.eqHiNode;
        const v = Math.max(-26, Math.min(6, gain));
        const now = this.ctx.currentTime;
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(v, now + 0.015);
    }

    setEQKill(band: "low" | "mid" | "hi", kill: boolean) {
        const node = band === "low" ? this.eqLowNode : band === "mid" ? this.eqMidNode : this.eqHiNode;
        const v = kill ? -26 : 0;
        const now = this.ctx.currentTime;
        node.gain.cancelScheduledValues(now);
        node.gain.setValueAtTime(node.gain.value, now);
        node.gain.linearRampToValueAtTime(v, now + 0.01);
    }

    setTempo(ratio: number) {
        // ratio = targetBPM / originalBPM
        this.basePlaybackRate = Math.max(0.5, Math.min(2.0, ratio));
        this.audio.playbackRate = Math.max(0.5, Math.min(2.0, this.basePlaybackRate + this.bendAmount));
    }

    setKeyShift(semitones: number) {
        this.keyShiftCents = semitones * 100;
        // MediaElement doesn't support detune directly.
        // With keyLock OFF, pitch changes with tempo (natural).
        // With keyLock ON, we'd need AudioBufferSourceNode for true pitch isolation.
        // As a practical approach: when keyLock is on and user shifts key,
        // we adjust playbackRate slightly to simulate the shift, then re-compensate.
        // This is an approximation — true key lock requires offline processing.
    }

    setKeyLock(enabled: boolean) {
        this.keyLock = enabled;
        // Browser-native pitch preservation: when enabled, pitch stays constant
        // regardless of playbackRate changes (tempo changes don't affect key).
        this.audio.preservesPitch = enabled;
    }

    setBeatFx(fxType: BeatFxType, amount: number, bpm: number, beatDiv: number) {
        const beatDuration = 60 / Math.max(1, bpm);
        const delayTime = Math.min(4, beatDuration * beatDiv);

        if (amount < 0.01) {
            // FX off — ramp to silence to avoid clicks, then disconnect feedback loop to save CPU
            this.rampParam(this.beatFxWet.gain, 0);
            this.rampParam(this.beatFxDry.gain, 1);
            this.rampParam(this.beatFxFeedback.gain, 0);
            if (this.beatFxActive) {
                this.beatFxActive = false;
                // Disconnect feedback loop after ramp completes (~15ms)
                setTimeout(() => {
                    if (!this.beatFxActive) {
                        try { this.beatFxFeedback.disconnect(); } catch { /* already disconnected */ }
                    }
                }, 20);
            }
            return;
        }

        // Reconnect feedback loop if it was disconnected
        if (!this.beatFxActive) {
            this.beatFxActive = true;
            try { this.beatFxFeedback.connect(this.beatFxDelay); } catch { /* already connected */ }
        }

        switch (fxType) {
            case "delay":
                this.rampParam(this.beatFxDelay.delayTime, delayTime);
                this.rampParam(this.beatFxWet.gain, amount * 0.7);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.3);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 8000);
                this.rampParam(this.beatFxFilter.Q, 0.5);
                break;

            case "echo":
                this.rampParam(this.beatFxDelay.delayTime, delayTime);
                this.rampParam(this.beatFxWet.gain, amount * 0.6);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.6);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 4000 + (1 - amount) * 8000);
                this.rampParam(this.beatFxFilter.Q, 0.7);
                break;

            case "reverb":
                // Simulate reverb with short multi-tap delay + high feedback
                this.rampParam(this.beatFxDelay.delayTime, Math.min(0.08, delayTime * 0.15));
                this.rampParam(this.beatFxWet.gain, amount * 0.8);
                this.rampParam(this.beatFxDry.gain, 1 - amount * 0.2);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.75);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 3000 + (1 - amount) * 6000);
                this.rampParam(this.beatFxFilter.Q, 0.3);
                break;

            case "flanger":
                // Short modulated delay
                this.rampParam(this.beatFxDelay.delayTime, 0.002 + amount * 0.008);
                this.rampParam(this.beatFxWet.gain, amount * 0.9);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.7);
                this.beatFxFilter.type = "allpass";
                this.rampParam(this.beatFxFilter.frequency, 1000);
                break;

            case "phaser":
                this.rampParam(this.beatFxDelay.delayTime, 0.001 + amount * 0.004);
                this.rampParam(this.beatFxWet.gain, amount * 0.8);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.5);
                this.beatFxFilter.type = "notch";
                this.rampParam(this.beatFxFilter.frequency, 1000);
                this.rampParam(this.beatFxFilter.Q, 2);
                break;

            case "trans":
                // Transform/gate — no delay, just sharp volume chopping simulated via filter
                this.rampParam(this.beatFxDelay.delayTime, 0.001);
                this.rampParam(this.beatFxWet.gain, 0);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, 0);
                this.beatFxFilter.type = "highpass";
                this.rampParam(this.beatFxFilter.frequency, amount > 0.5 ? 15000 : 20);
                break;

            case "roll":
                // Beat repeat — tight loop with delay
                this.rampParam(this.beatFxDelay.delayTime, delayTime);
                this.rampParam(this.beatFxWet.gain, amount);
                this.rampParam(this.beatFxDry.gain, 1 - amount * 0.5);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.85);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 12000);
                this.rampParam(this.beatFxFilter.Q, 0.5);
                break;

            case "filter":
                // Filter sweep synced to beat
                this.rampParam(this.beatFxDelay.delayTime, 0.001);
                this.rampParam(this.beatFxWet.gain, 0);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, 0);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 200 + (1 - amount) * 18000);
                this.rampParam(this.beatFxFilter.Q, 1 + amount * 8);
                break;

            case "spiral":
                // Pitch-shifting echo feel
                this.rampParam(this.beatFxDelay.delayTime, delayTime * 0.5);
                this.rampParam(this.beatFxWet.gain, amount * 0.7);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.65);
                this.beatFxFilter.type = "highpass";
                this.rampParam(this.beatFxFilter.frequency, 200 + amount * 4000);
                this.rampParam(this.beatFxFilter.Q, 2 + amount * 8);
                break;

            case "noise":
                // White noise blend via HP resonance
                this.rampParam(this.beatFxDelay.delayTime, 0.001);
                this.rampParam(this.beatFxWet.gain, amount * 0.4);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.9);
                this.beatFxFilter.type = "highpass";
                this.rampParam(this.beatFxFilter.frequency, 8000 + amount * 10000);
                this.rampParam(this.beatFxFilter.Q, 15 + amount * 10);
                break;

            case "crush":
                // Bit crush simulation via high-Q bandpass + feedback
                this.rampParam(this.beatFxDelay.delayTime, 0.001);
                this.rampParam(this.beatFxWet.gain, amount * 0.6);
                this.rampParam(this.beatFxDry.gain, 1 - amount * 0.3);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.4);
                this.beatFxFilter.type = "bandpass";
                this.rampParam(this.beatFxFilter.frequency, 2000 + amount * 4000);
                this.rampParam(this.beatFxFilter.Q, 10 + amount * 20);
                break;

            case "ping-pong":
                // Stereo ping-pong delay
                this.rampParam(this.beatFxDelay.delayTime, delayTime);
                this.rampParam(this.beatFxWet.gain, amount * 0.6);
                this.rampParam(this.beatFxDry.gain, 1);
                this.rampParam(this.beatFxFeedback.gain, amount * 0.5);
                this.beatFxFilter.type = "lowpass";
                this.rampParam(this.beatFxFilter.frequency, 6000);
                this.rampParam(this.beatFxFilter.Q, 0.5);
                break;

            default:
                this.setBeatFx("delay", amount, bpm, beatDiv);
                break;
        }
    }

    setHeadphoneCue(enabled: boolean) {
        this.rampParam(this.cueSendGain.gain, enabled ? 1 : 0, 0.008);
    }

    setAutoGain(gain: number) {
        this.rampParam(this.autoGainNode.gain, Math.max(0, Math.min(4, gain)), 0.015);
    }

    setEQMode(mode: EQMode) {
        this.eqMode = mode;
        if (mode === "isolator") {
            // Isolator: full-cut shelves become bandpass-like
            this.eqLowNode.type = "lowshelf";
            this.rampParam(this.eqLowNode.frequency, 250);
            this.eqMidNode.type = "peaking";
            this.rampParam(this.eqMidNode.frequency, 1000);
            this.rampParam(this.eqMidNode.Q, 1.4);
            this.eqHiNode.type = "highshelf";
            this.rampParam(this.eqHiNode.frequency, 2500);
        } else {
            this.eqLowNode.type = "lowshelf";
            this.rampParam(this.eqLowNode.frequency, 320);
            this.eqMidNode.type = "peaking";
            this.rampParam(this.eqMidNode.frequency, 1000);
            this.rampParam(this.eqMidNode.Q, 0.7);
            this.eqHiNode.type = "highshelf";
            this.rampParam(this.eqHiNode.frequency, 3200);
        }
    }

    // Slip mode: start tracking position while doing loops/scratches
    startSlip() {
        this.slipActive = true;
        this.slipPosition = this.audio.currentTime;
        this.slipStartTime = performance.now();
        this.slipPlaybackRate = this.basePlaybackRate;
    }

    stopSlip(): number {
        if (!this.slipActive) return this.audio.currentTime;
        this.slipActive = false;
        const elapsed = (performance.now() - this.slipStartTime) / 1000;
        const resumePos = this.slipPosition + elapsed * this.slipPlaybackRate;
        return Math.min(resumePos, this.audio.duration || Infinity);
    }

    getSlipPosition(): number {
        if (!this.slipActive) return this.audio.currentTime;
        const elapsed = (performance.now() - this.slipStartTime) / 1000;
        return this.slipPosition + elapsed * this.slipPlaybackRate;
    }

    /** Quantize a time value to the nearest beat boundary */
    quantizeTime(time: number, bpm: number): number {
        if (bpm <= 0) return time;
        const beatDuration = 60 / bpm;
        return Math.round(time / beatDuration) * beatDuration;
    }

    setFilter(value: number, filterType: FilterType = "lpf-hpf") {
        // value: -1 (full effect) to 0 (off) to +1 (full effect)
        const absVal = Math.abs(value);
        const isOff = absVal < 0.05;

        if (isOff) {
            this.filterNode.type = "allpass";
            this.rampParam(this.filterNode.frequency, 1000);
            this.rampParam(this.filterNode.Q, 1);
            return;
        }

        switch (filterType) {
            case "lpf-hpf":
                if (value < 0) {
                    this.filterNode.type = "lowpass";
                    const t = 1 + value; // 0..1
                    this.rampParam(this.filterNode.frequency, 200 * Math.pow(100, t));
                    this.rampParam(this.filterNode.Q, 1 + absVal * 5);
                } else {
                    this.filterNode.type = "highpass";
                    this.rampParam(this.filterNode.frequency, 20 * Math.pow(1000, value));
                    this.rampParam(this.filterNode.Q, 1 + value * 5);
                }
                break;

            case "lpf":
                this.filterNode.type = "lowpass";
                this.rampParam(this.filterNode.frequency, 200 * Math.pow(100, 1 - absVal));
                this.rampParam(this.filterNode.Q, 1 + absVal * 6);
                break;

            case "hpf":
                this.filterNode.type = "highpass";
                this.rampParam(this.filterNode.frequency, 20 * Math.pow(1000, absVal));
                this.rampParam(this.filterNode.Q, 1 + absVal * 6);
                break;

            case "bpf":
                this.filterNode.type = "bandpass";
                this.rampParam(this.filterNode.frequency, 200 * Math.pow(50, (value + 1) / 2));
                this.rampParam(this.filterNode.Q, 2 + absVal * 10);
                break;

            case "notch":
                this.filterNode.type = "notch";
                this.rampParam(this.filterNode.frequency, 200 * Math.pow(50, (value + 1) / 2));
                this.rampParam(this.filterNode.Q, 1 + absVal * 8);
                break;

            case "sweep":
                {
                    const freq = 20 * Math.pow(1000, (value + 1) / 2);
                    if (value < 0) {
                        this.filterNode.type = "lowpass";
                        this.rampParam(this.filterNode.frequency, freq);
                    } else {
                        this.filterNode.type = "highpass";
                        this.rampParam(this.filterNode.frequency, freq);
                    }
                    this.rampParam(this.filterNode.Q, 1 + absVal * 4);
                }
                break;

            case "resonance":
                if (value < 0) {
                    this.filterNode.type = "lowpass";
                    this.rampParam(this.filterNode.frequency, 200 * Math.pow(100, 1 - absVal));
                    this.rampParam(this.filterNode.Q, 5 + absVal * 20);
                } else {
                    this.filterNode.type = "highpass";
                    this.rampParam(this.filterNode.frequency, 20 * Math.pow(1000, value));
                    this.rampParam(this.filterNode.Q, 5 + absVal * 20);
                }
                break;

            default:
                this.setFilter(value, "lpf-hpf");
                break;
        }
    }

    setColorFx(value: number, fxType: ColorFxType = "echo") {
        // value: -1 (full effect) to 0 (off) to +1 (full effect)
        const absVal = Math.abs(value);
        const isOff = absVal < 0.05;

        if (isOff) {
            this.colorFxNode.type = "allpass";
            this.rampParam(this.colorFxNode.frequency, 1000);
            this.rampParam(this.colorFxNode.Q, 1);
            return;
        }

        switch (fxType) {
            case "echo":
            case "dub-echo":
                // Simulate echo with heavy LP + high Q for resonant feedback feel
                this.colorFxNode.type = "lowpass";
                this.rampParam(this.colorFxNode.frequency, 800 * Math.pow(10, 1 - absVal));
                this.rampParam(this.colorFxNode.Q, 3 + absVal * 15);
                break;

            case "reverb":
            case "wash":
                this.colorFxNode.type = "lowpass";
                this.rampParam(this.colorFxNode.frequency, 500 + (1 - absVal) * 15000);
                this.rampParam(this.colorFxNode.Q, 0.5 + absVal * 3);
                break;

            case "flanger":
                this.colorFxNode.type = "bandpass";
                this.rampParam(this.colorFxNode.frequency, 500 + Math.sin(value * Math.PI * 2) * 400);
                this.rampParam(this.colorFxNode.Q, 8 + absVal * 15);
                break;

            case "phaser":
                this.colorFxNode.type = "notch";
                this.rampParam(this.colorFxNode.frequency, 1000 * Math.pow(4, value));
                this.rampParam(this.colorFxNode.Q, 2 + absVal * 6);
                break;

            case "crusher":
                this.colorFxNode.type = "bandpass";
                this.rampParam(this.colorFxNode.frequency, 2000 + absVal * 3000);
                this.rampParam(this.colorFxNode.Q, 10 + absVal * 25);
                break;

            case "spiral":
                this.colorFxNode.type = "highpass";
                this.rampParam(this.colorFxNode.frequency, 50 * Math.pow(200, absVal));
                this.rampParam(this.colorFxNode.Q, 2 + absVal * 18);
                break;

            case "gate":
                this.colorFxNode.type = "highpass";
                this.rampParam(this.colorFxNode.frequency, absVal > 0.5 ? 5000 + (absVal - 0.5) * 15000 : 20);
                this.rampParam(this.colorFxNode.Q, 1);
                break;

            case "formant":
                this.colorFxNode.type = "bandpass";
                {
                    const formants = [270, 530, 730, 1090, 2440];
                    const fIdx = Math.floor(((value + 1) / 2) * (formants.length - 1));
                    this.rampParam(this.colorFxNode.frequency, formants[Math.min(fIdx, formants.length - 1)]);
                }
                this.rampParam(this.colorFxNode.Q, 5 + absVal * 10);
                break;

            case "pitch":
                this.colorFxNode.type = "highpass";
                this.rampParam(this.colorFxNode.frequency, 200 * Math.pow(20, absVal));
                this.rampParam(this.colorFxNode.Q, 8 + absVal * 15);
                break;

            case "telephone":
                this.colorFxNode.type = "bandpass";
                this.rampParam(this.colorFxNode.frequency, 1200);
                this.rampParam(this.colorFxNode.Q, 3 + absVal * 12);
                break;

            case "rumble":
                this.colorFxNode.type = "lowpass";
                this.rampParam(this.colorFxNode.frequency, 80 + (1 - absVal) * 400);
                this.rampParam(this.colorFxNode.Q, 4 + absVal * 12);
                break;

            case "tinny":
                this.colorFxNode.type = "highpass";
                this.rampParam(this.colorFxNode.frequency, 2000 + absVal * 8000);
                this.rampParam(this.colorFxNode.Q, 3 + absVal * 10);
                break;

            case "vinyl":
                this.colorFxNode.type = "bandpass";
                this.rampParam(this.colorFxNode.frequency, 800 + absVal * 2000);
                this.rampParam(this.colorFxNode.Q, 2 + absVal * 8);
                break;

            case "radio":
                this.colorFxNode.type = "bandpass";
                this.rampParam(this.colorFxNode.frequency, 1500);
                this.rampParam(this.colorFxNode.Q, 5 + absVal * 20);
                break;

            case "noise":
                if (value < 0) {
                    this.colorFxNode.type = "lowpass";
                    this.rampParam(this.colorFxNode.frequency, 100 + (1 - absVal) * 19000);
                } else {
                    this.colorFxNode.type = "highpass";
                    this.rampParam(this.colorFxNode.frequency, 100 + absVal * 19000);
                }
                this.rampParam(this.colorFxNode.Q, 0.5);
                break;

            default:
                this.setColorFx(value, "echo");
                break;
        }
    }

    enableLoop(start: number, end: number) {
        this.audio.dataset.loopEnabled = "true";
        this.audio.dataset.loopStart = String(start);
        this.audio.dataset.loopEnd = String(end);
    }

    disableLoop() {
        this.audio.dataset.loopEnabled = "false";
    }

    moveLoop(offsetSeconds: number) {
        const start = parseFloat(this.audio.dataset.loopStart || "0") + offsetSeconds;
        const end = parseFloat(this.audio.dataset.loopEnd || "0") + offsetSeconds;
        if (start >= 0 && end <= (this.audio.duration || Infinity)) {
            this.audio.dataset.loopStart = String(start);
            this.audio.dataset.loopEnd = String(end);
            if (this.audio.currentTime < start || this.audio.currentTime > end) {
                this.audio.currentTime = start;
            }
        }
    }

    getWaveformData(): Uint8Array {
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(data);
        return data;
    }

    destroy() {
        if (this.loopRAF) cancelAnimationFrame(this.loopRAF);
        if (this.bendDecayRAF) cancelAnimationFrame(this.bendDecayRAF);
        this.audio.pause();
        this.audio.src = "";
        try {
            this.source?.disconnect();
            this.autoGainNode.disconnect();
            this.eqLowNode.disconnect();
            this.eqMidNode.disconnect();
            this.eqHiNode.disconnect();
            this.filterNode.disconnect();
            this.colorFxNode.disconnect();
            this.beatFxDry.disconnect();
            this.beatFxWet.disconnect();
            this.beatFxDelay.disconnect();
            this.beatFxFeedback.disconnect();
            this.beatFxFilter.disconnect();
            this.cueSendGain.disconnect();
            this.gainNode.disconnect();
            this.analyser.disconnect();
        } catch { /* already disconnected */ }
    }
}

export class MixerEngine {
    ctx: AudioContext;
    private deckAGain: GainNode;
    private deckBGain: GainNode;
    private deckCGain: GainNode;
    private deckDGain: GainNode;
    private masterGain: GainNode;
    private cueGain: GainNode; // headphone cue bus
    private cueMixGain: GainNode; // master → cue mix
    masterAnalyser: AnalyserNode;
    cueAnalyser: AnalyserNode;
    deckA: DeckEngine;
    deckB: DeckEngine;
    deckC: DeckEngine;
    deckD: DeckEngine;
    private crossfader = 0.5; // 0 = full A, 1 = full B
    private crossfaderCurve: CrossfaderCurve = "smooth";
    private crossfaderAssignA: CrossfaderAssign = "thru"; // Deck A assignment
    private crossfaderAssignB: CrossfaderAssign = "thru"; // Deck B assignment
    private crossfaderAssignC: CrossfaderAssign = "thru"; // Deck C assignment
    private crossfaderAssignD: CrossfaderAssign = "thru"; // Deck D assignment
    // Recording
    private mediaRecorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    private recordingStartTime = 0;
    isRecording = false;
    // Session history
    sessionHistory: { trackTitle: string; artist: string; deck: string; loadedAt: number; playedAt?: number }[] = [];
    // Mix action history (for undo)
    mixHistory: MixAction[] = [];
    private mixActionId = 0;
    // Sampler
    sampler: SamplerEngine;
    // Automix
    automixConfig: AutomixConfig = { enabled: false, mode: "fade", fadeDuration: 8, minPlayTime: 60 };
    private automixTimer: ReturnType<typeof setTimeout> | null = null;
    // MIDI Clock
    private midiClockInterval: ReturnType<typeof setInterval> | null = null;
    midiClockBpm = 120;

    constructor() {
        this.ctx = new AudioContext({ latencyHint: "playback" });

        // Expose AudioContext globally for performance monitoring
        if (typeof window !== "undefined") {
            (window as unknown as { __mmo_audio_ctx: AudioContext }).__mmo_audio_ctx = this.ctx;
        }

        this.deckAGain = this.ctx.createGain();
        this.deckBGain = this.ctx.createGain();
        this.deckCGain = this.ctx.createGain();
        this.deckDGain = this.ctx.createGain();
        this.masterGain = this.ctx.createGain();
        this.masterAnalyser = this.ctx.createAnalyser();
        this.masterAnalyser.fftSize = 256;

        // Headphone cue bus
        this.cueGain = this.ctx.createGain();
        this.cueGain.gain.value = 0.8;
        this.cueAnalyser = this.ctx.createAnalyser();
        this.cueAnalyser.fftSize = 256;
        // Cue mix: blend master into headphone
        this.cueMixGain = this.ctx.createGain();
        this.cueMixGain.gain.value = 0; // 0 = cue only, 1 = master only

        // Routing: deck gains → master gain → analyser → destination
        this.deckAGain.connect(this.masterGain);
        this.deckBGain.connect(this.masterGain);
        this.deckCGain.connect(this.masterGain);
        this.deckDGain.connect(this.masterGain);
        this.masterGain.connect(this.masterAnalyser);
        this.masterAnalyser.connect(this.ctx.destination);

        // Headphone cue routing
        this.masterGain.connect(this.cueMixGain);
        this.cueMixGain.connect(this.cueGain);
        this.cueGain.connect(this.cueAnalyser);

        this.deckA = new DeckEngine(this.ctx, this.deckAGain, this.cueGain);
        this.deckB = new DeckEngine(this.ctx, this.deckBGain, this.cueGain);
        this.deckC = new DeckEngine(this.ctx, this.deckCGain, this.cueGain);
        this.deckD = new DeckEngine(this.ctx, this.deckDGain, this.cueGain);

        // Sampler engine
        this.sampler = new SamplerEngine(this.ctx, this.masterGain);

        this.setCrossfader(0.5);
    }

    setCrossfaderCurve(curve: CrossfaderCurve) {
        this.crossfaderCurve = curve;
        this.setCrossfader(this.crossfader); // reapply
    }

    /** Get a DeckEngine by side letter */
    getDeck(side: DeckSide): DeckEngine {
        switch (side) {
            case "A": return this.deckA;
            case "B": return this.deckB;
            case "C": return this.deckC;
            case "D": return this.deckD;
        }
    }

    /** Get the gain node for a deck */
    private getDeckGain(side: DeckSide): GainNode {
        switch (side) {
            case "A": return this.deckAGain;
            case "B": return this.deckBGain;
            case "C": return this.deckCGain;
            case "D": return this.deckDGain;
        }
    }

    setCrossfaderAssign(deck: DeckSide, assign: CrossfaderAssign) {
        switch (deck) {
            case "A": this.crossfaderAssignA = assign; break;
            case "B": this.crossfaderAssignB = assign; break;
            case "C": this.crossfaderAssignC = assign; break;
            case "D": this.crossfaderAssignD = assign; break;
        }
        this.setCrossfader(this.crossfader); // reapply
    }

    setCrossfader(value: number) {
        this.crossfader = Math.max(0, Math.min(1, value));

        // Calculate base crossfader gains
        let gainA = 0.5, gainB = 0.5;
        switch (this.crossfaderCurve) {
            case "linear":
                gainA = 1 - this.crossfader;
                gainB = this.crossfader;
                break;
            case "sharp": {
                const deadZone = 0.02;
                if (this.crossfader <= deadZone) { gainA = 1; gainB = 0; }
                else if (this.crossfader >= 1 - deadZone) { gainA = 0; gainB = 1; }
                else { gainA = 1; gainB = 1; }
                break;
            }
            case "smooth":
            default: {
                const angleA = (1 - this.crossfader) * Math.PI * 0.5;
                const angleB = this.crossfader * Math.PI * 0.5;
                gainA = Math.cos(angleB);
                gainB = Math.cos(angleA);
                break;
            }
        }

        // Apply per-deck crossfader assignment with ramping to avoid clicks
        // "thru" = bypass crossfader (always full volume)
        // "A" = responds to A side of crossfader
        // "B" = responds to B side of crossfader
        const now = this.ctx.currentTime;
        const applyGain = (gainNode: GainNode, assign: CrossfaderAssign) => {
            const val = assign === "thru" ? 1 : assign === "A" ? gainA : gainB;
            gainNode.gain.cancelScheduledValues(now);
            gainNode.gain.setValueAtTime(gainNode.gain.value, now);
            gainNode.gain.linearRampToValueAtTime(val, now + 0.008);
        };
        applyGain(this.deckAGain, this.crossfaderAssignA);
        applyGain(this.deckBGain, this.crossfaderAssignB);
        applyGain(this.deckCGain, this.crossfaderAssignC);
        applyGain(this.deckDGain, this.crossfaderAssignD);
    }

    setMasterVolume(vol: number) {
        const v = Math.max(0, Math.min(1.5, vol));
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(v, now + 0.015);
    }

    /** Ensure AudioContext is running. Call on any user interaction that plays audio.
     *  Browsers suspend AudioContext until a user gesture occurs. */
    ensureRunning() {
        if (this.ctx.state === "suspended") {
            this.ctx.resume();
        }
    }

    /** Suspend AudioContext to save CPU when no audio is playing. */
    suspend() {
        if (this.ctx.state === "running") {
            this.ctx.suspend();
        }
    }

    /** Get AudioContext state for monitoring */
    getContextState(): AudioContextState {
        return this.ctx.state;
    }

    /** Get actual audio latency in seconds (baseLatency + outputLatency) */
    getAudioLatency(): number {
        return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    }

    /** Get audio sample rate */
    getSampleRate(): number {
        return this.ctx.sampleRate;
    }

    setHeadphoneVolume(vol: number) {
        const v = Math.max(0, Math.min(1.5, vol));
        const now = this.ctx.currentTime;
        this.cueGain.gain.cancelScheduledValues(now);
        this.cueGain.gain.setValueAtTime(this.cueGain.gain.value, now);
        this.cueGain.gain.linearRampToValueAtTime(v, now + 0.015);
    }

    setHeadphoneMix(mix: number) {
        // 0 = full cue, 1 = full master
        const v = Math.max(0, Math.min(1, mix));
        const now = this.ctx.currentTime;
        this.cueMixGain.gain.cancelScheduledValues(now);
        this.cueMixGain.gain.setValueAtTime(this.cueMixGain.gain.value, now);
        this.cueMixGain.gain.linearRampToValueAtTime(v, now + 0.015);
    }

    // Recording via MediaRecorder
    startRecording(): boolean {
        try {
            const dest = this.ctx.createMediaStreamDestination();
            this.masterAnalyser.connect(dest);
            this.recordedChunks = [];
            this.mediaRecorder = new MediaRecorder(dest.stream, {
                mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                    ? "audio/webm;codecs=opus"
                    : "audio/webm",
            });
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.recordedChunks.push(e.data);
            };
            this.mediaRecorder.start(1000); // 1s chunks
            this.isRecording = true;
            this.recordingStartTime = Date.now();
            return true;
        } catch {
            return false;
        }
    }

    stopRecording(): { blob: Blob; duration: number } | null {
        if (!this.mediaRecorder || !this.isRecording) return null;
        const duration = Date.now() - this.recordingStartTime;
        return new Promise<{ blob: Blob; duration: number }>((resolve) => {
            this.mediaRecorder!.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
                this.isRecording = false;
                this.recordedChunks = [];
                resolve({ blob, duration });
            };
            this.mediaRecorder!.stop();
        }) as unknown as { blob: Blob; duration: number };
    }

    async stopRecordingAsync(): Promise<{ blob: Blob; duration: number } | null> {
        if (!this.mediaRecorder || !this.isRecording) return null;
        const duration = Date.now() - this.recordingStartTime;
        return new Promise<{ blob: Blob; duration: number }>((resolve) => {
            this.mediaRecorder!.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: "audio/webm" });
                this.isRecording = false;
                this.recordedChunks = [];
                resolve({ blob, duration });
            };
            this.mediaRecorder!.stop();
        });
    }

    addToHistory(track: { title: string; artist: string }, deck: string) {
        this.sessionHistory.push({
            trackTitle: track.title,
            artist: track.artist,
            deck,
            loadedAt: Date.now(),
        });
    }

    markPlayed(deck: string) {
        const last = [...this.sessionHistory].reverse().find(h => h.deck === deck && !h.playedAt);
        if (last) last.playedAt = Date.now();
    }

    // ─── Mix History / Undo ──────────────────────────────────────────

    recordAction(type: string, deck: "A" | "B" | "C" | "D" | null, description: string, prevValue: unknown, newValue: unknown) {
        this.mixHistory.push({
            id: ++this.mixActionId,
            timestamp: Date.now(),
            type, deck, description, prevValue, newValue,
        });
        // Keep last 200 actions
        if (this.mixHistory.length > 200) this.mixHistory = this.mixHistory.slice(-200);
    }

    undoLastAction(): MixAction | null {
        return this.mixHistory.pop() || null;
    }

    // ─── Automix ─────────────────────────────────────────────────────

    setAutomixConfig(config: Partial<AutomixConfig>) {
        Object.assign(this.automixConfig, config);
    }

    startAutomix(onTransition: (fromDeck: "A" | "B", toDeck: "A" | "B") => void) {
        this.automixConfig.enabled = true;
        this.checkAutomix(onTransition);
    }

    stopAutomix() {
        this.automixConfig.enabled = false;
        if (this.automixTimer) {
            clearTimeout(this.automixTimer);
            this.automixTimer = null;
        }
    }

    private checkAutomix(onTransition: (fromDeck: "A" | "B", toDeck: "A" | "B") => void) {
        if (!this.automixConfig.enabled) return;

        // Check both decks for approaching end
        const checkDeck = (deck: DeckEngine, deckId: "A" | "B") => {
            if (!deck.audio.duration || deck.audio.paused) return;
            const remaining = deck.audio.duration - deck.audio.currentTime;
            const fadeTime = this.automixConfig.fadeDuration;

            if (remaining <= fadeTime && remaining > fadeTime - 0.5) {
                const otherDeck = deckId === "A" ? "B" : "A";
                onTransition(deckId, otherDeck as "A" | "B");
            }
        };

        checkDeck(this.deckA, "A");
        checkDeck(this.deckB, "B");

        this.automixTimer = setTimeout(() => this.checkAutomix(onTransition), 500);
    }

    performAutomixFade(fromDeck: "A" | "B", duration: number) {
        const steps = 60;
        const interval = (duration * 1000) / steps;
        let step = 0;

        const fade = setInterval(() => {
            step++;
            const progress = step / steps;
            const targetCrossfader = fromDeck === "A" ? progress : 1 - progress;
            this.setCrossfader(targetCrossfader);

            if (step >= steps) {
                clearInterval(fade);
            }
        }, interval);
    }

    // ─── MIDI Clock ──────────────────────────────────────────────────

    startMidiClock(bpm: number, sendFn: (data: number[]) => void) {
        this.stopMidiClock();
        this.midiClockBpm = bpm;
        // MIDI clock sends 24 pulses per quarter note
        const pulsesPerBeat = 24;
        const intervalMs = (60000 / bpm) / pulsesPerBeat;

        // Send MIDI Start
        sendFn([0xFA]);

        this.midiClockInterval = setInterval(() => {
            sendFn([0xF8]); // MIDI Clock pulse
        }, intervalMs);
    }

    stopMidiClock(sendFn?: (data: number[]) => void) {
        if (this.midiClockInterval) {
            clearInterval(this.midiClockInterval);
            this.midiClockInterval = null;
        }
        if (sendFn) sendFn([0xFC]); // MIDI Stop
    }

    updateMidiClockBpm(bpm: number, sendFn: (data: number[]) => void) {
        if (this.midiClockInterval) {
            this.startMidiClock(bpm, sendFn);
        }
    }

    getAudioInfo(): { sampleRate: number; baseLatency: number; outputLatency: number; channelCount: number; state: string } {
        return {
            sampleRate: this.ctx.sampleRate,
            baseLatency: this.ctx.baseLatency || 0,
            outputLatency: (this.ctx as unknown as { outputLatency?: number }).outputLatency || 0,
            channelCount: this.ctx.destination.channelCount,
            state: this.ctx.state,
        };
    }

    getMasterWaveform(): Uint8Array {
        const data = new Uint8Array(this.masterAnalyser.frequencyBinCount);
        this.masterAnalyser.getByteFrequencyData(data);
        return data;
    }

    destroy() {
        if (this.isRecording) {
            try { this.mediaRecorder?.stop(); } catch { /* ignore */ }
        }
        this.stopAutomix();
        this.stopMidiClock();
        this.sampler.destroy();
        this.deckA.destroy();
        this.deckB.destroy();
        this.deckC.destroy();
        this.deckD.destroy();
        try {
            this.deckAGain.disconnect();
            this.deckBGain.disconnect();
            this.deckCGain.disconnect();
            this.deckDGain.disconnect();
            this.masterGain.disconnect();
            this.masterAnalyser.disconnect();
            this.cueGain.disconnect();
            this.cueMixGain.disconnect();
            this.cueAnalyser.disconnect();
            this.ctx.close();
        } catch { /* already closed */ }
    }
}

// ─── Sampler Engine ──────────────────────────────────────────────────────

export class SamplerEngine {
    private ctx: AudioContext;
    private output: GainNode;
    private masterGain: GainNode;
    slots: SamplerSlot[];
    private activeSources: Map<number, AudioBufferSourceNode> = new Map();
    private slotGains: GainNode[]; // pre-allocated per-slot gain nodes

    constructor(ctx: AudioContext, masterOutput: GainNode) {
        this.ctx = ctx;
        this.output = masterOutput;
        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = 0.8;
        this.masterGain.connect(this.output);

        // Initialize 8 sampler slots
        this.slots = Array.from({ length: 8 }, (_, i) => ({
            id: i,
            name: `Slot ${i + 1}`,
            buffer: null,
            isPlaying: false,
            volume: 0.8,
            isLooping: false,
        }));

        // Pre-allocate gain nodes per slot (avoid per-trigger allocation)
        this.slotGains = Array.from({ length: 8 }, () => {
            const g = ctx.createGain();
            g.gain.value = 0.8;
            g.connect(this.masterGain);
            return g;
        });
    }

    /** Load an audio file into a sampler slot */
    async loadSample(slotIndex: number, url: string, name?: string): Promise<boolean> {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            this.slots[slotIndex] = {
                ...this.slots[slotIndex],
                buffer: audioBuffer,
                name: name || `Sample ${slotIndex + 1}`,
            };
            return true;
        } catch {
            return false;
        }
    }

    /** Load an AudioBuffer directly (e.g., from loop capture) */
    loadBuffer(slotIndex: number, buffer: AudioBuffer, name?: string) {
        this.slots[slotIndex] = {
            ...this.slots[slotIndex],
            buffer,
            name: name || `Captured ${slotIndex + 1}`,
        };
    }

    /** Trigger/play a sampler slot */
    trigger(slotIndex: number) {
        const slot = this.slots[slotIndex];
        if (!slot?.buffer) return;

        // Stop existing playback on this slot
        this.stop(slotIndex);

        const source = this.ctx.createBufferSource();
        source.buffer = slot.buffer;
        source.loop = slot.isLooping;

        // Use pre-allocated gain node — update volume via ramp to avoid clicks
        const slotGain = this.slotGains[slotIndex];
        const now = this.ctx.currentTime;
        slotGain.gain.cancelScheduledValues(now);
        slotGain.gain.setValueAtTime(slotGain.gain.value, now);
        slotGain.gain.linearRampToValueAtTime(slot.volume, now + 0.005);

        source.connect(slotGain);

        source.onended = () => {
            this.activeSources.delete(slotIndex);
            this.slots[slotIndex] = { ...this.slots[slotIndex], isPlaying: false };
        };

        source.start(0);
        this.activeSources.set(slotIndex, source);
        this.slots[slotIndex] = { ...this.slots[slotIndex], isPlaying: true };
    }

    /** Stop a sampler slot */
    stop(slotIndex: number) {
        const source = this.activeSources.get(slotIndex);
        if (source) {
            try { source.stop(); } catch { /* already stopped */ }
            this.activeSources.delete(slotIndex);
        }
        this.slots[slotIndex] = { ...this.slots[slotIndex], isPlaying: false };
    }

    /** Set slot volume */
    setVolume(slotIndex: number, volume: number) {
        const v = Math.max(0, Math.min(1, volume));
        this.slots[slotIndex] = { ...this.slots[slotIndex], volume: v };
        // Update pre-allocated gain node in real-time with ramp
        const slotGain = this.slotGains[slotIndex];
        const now = this.ctx.currentTime;
        slotGain.gain.cancelScheduledValues(now);
        slotGain.gain.setValueAtTime(slotGain.gain.value, now);
        slotGain.gain.linearRampToValueAtTime(v, now + 0.01);
    }

    /** Toggle looping on a slot */
    toggleLoop(slotIndex: number) {
        const slot = this.slots[slotIndex];
        this.slots[slotIndex] = { ...slot, isLooping: !slot.isLooping };
        const source = this.activeSources.get(slotIndex);
        if (source) source.loop = !slot.isLooping;
    }

    /** Clear a sampler slot */
    clear(slotIndex: number) {
        this.stop(slotIndex);
        this.slots[slotIndex] = {
            id: slotIndex,
            name: `Slot ${slotIndex + 1}`,
            buffer: null,
            isPlaying: false,
            volume: 0.8,
            isLooping: false,
        };
    }

    /** Capture audio from a deck's loop into a sampler slot */
    async captureFromDeck(deck: DeckEngine, slotIndex: number, startTime: number, endTime: number): Promise<boolean> {
        try {
            // Create an offline context to capture audio
            const duration = endTime - startTime;
            const sampleRate = this.ctx.sampleRate;
            const frameCount = Math.ceil(duration * sampleRate);
            const buffer = this.ctx.createBuffer(2, frameCount, sampleRate);

            // We can't easily capture from MediaElement in offline context,
            // so we fetch the audio file and decode a segment
            const audioSrc = deck.audio.src;
            if (!audioSrc) return false;

            const response = await fetch(audioSrc);
            const arrayBuffer = await response.arrayBuffer();
            const fullBuffer = await this.ctx.decodeAudioData(arrayBuffer);

            // Extract the loop segment
            const startFrame = Math.floor(startTime * sampleRate);
            const segmentFrames = Math.min(frameCount, fullBuffer.length - startFrame);

            for (let ch = 0; ch < Math.min(2, fullBuffer.numberOfChannels); ch++) {
                const source = fullBuffer.getChannelData(ch);
                const target = buffer.getChannelData(ch);
                for (let i = 0; i < segmentFrames; i++) {
                    target[i] = source[startFrame + i] || 0;
                }
            }

            this.loadBuffer(slotIndex, buffer, `Loop capture`);
            return true;
        } catch {
            return false;
        }
    }

    setMasterVolume(vol: number) {
        const v = Math.max(0, Math.min(1.5, vol));
        const now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
        this.masterGain.gain.linearRampToValueAtTime(v, now + 0.01);
    }

    destroy() {
        this.activeSources.forEach((source) => {
            try { source.stop(); } catch { /* ignore */ }
        });
        this.activeSources.clear();
        try {
            this.masterGain.disconnect();
        } catch { /* ignore */ }
    }
}

// ─── Transition Suggestion Engine ────────────────────────────────────────

/** Camelot wheel compatibility map */
const CAMELOT_COMPATIBLE: Record<string, string[]> = {};
// Build compatibility map
for (let num = 1; num <= 12; num++) {
    for (const letter of ["A", "B"]) {
        const key = `${num}${letter}`;
        const prev = `${((num - 2 + 12) % 12) + 1}${letter}`;
        const next = `${(num % 12) + 1}${letter}`;
        const parallel = `${num}${letter === "A" ? "B" : "A"}`;
        CAMELOT_COMPATIBLE[key] = [key, prev, next, parallel]; // same, -1, +1, parallel
    }
}

export function getKeyCompatibility(
    currentKey: string,
    targetKey: string
): "perfect" | "compatible" | "energy-boost" | "clash" {
    if (!currentKey || !targetKey) return "compatible";
    if (currentKey === targetKey) return "perfect";

    const compatible = CAMELOT_COMPATIBLE[currentKey];
    if (compatible?.includes(targetKey)) return "compatible";

    // Energy boost: +2 semitones (2 positions up on wheel)
    const currentNum = parseInt(currentKey);
    const targetNum = parseInt(targetKey);
    if (!isNaN(currentNum) && !isNaN(targetNum)) {
        const diff = ((targetNum - currentNum + 12) % 12);
        if (diff === 2 || diff === 7) return "energy-boost";
    }

    return "clash";
}

export function calculateTransitionScore(
    currentBpm: number, currentKey: string, currentEnergy: number,
    targetBpm: number, targetKey: string, targetEnergy: number
): { score: number; reason: string } {
    let score = 50;
    const reasons: string[] = [];

    // Key compatibility (0-40 points)
    const keyCompat = getKeyCompatibility(currentKey, targetKey);
    switch (keyCompat) {
        case "perfect": score += 40; reasons.push("Perfect key match"); break;
        case "compatible": score += 30; reasons.push("Compatible key"); break;
        case "energy-boost": score += 20; reasons.push("Energy boost key"); break;
        case "clash": score -= 20; reasons.push("Key clash"); break;
    }

    // BPM compatibility (0-30 points)
    const bpmDiff = Math.abs(currentBpm - targetBpm);
    if (bpmDiff <= 2) { score += 30; reasons.push("Same BPM"); }
    else if (bpmDiff <= 5) { score += 20; reasons.push("Close BPM"); }
    else if (bpmDiff <= 10) { score += 10; reasons.push("Moderate BPM diff"); }
    else { score -= 10; reasons.push("Large BPM difference"); }

    // Energy flow (0-20 points)
    const energyDiff = targetEnergy - currentEnergy;
    if (Math.abs(energyDiff) <= 1) { score += 20; reasons.push("Smooth energy"); }
    else if (energyDiff > 0 && energyDiff <= 3) { score += 15; reasons.push("Building energy"); }
    else if (energyDiff < 0 && energyDiff >= -2) { score += 10; reasons.push("Slight cool down"); }
    else { score += 0; reasons.push("Energy jump"); }

    return { score: Math.max(0, Math.min(100, score)), reason: reasons.join(", ") };
}
