// ─── DAW Audio Engine ─────────────────────────────────────────────────────
// Web Audio API based DAW engine with multi-track mixing, effects, instruments,
// MIDI, automation, and real-time audio processing.

import { dlog } from "./dev-debugger";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type TrackType = "audio" | "midi" | "return" | "master";
export type ClipType = "audio" | "midi";
export type ToolMode = "select" | "draw" | "erase" | "slice" | "mute" | "automation" | "pan";
export type SnapValue = "1/1" | "1/2" | "1/4" | "1/8" | "1/16" | "1/32" | "none";
export type AutomationMode = "read" | "write" | "touch" | "latch";
export type TimeSignature = { numerator: number; denominator: number };
export type LoopRegion = { start: number; end: number; enabled: boolean };

export interface MidiNote {
    id: string;
    pitch: number;      // 0-127 MIDI note number
    velocity: number;   // 0-127
    start: number;      // beats
    duration: number;   // beats
    channel: number;    // 0-15
}

export interface AudioClipData {
    buffer: AudioBuffer | null;
    sourceUrl: string;
    name: string;
    startOffset: number;  // offset within the source file (seconds)
    duration: number;     // clip duration (seconds)
    sampleRate: number;   // sample rate of the buffer
    channels: number;     // number of audio channels
    gain: number;         // clip-level gain
    fadeIn: number;       // seconds
    fadeOut: number;      // seconds
    reversed: boolean;
    pitchShift: number;   // semitones
    timeStretch: number;  // ratio (1 = original speed)
    waveformPeaks?: Float32Array; // pre-computed peaks for display
}

export interface MidiClipData {
    notes: MidiNote[];
    instrumentId: string;
}

export interface Clip {
    id: string;
    type: ClipType;
    name: string;
    trackId: string;
    position: number;      // beats from start
    length: number;        // beats
    color: string;
    muted: boolean;
    audio?: AudioClipData;
    midi?: MidiClipData;
    automationData?: AutomationPoint[];
}

export interface AutomationPoint {
    time: number;   // beats
    value: number;  // 0-1 normalized
    curve: "linear" | "exponential" | "step";
}

export interface AutomationLane {
    id: string;
    trackId: string;
    parameter: string;      // e.g. "volume", "pan", "fx.reverb.mix"
    points: AutomationPoint[];
    visible: boolean;
    color: string;
    mode: AutomationMode;
}

export interface SendConfig {
    returnTrackId: string;
    amount: number;  // 0-1
    preFader: boolean;
}

export interface InsertEffect {
    id: string;
    type: EffectType;
    enabled: boolean;
    params: Record<string, number>;
    /** For `sidechain`: id of the track whose signal keys the compressor. */
    sidechainSourceTrackId?: string;
}

export type EffectType =
    | "eq3" | "parametricEq" | "compressor" | "limiter" | "gate"
    | "reverb" | "delay" | "chorus" | "flanger" | "phaser"
    | "distortion" | "bitcrusher" | "filter" | "sidechain"
    | "stereoWidth" | "deEsser" | "saturator" | "tremolo"
    | "pingPongDelay" | "convolutionReverb"
    | "noiseSuppression" | "autotune" | "pitchShift" | "vocoderLite";

export interface DAWTrack {
    id: string;
    name: string;
    type: TrackType;
    color: string;
    volume: number;       // 0-1
    pan: number;          // -1 to 1
    muted: boolean;
    soloed: boolean;
    armed: boolean;       // record armed
    frozen: boolean;
    height: number;       // pixels
    inserts: InsertEffect[];
    sends: SendConfig[];
    clips: Clip[];
    automationLanes: AutomationLane[];
    inputSource: string;  // "none" | "mic" | "line" | midi device name
    outputTarget: string; // "master" | return track id
    instrumentId?: string; // for MIDI tracks
    // Audio analysis
    peakL: number;
    peakR: number;
}

export interface DAWProject {
    id: string;
    name: string;
    tempo: number;
    timeSignature: TimeSignature;
    tracks: DAWTrack[];
    masterTrack: DAWTrack;
    loopRegion: LoopRegion;
    createdAt: number;
    modifiedAt: number;
    duration: number;     // total length in beats
}

export interface SynthOscillator {
    type: OscillatorType;
    detune: number;
    octave: number;
    gain: number;
    enabled: boolean;
}

export interface SynthConfig {
    oscillators: SynthOscillator[];
    filterType: BiquadFilterType;
    filterCutoff: number;    // Hz
    filterResonance: number; // Q
    filterEnvAmount: number; // 0-1
    ampAttack: number;       // seconds
    ampDecay: number;
    ampSustain: number;      // 0-1
    ampRelease: number;
    filterAttack: number;
    filterDecay: number;
    filterSustain: number;
    filterRelease: number;
    lfoRate: number;         // Hz
    lfoDepth: number;        // 0-1
    lfoTarget: "pitch" | "filter" | "amp";
    lfoShape: OscillatorType;
    reverbMix: number;
    delayMix: number;
    delayTime: number;
    masterGain: number;
}

// Step Sequencer
export interface StepSequencerPattern {
    id: string;
    name: string;
    steps: number;           // 16, 32, 64
    tracks: StepTrack[];
    swing: number;           // 0-1
}

export interface StepTrack {
    id: string;
    name: string;
    sampleUrl: string;
    steps: StepData[];
    volume: number;
    pan: number;
    muted: boolean;
    soloed: boolean;
    pitch: number;
}

export interface StepData {
    active: boolean;
    velocity: number;  // 0-127
    accent: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default Configs
// ═══════════════════════════════════════════════════════════════════════════

const TRACK_COLORS = [
    "#8b5cf6", "#3b82f6", "#06b6d4", "#10b981", "#22c55e",
    "#eab308", "#f97316", "#ef4444", "#ec4899", "#a855f7",
    "#6366f1", "#14b8a6", "#84cc16", "#f59e0b", "#f43f5e",
];

export const DEFAULT_SYNTH_CONFIG: SynthConfig = {
    oscillators: [
        { type: "sawtooth", detune: 0, octave: 0, gain: 0.5, enabled: true },
        { type: "square", detune: 7, octave: 0, gain: 0.3, enabled: false },
        { type: "sine", detune: 0, octave: -1, gain: 0.2, enabled: false },
    ],
    filterType: "lowpass",
    filterCutoff: 8000,
    filterResonance: 1,
    filterEnvAmount: 0.3,
    ampAttack: 0.01,
    ampDecay: 0.2,
    ampSustain: 0.7,
    ampRelease: 0.3,
    filterAttack: 0.01,
    filterDecay: 0.3,
    filterSustain: 0.4,
    filterRelease: 0.5,
    lfoRate: 2,
    lfoDepth: 0,
    lfoTarget: "filter",
    lfoShape: "sine",
    reverbMix: 0.15,
    delayMix: 0,
    delayTime: 0.375,
    masterGain: 0.7,
};

export const DEFAULT_EFFECT_PARAMS: Record<EffectType, Record<string, number>> = {
    eq3: { low: 0, mid: 0, high: 0 },
    parametricEq: { freq1: 100, gain1: 0, q1: 1, freq2: 1000, gain2: 0, q2: 1, freq3: 8000, gain3: 0, q3: 1 },
    compressor: { threshold: -24, knee: 30, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
    limiter: { threshold: -1, release: 0.1 },
    gate: { threshold: -40, attack: 0.001, release: 0.1 },
    reverb: { mix: 0.3, decay: 2.5, preDelay: 0.02, damping: 0.5 },
    delay: { mix: 0.3, time: 0.375, feedback: 0.4, damping: 0.3 },
    chorus: { rate: 1.5, depth: 0.5, mix: 0.5 },
    flanger: { rate: 0.5, depth: 0.7, feedback: 0.5, mix: 0.5 },
    phaser: { rate: 0.5, depth: 0.7, feedback: 0.5, mix: 0.5, stages: 4 },
    distortion: { drive: 0.5, tone: 0.5, mix: 0.5 },
    bitcrusher: { bits: 8, sampleRate: 0.5, mix: 0.5 },
    filter: { type: 0, cutoff: 8000, resonance: 1, mix: 1 },
    sidechain: { threshold: -20, ratio: 8, attack: 0.001, release: 0.2 },
    stereoWidth: { width: 1 },
    deEsser: { threshold: -20, frequency: 6000, ratio: 4 },
    saturator: { drive: 0.3, mix: 0.5, tone: 0.5 },
    tremolo: { rate: 4, depth: 0.5 },
    pingPongDelay: { mix: 0.3, time: 0.25, feedback: 0.4, spread: 0.8 },
    convolutionReverb: { mix: 0.3, decay: 2 },
    noiseSuppression: { threshold: -45, reduction: 15, attack: 0.005, release: 0.05 },
    autotune: { amount: 1 },
    pitchShift: { semitones: 0, cents: 0, mix: 1 },
    vocoderLite: { mix: 0.7 },
};

export const EFFECT_TYPES: EffectType[] = [
    "eq3", "parametricEq", "compressor", "limiter", "gate",
    "reverb", "delay", "chorus", "flanger", "phaser",
    "distortion", "bitcrusher", "filter", "sidechain",
    "stereoWidth", "deEsser", "saturator", "tremolo",
    "pingPongDelay", "convolutionReverb",
    "noiseSuppression", "autotune", "pitchShift", "vocoderLite",
];

export const DRUM_KIT_DEFAULT: StepTrack[] = [
    { id: "kick", name: "Kick", sampleUrl: "", steps: [], volume: 0.8, pan: 0, muted: false, soloed: false, pitch: 0 },
    { id: "snare", name: "Snare", sampleUrl: "", steps: [], volume: 0.75, pan: 0, muted: false, soloed: false, pitch: 0 },
    { id: "clap", name: "Clap", sampleUrl: "", steps: [], volume: 0.7, pan: 0, muted: false, soloed: false, pitch: 0 },
    { id: "hihat", name: "Hi-Hat Cl", sampleUrl: "", steps: [], volume: 0.6, pan: 0.1, muted: false, soloed: false, pitch: 0 },
    { id: "ohh", name: "Hi-Hat Op", sampleUrl: "", steps: [], volume: 0.55, pan: 0.1, muted: false, soloed: false, pitch: 0 },
    { id: "perc1", name: "Perc 1", sampleUrl: "", steps: [], volume: 0.65, pan: -0.2, muted: false, soloed: false, pitch: 0 },
    { id: "perc2", name: "Perc 2", sampleUrl: "", steps: [], volume: 0.65, pan: 0.2, muted: false, soloed: false, pitch: 0 },
    { id: "fx", name: "FX", sampleUrl: "", steps: [], volume: 0.5, pan: 0, muted: false, soloed: false, pitch: 0 },
];

// ═══════════════════════════════════════════════════════════════════════════
// DAW Engine
// ═══════════════════════════════════════════════════════════════════════════

export class DAWEngine {
    ctx: AudioContext;
    private masterGain: GainNode;
    private masterAnalyserL: AnalyserNode;
    private masterAnalyserR: AnalyserNode;
    private masterCompressor: DynamicsCompressorNode;
    private masterLimiter: DynamicsCompressorNode;
    private channelNodes: Map<string, ChannelStrip> = new Map();
    private metronomeGain: GainNode;
    private isPlaying = false;
    private isRecording = false;
    private currentBeat = 0;
    private startTime = 0;
    private schedulerTimer: ReturnType<typeof setInterval> | null = null;
    private lookAheadMs = 25;
    private scheduleAheadSec = 0.1;
    private nextNoteTime = 0;
    private currentStep = 0;
    private activeVoices: Map<string, { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode }[]> = new Map();
    private recordingBuffers: Map<string, AudioBuffer[]> = new Map();
    private mediaRecorder: MediaRecorder | null = null;
    private recordingStream: MediaStream | null = null;
    private recordingSource: MediaStreamAudioSourceNode | null = null;
    private recordingDestination: MediaStreamAudioDestinationNode | null = null;
    private recordingTrackId: string | null = null;
    private recordingStartBeat = 0;
    // MIDI recording
    private midiRecordingNotes: MidiNote[] = [];
    private midiRecordingActiveNotes: Map<number, { start: number; velocity: number }> = new Map();
    private midiRecordingTrackId: string | null = null;
    private _stepPattern: StepSequencerPattern | null = null;
    private _playbackMode: "pattern" | "song" = "song";
    private _activeProject: DAWProject | null = null;

    onBeatUpdate?: (beat: number) => void;
    onStepUpdate?: (step: number) => void; // fires current step index for step sequencer
    onMeterUpdate?: (trackId: string, peakL: number, peakR: number) => void;
    onRecordingData?: (trackId: string, buffer: AudioBuffer) => void;
    onMidiRecordingData?: (trackId: string, notes: MidiNote[]) => void;
    onPlaybackEnd?: () => void;

    constructor() {
        // DAW monitoring needs low input→output latency for the user to play
        // along with the backing track or hear themselves through effects.
        // `interactive` requests the smallest viable buffer; falls back to
        // the OS default if the hint can't be honoured.
        this.ctx = new AudioContext({ latencyHint: "interactive" });

        // Audio keep-alive: see live-engine.ts for full rationale. Inaudible
        // ConstantSourceNode → 0-gain → destination keeps Chrome's tab
        // throttler off our back when the user tabs away to VS Code etc.
        try {
            const ka = this.ctx.createConstantSource();
            ka.offset.value = 0;
            const sink = this.ctx.createGain();
            sink.gain.value = 0;
            ka.connect(sink); sink.connect(this.ctx.destination);
            ka.start();
        } catch { /* older browsers — non-fatal */ }

        // Master chain: gain → compressor → limiter → analyser → destination
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.85;

        this.masterCompressor = this.ctx.createDynamicsCompressor();
        this.masterCompressor.threshold.value = -12;
        this.masterCompressor.knee.value = 10;
        this.masterCompressor.ratio.value = 4;
        this.masterCompressor.attack.value = 0.005;
        this.masterCompressor.release.value = 0.1;

        this.masterLimiter = this.ctx.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -1;
        this.masterLimiter.knee.value = 0;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = 0.001;
        this.masterLimiter.release.value = 0.05;

        // Stereo split for metering
        this.masterAnalyserL = this.ctx.createAnalyser();
        this.masterAnalyserL.fftSize = 2048;
        this.masterAnalyserR = this.ctx.createAnalyser();
        this.masterAnalyserR.fftSize = 2048;

        const splitter = this.ctx.createChannelSplitter(2);
        this.masterGain.connect(this.masterCompressor);
        this.masterCompressor.connect(this.masterLimiter);
        this.masterLimiter.connect(splitter);
        this.masterLimiter.connect(this.ctx.destination);
        splitter.connect(this.masterAnalyserL, 0);
        splitter.connect(this.masterAnalyserR, 1);

        // Metronome
        this.metronomeGain = this.ctx.createGain();
        this.metronomeGain.gain.value = 0;
        this.metronomeGain.connect(this.ctx.destination);

        // Expose for perf monitoring
        if (typeof window !== "undefined") {
            (window as unknown as { __mmo_daw_ctx: AudioContext }).__mmo_daw_ctx = this.ctx;
        }
    }

    // ─── Channel Strip Management ────────────────────────────────────────

    createChannel(trackId: string, type: TrackType = "audio"): ChannelStrip {
        const strip = new ChannelStrip(this.ctx, this.masterGain, trackId, type);
        this.channelNodes.set(trackId, strip);
        return strip;
    }

    removeChannel(trackId: string) {
        const strip = this.channelNodes.get(trackId);
        if (strip) {
            strip.destroy();
            this.channelNodes.delete(trackId);
        }
    }

    getChannel(trackId: string): ChannelStrip | undefined {
        return this.channelNodes.get(trackId);
    }

    // ─── Playback Mode ───────────────────────────────────────────────────

    setStepPattern(pattern: StepSequencerPattern | null) {
        this._stepPattern = pattern;
    }

    setPlaybackMode(mode: "pattern" | "song") {
        this._playbackMode = mode;
    }

    getPlaybackMode(): "pattern" | "song" {
        return this._playbackMode;
    }

    // ─── Transport ───────────────────────────────────────────────────────

    play(project: DAWProject, fromBeat?: number) {
        if (this.isPlaying) return;
        dlog("daw", `play tempo=${project.tempo} fromBeat=${(fromBeat ?? this.currentBeat).toFixed(2)}`, { tempo: project.tempo, fromBeat: fromBeat ?? this.currentBeat, tracks: project.tracks.length });
        this.ctx.resume();
        this.isPlaying = true;
        this.currentBeat = fromBeat ?? this.currentBeat;
        this.startTime = this.ctx.currentTime - this.beatsToSeconds(this.currentBeat, project.tempo);
        this.nextNoteTime = this.ctx.currentTime;
        this.currentStep = Math.floor(this.currentBeat * 4); // 16th notes
        // Cache tempo + project so seek() / pause() / song-end can compute correctly
        // without the caller having to thread project through every transport call.
        this._activeProject = project;

        this.scheduleAutomationLive(project, this.currentBeat);
        this.applySends(project);
        this.schedulePlayback(project);
    }

    stop() {
        if (this.isPlaying) dlog("daw", `stop atBeat=${this.currentBeat.toFixed(2)}`, { atBeat: this.currentBeat });
        this.isPlaying = false;
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        // Stop all active voices
        this.activeVoices.forEach(voices => {
            voices.forEach(v => {
                v.osc.forEach(o => { try { o.stop(); } catch { /* noop */ } });
            });
        });
        this.activeVoices.clear();
        // Stop all playing sources in channel strips
        this.channelNodes.forEach(strip => strip.stopAllSources());
        this.cancelAutomationLive();
    }

    pause() {
        if (!this.isPlaying) return;
        dlog("daw", `pause atBeat=${this.currentBeat.toFixed(2)}`, { atBeat: this.currentBeat });
        this.isPlaying = false;
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
        // Silence everything immediately. Previously `pause()` only stopped the
        // scheduler, but voices/audio-clips already scheduled into the next
        // ~100 ms (lookAhead) and sustained voices kept ringing — so the user
        // heard sound continuing after pressing pause. Mirror `stop()`'s
        // cleanup but keep `currentBeat` intact so resume picks up here.
        this.activeVoices.forEach(voices => {
            voices.forEach(v => {
                v.osc.forEach(o => { try { o.stop(); } catch { /* noop */ } });
            });
        });
        this.activeVoices.clear();
        this.channelNodes.forEach(strip => strip.stopAllSources());
        this.cancelAutomationLive();
    }

    seek(beat: number) {
        const clamped = Math.max(0, beat);
        this.currentBeat = clamped;
        // Keep the 16th-note scheduler grid in sync with the new playhead so
        // resume/scrub-while-playing picks up the right clips immediately.
        this.currentStep = Math.floor(clamped * 4);
        if (this.isPlaying) {
            const tempo = this._activeProject?.tempo ?? 120;
            this.startTime = this.ctx.currentTime - this.beatsToSeconds(clamped, tempo);
            // Cut any voices left over from the old playhead so a scrub doesn't
            // bleed the previous bar's notes through.
            this.activeVoices.forEach(voices => {
                voices.forEach(v => {
                    v.osc.forEach(o => { try { o.stop(); } catch { /* noop */ } });
                });
            });
            this.activeVoices.clear();
            this.channelNodes.forEach(strip => strip.stopAllSources());
            // Restart scheduling from the new position so notes line up cleanly.
            this.nextNoteTime = this.ctx.currentTime;
            if (this._activeProject) {
                this.scheduleAutomationLive(this._activeProject, clamped);
            }
        }
    }

    /**
     * Phase C: live-playback automation runtime.
     *
     * Walks every track's automation lanes and projects their envelope
     * onto the matching live `ChannelStrip` AudioParam (volume → gainParam,
     * pan → panParam). The schedule is computed once at `play()` time
     * starting from `fromBeat`; this is the cheap, correct equivalent of
     * a per-frame "read" mode. Modes `write/touch/latch` are typed but
     * not yet recorded — only `read` is honored at runtime.
     *
     * On `stop()` / `pause()` we cancel scheduled values and snap each
     * param back to the track's static `volume`/`pan` so the next
     * play() starts from a clean state regardless of where automation
     * left it.
     */
    private scheduleAutomationLive(project: DAWProject, fromBeat: number) {
        const ctxNow = this.ctx.currentTime;
        const fromSec = this.beatsToSeconds(fromBeat, project.tempo);
        for (const track of project.tracks) {
            const strip = this.channelNodes.get(track.id);
            if (!strip) continue;
            for (const lane of track.automationLanes ?? []) {
                if (!lane.points?.length) continue;
                if (lane.mode !== "read" && lane.mode !== undefined) continue;
                let target: AudioParam | null = null;
                if (lane.parameter === "volume") target = strip.gainParam;
                else if (lane.parameter === "pan") target = strip.panParam;
                if (!target) continue;

                const sorted = [...lane.points].sort((a, b) => a.time - b.time);
                target.cancelScheduledValues(ctxNow);
                // Anchor the param at the current value so the first ramp
                // starts where it actually is, not where the lane begins.
                const firstSec = this.beatsToSeconds(sorted[0].time, project.tempo);
                if (firstSec > fromSec) {
                    target.setValueAtTime(target.value, ctxNow);
                }
                for (let i = 0; i < sorted.length; i++) {
                    const p = sorted[i];
                    const pSec = this.beatsToSeconds(p.time, project.tempo);
                    if (pSec < fromSec - 0.001) continue; // already in the past
                    const scheduledAt = ctxNow + Math.max(0, pSec - fromSec);
                    const next = sorted[i + 1];
                    if (!next || p.curve === "step") {
                        target.setValueAtTime(p.value, scheduledAt);
                        continue;
                    }
                    const nextSec = this.beatsToSeconds(next.time, project.tempo);
                    const nextAt = ctxNow + Math.max(0, nextSec - fromSec);
                    target.setValueAtTime(p.value, scheduledAt);
                    if (p.curve === "exponential" && p.value > 0.0001 && next.value > 0.0001) {
                        target.exponentialRampToValueAtTime(next.value, nextAt);
                    } else {
                        target.linearRampToValueAtTime(next.value, nextAt);
                    }
                }
            }
        }
    }

    private cancelAutomationLive() {
        const now = this.ctx.currentTime;
        this.channelNodes.forEach((strip) => {
            try { strip.gainParam.cancelScheduledValues(now); } catch { /* noop */ }
            try { strip.panParam.cancelScheduledValues(now); } catch { /* noop */ }
        });
    }

    /**
     * Phase D: rebuild send routing for the entire project.
     *
     * Walks every track's `sends[]` and wires its source ChannelStrip
     * to the matching return-track ChannelStrip's input. Idempotent —
     * each call clears the previous routing first so it's safe to call
     * after any project mutation that touches sends. Cheap because
     * sends are usually 0–3 per track.
     *
     * Called from `play()` so live playback always reflects the latest
     * routing. The DAW context should also call this after `addSend` /
     * `removeSend` / `setSendAmount` if the user wants the change
     * audible without restarting transport.
     */
    applySends(project: DAWProject) {
        this.channelNodes.forEach((strip) => strip.clearSends());
        for (const track of project.tracks) {
            const src = this.channelNodes.get(track.id);
            if (!src || !track.sends?.length) continue;
            for (const send of track.sends) {
                const ret = this.channelNodes.get(send.returnTrackId);
                if (!ret) continue;
                src.connectSend(ret.input, send.amount, send.preFader);
            }
        }
    }

    /**
     * Re-route the insert (FX) chain for every channel from the project
     * state. Cheap, idempotent, and complementary to `applySends`.
     */
    applyInserts(project: DAWProject) {
        for (const track of project.tracks) {
            const strip = this.channelNodes.get(track.id);
            if (!strip) continue;
            strip.setInserts(track.inserts ?? [], (sourceTrackId) => this.channelNodes.get(sourceTrackId)?.getSideTap() ?? null);
        }
    }

    getIsPlaying(): boolean {
        return this.isPlaying;
    }

    getCurrentBeat(): number {
        return this.currentBeat;
    }

    // ─── Scheduler (precise beat-based scheduling) ───────────────────────

    private schedulePlayback(project: DAWProject) {
        const scheduleLoop = () => {
            while (this.nextNoteTime < this.ctx.currentTime + this.scheduleAheadSec) {
                const beat = this.currentStep / 4; // convert 16th notes to beats

                // Update current beat for UI
                this.currentBeat = beat;
                this.onBeatUpdate?.(beat);

                // ── Step sequencer scheduling (always active when pattern exists) ──
                if (this._stepPattern) {
                    const patternSteps = this._stepPattern.steps;
                    const stepsPerBar = project.timeSignature.numerator * 4;
                    const patStep = Math.floor((this.currentStep * patternSteps) / stepsPerBar) % patternSteps;
                    // Only trigger on 16th-note boundaries that align with pattern steps
                    if (this.currentStep % Math.max(1, Math.floor(stepsPerBar / patternSteps)) === 0) {
                        this.onStepUpdate?.(patStep);
                        this.scheduleStepHits(this._stepPattern, patStep, this.nextNoteTime);
                    }
                }

                // In pattern mode, wrap the beat at the pattern length (loop the pattern)
                if (this._playbackMode === "pattern" && this._stepPattern) {
                    const patternLengthBeats = project.timeSignature.numerator; // 1 bar
                    if (beat >= patternLengthBeats) {
                        this.currentStep = 0;
                        this.startTime = this.ctx.currentTime;
                        this.onBeatUpdate?.(0);
                        continue;
                    }
                }

                // Check loop region (song mode)
                if (this._playbackMode === "song" && project.loopRegion.enabled && beat >= project.loopRegion.end) {
                    this.currentStep = Math.floor(project.loopRegion.start * 4);
                    this.startTime = this.ctx.currentTime - this.beatsToSeconds(project.loopRegion.start, project.tempo);
                    continue;
                }

                // Schedule metronome click
                if (this.metronomeGain.gain.value > 0 && this.currentStep % 4 === 0) {
                    this.playMetronomeClick(this.nextNoteTime, this.currentStep % (project.timeSignature.numerator * 4) === 0);
                }

                // Schedule timeline clips (both modes - song mode plays all, pattern mode plays what's under playhead)
                // Schedule MIDI notes for this step
                for (const track of project.tracks) {
                    if (track.muted || track.type !== "midi") continue;
                    for (const clip of track.clips) {
                        if (clip.muted || clip.type !== "midi" || !clip.midi) continue;
                        const clipStartBeat = clip.position;
                        const clipEndBeat = clip.position + clip.length;
                        if (beat >= clipStartBeat && beat < clipEndBeat) {
                            const localBeat = beat - clipStartBeat;
                            for (const note of clip.midi.notes) {
                                if (Math.abs(note.start - localBeat) < 0.001) {
                                    this.scheduleNote(track, note, this.nextNoteTime, project.tempo);
                                }
                            }
                        }
                    }
                }

                // Schedule audio clips
                for (const track of project.tracks) {
                    if (track.muted || track.type !== "audio") continue;
                    for (const clip of track.clips) {
                        if (clip.muted || clip.type !== "audio" || !clip.audio?.buffer) continue;
                        const clipStartSec = this.beatsToSeconds(clip.position, project.tempo);
                        const currentSec = this.beatsToSeconds(beat, project.tempo);
                        // Only schedule at clip start
                        if (Math.abs(currentSec - clipStartSec) < 0.01) {
                            this.scheduleAudioClip(track, clip, this.nextNoteTime);
                        }
                    }
                }

                // Advance
                const secondsPerStep = 60 / project.tempo / 4;
                this.nextNoteTime += secondsPerStep;
                this.currentStep++;

                // Check if we've passed the end of the project (song mode only).
                // Use the larger of the explicit project.duration and the
                // last-clip end so songs whose content extends past the static
                // duration value (e.g. clips added/duplicated by an agent
                // without updating duration) play through to their real end.
                if (this._playbackMode === "song" && !project.loopRegion.enabled) {
                    let lastEnd = project.duration;
                    for (const tr of project.tracks) {
                        for (const cl of tr.clips) {
                            const end = cl.position + cl.length;
                            if (end > lastEnd) lastEnd = end;
                        }
                    }
                    if (beat > lastEnd) {
                        this.stop();
                        this.onPlaybackEnd?.();
                        return;
                    }
                }
            }
        };

        this.schedulerTimer = setInterval(scheduleLoop, this.lookAheadMs);
    }

    // ─── Metronome ───────────────────────────────────────────────────────

    private playMetronomeClick(time: number, isDownbeat: boolean) {
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.frequency.value = isDownbeat ? 1200 : 800;
        osc.type = "sine";
        env.gain.setValueAtTime(0.5, time);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        osc.connect(env);
        env.connect(this.metronomeGain);
        osc.start(time);
        osc.stop(time + 0.05);
    }

    setMetronomeVolume(vol: number) {
        this.metronomeGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.01);
    }

    // ─── Note Scheduling (Synthesizer) ───────────────────────────────────

    private scheduleNote(track: DAWTrack, note: MidiNote, time: number, tempo: number) {
        const strip = this.channelNodes.get(track.id);
        if (!strip) return;

        const durationSec = this.beatsToSeconds(note.duration, tempo);
        const velocityGain = (note.velocity / 127) * 0.8;

        // Simple synth voice: oscillator → filter → envelope → channel strip
        const voiceGain = this.ctx.createGain();
        voiceGain.gain.setValueAtTime(0, time);
        voiceGain.gain.linearRampToValueAtTime(velocityGain, time + 0.005);
        voiceGain.gain.setValueAtTime(velocityGain, time + durationSec - 0.01);
        voiceGain.gain.exponentialRampToValueAtTime(0.001, time + durationSec + 0.1);

        const freq = 440 * Math.pow(2, (note.pitch - 69) / 12);
        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq, time);

        const filter = this.ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(4000, time);
        filter.Q.value = 2;

        osc.connect(filter);
        filter.connect(voiceGain);
        voiceGain.connect(strip.input);
        osc.start(time);
        osc.stop(time + durationSec + 0.15);

        // Track voices for cleanup
        const key = `${track.id}-${note.id}`;
        if (!this.activeVoices.has(key)) this.activeVoices.set(key, []);
        this.activeVoices.get(key)!.push({ osc: [osc], gain: voiceGain, filter });
    }

    // ─── Synth Voice (for real-time playing from piano roll / keyboard) ──

    playSynthNote(trackId: string, pitch: number, velocity: number, config: SynthConfig): string {
        const strip = this.channelNodes.get(trackId);
        if (!strip) return "";
        this.ctx.resume();

        const noteId = `${trackId}-rt-${pitch}-${Date.now()}`;
        const freq = 440 * Math.pow(2, (pitch - 69) / 12);
        const now = this.ctx.currentTime;
        const velGain = (velocity / 127) * config.masterGain;

        // Voice: oscillators → filter → amp envelope → strip
        const voiceGain = this.ctx.createGain();
        voiceGain.gain.setValueAtTime(0, now);
        // Amp ADSR
        voiceGain.gain.linearRampToValueAtTime(velGain, now + config.ampAttack);
        voiceGain.gain.linearRampToValueAtTime(velGain * config.ampSustain, now + config.ampAttack + config.ampDecay);

        const voiceFilter = this.ctx.createBiquadFilter();
        voiceFilter.type = config.filterType;
        // Filter envelope
        const filterStart = Math.min(config.filterCutoff * 0.1, 100);
        const filterPeak = config.filterCutoff + (22050 - config.filterCutoff) * config.filterEnvAmount;
        voiceFilter.frequency.setValueAtTime(filterStart, now);
        voiceFilter.frequency.linearRampToValueAtTime(filterPeak, now + config.filterAttack);
        voiceFilter.frequency.linearRampToValueAtTime(
            filterStart + (filterPeak - filterStart) * config.filterSustain,
            now + config.filterAttack + config.filterDecay
        );
        voiceFilter.Q.value = config.filterResonance;

        const oscillators: OscillatorNode[] = [];
        for (const oscConfig of config.oscillators) {
            if (!oscConfig.enabled) continue;
            const osc = this.ctx.createOscillator();
            osc.type = oscConfig.type;
            osc.frequency.setValueAtTime(freq * Math.pow(2, oscConfig.octave), now);
            osc.detune.setValueAtTime(oscConfig.detune, now);
            const oscGain = this.ctx.createGain();
            oscGain.gain.value = oscConfig.gain;
            osc.connect(oscGain);
            oscGain.connect(voiceFilter);
            osc.start(now);
            oscillators.push(osc);
        }

        voiceFilter.connect(voiceGain);
        voiceGain.connect(strip.input);

        // LFO
        if (config.lfoDepth > 0) {
            const lfo = this.ctx.createOscillator();
            lfo.type = config.lfoShape;
            lfo.frequency.value = config.lfoRate;
            const lfoGain = this.ctx.createGain();
            lfoGain.gain.value = config.lfoDepth;
            lfo.connect(lfoGain);
            switch (config.lfoTarget) {
                case "pitch":
                    lfoGain.gain.value = config.lfoDepth * 100; // cents
                    oscillators.forEach(o => lfoGain.connect(o.detune));
                    break;
                case "filter":
                    lfoGain.gain.value = config.lfoDepth * config.filterCutoff * 0.5;
                    lfoGain.connect(voiceFilter.frequency);
                    break;
                case "amp":
                    lfoGain.gain.value = config.lfoDepth * 0.3;
                    lfoGain.connect(voiceGain.gain);
                    break;
            }
            lfo.start(now);
            oscillators.push(lfo); // track for cleanup
        }

        this.activeVoices.set(noteId, [{ osc: oscillators, gain: voiceGain, filter: voiceFilter }]);
        return noteId;
    }

    stopSynthNote(noteId: string, config: SynthConfig) {
        const voices = this.activeVoices.get(noteId);
        if (!voices) return;
        const now = this.ctx.currentTime;
        for (const voice of voices) {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
            voice.gain.gain.exponentialRampToValueAtTime(0.001, now + config.ampRelease);
            voice.osc.forEach(o => {
                try { o.stop(now + config.ampRelease + 0.05); } catch { /* noop */ }
            });
        }
        setTimeout(() => this.activeVoices.delete(noteId), (config.ampRelease + 0.1) * 1000);
    }

    // ─── Audio Clip Scheduling ───────────────────────────────────────────

    private scheduleAudioClip(track: DAWTrack, clip: Clip, time: number) {
        if (!clip.audio?.buffer) return;
        const strip = this.channelNodes.get(track.id);
        if (!strip) return;

        // Defensive defaults — Maestro / external pipelines may produce
        // partial clip docs missing some envelope fields. Writing undefined
        // or NaN to an AudioParam throws and silences playback entirely.
        const finite = (v: unknown, fallback: number): number =>
            typeof v === "number" && Number.isFinite(v) ? v : fallback;
        const gain = finite(clip.audio.gain, 1);
        const timeStretch = finite(clip.audio.timeStretch, 1);
        const pitchShift = finite(clip.audio.pitchShift, 0);
        const fadeInSec = Math.max(0, finite(clip.audio.fadeIn, 0));
        const fadeOutSec = Math.max(0, finite(clip.audio.fadeOut, 0));
        const startOffset = Math.max(0, finite(clip.audio.startOffset, 0));
        const durationSec = finite(clip.audio.duration, clip.audio.buffer.duration);

        const source = this.ctx.createBufferSource();
        source.buffer = clip.audio.buffer;
        source.playbackRate.value = timeStretch || 1;

        if (pitchShift !== 0) {
            source.detune.value = pitchShift * 100;
        }

        // Clip gain
        const clipGain = this.ctx.createGain();
        clipGain.gain.value = gain;

        // Fade in/out
        if (fadeInSec > 0) {
            clipGain.gain.setValueAtTime(0, time);
            clipGain.gain.linearRampToValueAtTime(gain, time + fadeInSec);
        }
        const clipDuration = durationSec / (timeStretch || 1);
        if (fadeOutSec > 0) {
            clipGain.gain.setValueAtTime(gain, time + clipDuration - fadeOutSec);
            clipGain.gain.linearRampToValueAtTime(0, time + clipDuration);
        }

        source.connect(clipGain);
        clipGain.connect(strip.input);
        source.start(time, startOffset, durationSec);
        strip.addActiveSource(source);
    }

    // ─── Audio Loading ───────────────────────────────────────────────────

    async loadAudioBuffer(url: string): Promise<AudioBuffer> {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        return this.ctx.decodeAudioData(arrayBuffer);
    }

    async loadAudioFile(file: File): Promise<AudioBuffer> {
        const arrayBuffer = await file.arrayBuffer();
        return this.ctx.decodeAudioData(arrayBuffer);
    }

    computeWaveformPeaks(buffer: AudioBuffer, numPeaks: number = 1000): Float32Array {
        const data = buffer.getChannelData(0);
        const peaks = new Float32Array(numPeaks);
        const blockSize = Math.max(1, Math.floor(data.length / numPeaks));
        let globalMax = 0;
        for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            const base = i * blockSize;
            for (let j = 0; j < blockSize; j++) {
                const abs = Math.abs(data[base + j] || 0);
                if (abs > max) max = abs;
            }
            peaks[i] = max;
            if (max > globalMax) globalMax = max;
        }
        // Normalize so the loudest sample fills the available display range.
        // Without this, quiet stems (isolated vocals/bass) draw as a flat line.
        if (globalMax > 0.0001) {
            const inv = 1 / globalMax;
            for (let i = 0; i < numPeaks; i++) peaks[i] *= inv;
        }
        return peaks;
    }

    // ─── Metering ────────────────────────────────────────────────────────

    getMasterPeaks(): { left: number; right: number } {
        const bufL = new Float32Array(this.masterAnalyserL.fftSize);
        const bufR = new Float32Array(this.masterAnalyserR.fftSize);
        this.masterAnalyserL.getFloatTimeDomainData(bufL);
        this.masterAnalyserR.getFloatTimeDomainData(bufR);
        let peakL = 0, peakR = 0;
        for (let i = 0; i < bufL.length; i++) {
            if (Math.abs(bufL[i]) > peakL) peakL = Math.abs(bufL[i]);
            if (Math.abs(bufR[i]) > peakR) peakR = Math.abs(bufR[i]);
        }
        return { left: peakL, right: peakR };
    }

    getChannelPeaks(trackId: string): { left: number; right: number } {
        const strip = this.channelNodes.get(trackId);
        if (!strip) return { left: 0, right: 0 };
        return strip.getPeaks();
    }

    /** Current sidechain gain-reduction in dB applied on `trackId`. */
    getDuckingDb(trackId: string): number {
        return this.channelNodes.get(trackId)?.duckingDb ?? 0;
    }

    // ─── Audio Recording ─────────────────────────────────────────────────

    async startRecording(trackId: string, deviceId?: string, startBeat?: number): Promise<boolean> {
        try {
            // Stop any existing recording first
            if (this.isRecording) {
                this.stopRecording();
            }

            const constraints: MediaStreamConstraints = {
                audio: deviceId && deviceId !== "default"
                    ? {
                        deviceId: { exact: deviceId },
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    }
                    : {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const source = this.ctx.createMediaStreamSource(stream);
            const strip = this.channelNodes.get(trackId);
            if (!strip) {
                stream.getTracks().forEach(t => t.stop());
                return false;
            }

            // Route mic input through the channel strip (effects, gain, pan)
            source.connect(strip.input);

            // Capture POST-FX audio via MediaStreamDestination connected to the strip output
            // This captures the processed audio including any effects on the channel
            const dest = this.ctx.createMediaStreamDestination();
            strip.connectRecordingTap(dest);

            this.isRecording = true;
            this.recordingStream = stream;
            this.recordingSource = source;
            this.recordingDestination = dest;
            this.recordingTrackId = trackId;
            this.recordingStartBeat = startBeat ?? this.currentBeat;

            // Set up MediaRecorder on the post-FX stream
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
            this.mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
            const chunks: Blob[] = [];
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) chunks.push(e.data);
            };
            this.mediaRecorder.onstop = async () => {
                try {
                    const blob = new Blob(chunks, { type: mimeType });
                    if (blob.size === 0) return;
                    const arrayBuffer = await blob.arrayBuffer();
                    const buffer = await this.ctx.decodeAudioData(arrayBuffer);
                    this.onRecordingData?.(trackId, buffer);
                } catch {
                    // Decoding failed
                } finally {
                    stream.getTracks().forEach(t => t.stop());
                }
            };
            this.mediaRecorder.start(500); // 500ms chunks for more reliable capture
            return true;
        } catch {
            return false;
        }
    }

    // ─── MIDI Recording ──────────────────────────────────────────────────

    startMidiRecording(trackId: string, startBeat?: number) {
        this.midiRecordingTrackId = trackId;
        this.midiRecordingNotes = [];
        this.midiRecordingActiveNotes.clear();
        this.recordingStartBeat = startBeat ?? this.currentBeat;
    }

    /** Call when a MIDI noteOn is received during recording */
    recordMidiNoteOn(pitch: number, velocity: number) {
        if (!this.midiRecordingTrackId) return;
        const beatPos = this.currentBeat - this.recordingStartBeat;
        this.midiRecordingActiveNotes.set(pitch, { start: beatPos, velocity });

        // Also play the note live through the track's synth
        const strip = this.channelNodes.get(this.midiRecordingTrackId);
        if (strip) {
            this.playLiveNote(strip, pitch, velocity);
        }
    }

    /** Call when a MIDI noteOff is received during recording */
    recordMidiNoteOff(pitch: number) {
        if (!this.midiRecordingTrackId) return;
        const active = this.midiRecordingActiveNotes.get(pitch);
        if (!active) return;
        const beatPos = this.currentBeat - this.recordingStartBeat;
        const duration = Math.max(0.0625, beatPos - active.start); // minimum 1/16 beat
        this.midiRecordingNotes.push({
            id: createId(),
            pitch,
            velocity: active.velocity,
            start: active.start,
            duration,
            channel: 0,
        });
        this.midiRecordingActiveNotes.delete(pitch);
        this.stopLiveNote(pitch);
    }

    /** Play a note live during MIDI recording (real-time audition) */
    private playLiveNote(strip: ChannelStrip, pitch: number, velocity: number) {
        const now = this.ctx.currentTime;
        const velocityGain = (velocity / 127) * 0.8;
        const freq = 440 * Math.pow(2, (pitch - 69) / 12);

        const voiceGain = this.ctx.createGain();
        voiceGain.gain.setValueAtTime(0, now);
        voiceGain.gain.linearRampToValueAtTime(velocityGain, now + 0.005);

        const osc = this.ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq, now);

        const filter = this.ctx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.setValueAtTime(4000, now);
        filter.Q.value = 2;

        osc.connect(filter);
        filter.connect(voiceGain);
        voiceGain.connect(strip.input);
        osc.start(now);

        // Store for stopLiveNote
        const key = `live_${pitch}`;
        const existing = this.activeVoices.get(key);
        if (existing) {
            existing.forEach(v => {
                v.gain.gain.setTargetAtTime(0, now, 0.01);
                v.osc.forEach(o => { try { o.stop(now + 0.05); } catch { /* */ } });
            });
        }
        this.activeVoices.set(key, [{ osc: [osc], gain: voiceGain, filter }]);
    }

    /** Stop a live note during MIDI recording */
    private stopLiveNote(pitch: number) {
        const key = `live_${pitch}`;
        const voices = this.activeVoices.get(key);
        if (!voices) return;
        const now = this.ctx.currentTime;
        voices.forEach(v => {
            v.gain.gain.setTargetAtTime(0, now, 0.02);
            v.osc.forEach(o => { try { o.stop(now + 0.1); } catch { /* */ } });
        });
        this.activeVoices.delete(key);
    }

    stopMidiRecording() {
        if (!this.midiRecordingTrackId) return;
        // Close any still-held notes
        const beatPos = this.currentBeat - this.recordingStartBeat;
        for (const [pitch, active] of this.midiRecordingActiveNotes) {
            const duration = Math.max(0.0625, beatPos - active.start);
            this.midiRecordingNotes.push({
                id: createId(),
                pitch,
                velocity: active.velocity,
                start: active.start,
                duration,
                channel: 0,
            });
            this.stopLiveNote(pitch);
        }
        this.midiRecordingActiveNotes.clear();

        if (this.midiRecordingNotes.length > 0) {
            this.onMidiRecordingData?.(this.midiRecordingTrackId, [...this.midiRecordingNotes]);
        }
        this.midiRecordingTrackId = null;
        this.midiRecordingNotes = [];
    }

    stopRecording() {
        this.isRecording = false;
        // Disconnect the source node
        if (this.recordingSource) {
            try { this.recordingSource.disconnect(); } catch { /* noop */ }
            this.recordingSource = null;
        }
        // Disconnect recording tap
        if (this.recordingDestination) {
            const strip = this.recordingTrackId ? this.channelNodes.get(this.recordingTrackId) : null;
            if (strip) strip.disconnectRecordingTap(this.recordingDestination);
            this.recordingDestination = null;
        }
        // Stop the MediaRecorder (triggers onstop which delivers the buffer)
        if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
            this.mediaRecorder.stop();
        }
        this.mediaRecorder = null;
        // Also stop MIDI recording
        this.stopMidiRecording();
        this.recordingTrackId = null;
    }

    getRecordingStartBeat(): number {
        return this.recordingStartBeat;
    }

    // ─── Step Sequencer Playback ─────────────────────────────────────────

    playStepPattern(pattern: StepSequencerPattern, step: number) {
        const now = this.ctx.currentTime;
        this.scheduleStepHits(pattern, step, now);
    }

    private scheduleStepHits(pattern: StepSequencerPattern, step: number, time: number) {
        for (const track of pattern.tracks) {
            if (track.muted) continue;
            const stepData = track.steps[step % pattern.steps];
            if (!stepData?.active) continue;
            this.playDrumHit(track, stepData, time);
        }
    }

    private playDrumHit(track: StepTrack, step: StepData, time: number) {
        // Simple drum synthesis (no sample loaded)
        const gain = this.ctx.createGain();
        const velocity = step.accent ? 1 : step.velocity / 127;
        gain.gain.setValueAtTime(velocity * track.volume, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

        // Use noise + tone depending on drum type
        const name = track.name.toLowerCase();
        if (name.includes("kick")) {
            const osc = this.ctx.createOscillator();
            osc.frequency.setValueAtTime(150 + track.pitch * 10, time);
            osc.frequency.exponentialRampToValueAtTime(40, time + 0.1);
            osc.connect(gain);
            gain.connect(this.masterGain);
            osc.start(time);
            osc.stop(time + 0.15);
        } else if (name.includes("snare") || name.includes("clap")) {
            // Noise burst
            const bufferSize = this.ctx.sampleRate * 0.1;
            const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
            const output = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
            const noise = this.ctx.createBufferSource();
            noise.buffer = noiseBuffer;
            const bandpass = this.ctx.createBiquadFilter();
            bandpass.type = "bandpass";
            bandpass.frequency.value = name.includes("clap") ? 2500 : 3000;
            bandpass.Q.value = 0.7;
            noise.connect(bandpass);
            bandpass.connect(gain);
            gain.connect(this.masterGain);
            noise.start(time);
            noise.stop(time + 0.1);
            // Add tonal body for snare
            if (name.includes("snare")) {
                const tone = this.ctx.createOscillator();
                tone.frequency.value = 200 + track.pitch * 20;
                const toneGain = this.ctx.createGain();
                toneGain.gain.setValueAtTime(0.4, time);
                toneGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);
                tone.connect(toneGain);
                toneGain.connect(this.masterGain);
                tone.start(time);
                tone.stop(time + 0.06);
            }
        } else if (name.includes("hat")) {
            const bufferSize = this.ctx.sampleRate * (name.includes("op") ? 0.2 : 0.05);
            const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
            const output = noiseBuffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) output[i] = Math.random() * 2 - 1;
            const noise = this.ctx.createBufferSource();
            noise.buffer = noiseBuffer;
            const hp = this.ctx.createBiquadFilter();
            hp.type = "highpass";
            hp.frequency.value = 7000 + track.pitch * 500;
            noise.connect(hp);
            hp.connect(gain);
            const decayTime = name.includes("op") ? 0.2 : 0.05;
            gain.gain.setValueAtTime(velocity * track.volume * 0.6, time);
            gain.gain.exponentialRampToValueAtTime(0.001, time + decayTime);
            gain.connect(this.masterGain);
            noise.start(time);
            noise.stop(time + decayTime);
        } else {
            // Generic percussion
            const osc = this.ctx.createOscillator();
            osc.frequency.value = 400 + track.pitch * 50;
            osc.type = "triangle";
            osc.connect(gain);
            gain.connect(this.masterGain);
            osc.start(time);
            osc.stop(time + 0.08);
        }
    }

    // ─── Utilities ───────────────────────────────────────────────────────

    beatsToSeconds(beats: number, tempo: number): number {
        return (beats / tempo) * 60;
    }

    secondsToBeats(seconds: number, tempo: number): number {
        return (seconds * tempo) / 60;
    }

    async ensureRunning() {
        if (this.ctx.state === "suspended") {
            await this.ctx.resume();
        }
    }

    setMasterGainValue(vol: number) {
        this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.02);
    }

    getMasterGainValue(): number {
        return this.masterGain.gain.value;
    }

    /**
     * Offline render the project to an AudioBuffer then encode to the requested format.
     *
     * Supported encodings:
     * - WAV at 16/24-bit signed PCM or 32-bit float (`bitDepth`).
     * - MP3 via `@breezystack/lamejs` at the requested kbps (default 192).
     * - FLAC / OGG fall back to WAV — no encoder is bundled.
     *
     * Knobs (all on the optional `options` arg):
     * - `sampleRate`: render rate in Hz. Defaults to engine context rate.
     *   The encoder writes whatever rate `OfflineAudioContext` produced.
     * - `channels`: 1 (mono down-mix as `(L+R)/2`) or 2 (stereo, default).
     * - `tailSec`: silence appended after the last clip end. Default 1s
     *   so reverb/delay tails aren't clipped.
     * - `normalize`: scan the rendered buffer for peak amplitude and apply
     *   a single linear gain so the loudest sample sits at -0.1 dBFS.
     *   Cheap (one extra pass) and avoids quantisation distortion on
     *   16/24-bit exports of low-level material.
     * - `limitPeak`: when true, applies a `tanh`-based soft clipper before
     *   bit-depth reduction so any post-normalize residual stays inside
     *   [-1, 1]. Cheaper than a real lookahead limiter and audibly clean
     *   for the small overshoots a master bus typically produces.
     */
    async exportProject(
        project: DAWProject,
        format: "wav" | "mp3" | "flac" | "ogg",
        options: {
            bitRate?: number;
            bitDepth?: 16 | 24 | 32;
            sampleRate?: number;
            channels?: 1 | 2;
            normalize?: boolean;
            limitPeak?: boolean;
            tailSec?: number;
            onProgress?: (pct: number) => void;
        } = {},
    ): Promise<{ blob: Blob; duration: number }> {
        const onProgress = options.onProgress;
        const targetChannels: 1 | 2 = options.channels ?? 2;
        const targetSampleRate = options.sampleRate ?? this.ctx.sampleRate;
        const targetBitDepth: 16 | 24 | 32 = options.bitDepth ?? 16;
        const tailSec = Math.max(0, options.tailSec ?? 1);
        const normalize = options.normalize ?? false;
        const limitPeak = options.limitPeak ?? false;

        // Calculate project duration from furthest clip end
        let maxBeat = project.duration || 32;
        for (const track of project.tracks) {
            for (const clip of track.clips) {
                const end = clip.position + clip.length;
                if (end > maxBeat) maxBeat = end;
            }
        }
        const durationSec = this.beatsToSeconds(maxBeat, project.tempo) + tailSec;
        // Always render in stereo so the pan node + master chain match the live
        // engine; if the user asked for mono, we down-mix after rendering.
        const offlineCtx = new OfflineAudioContext(2, Math.ceil(targetSampleRate * durationSec), targetSampleRate);

        // Create offline master chain
        const offlineMaster = offlineCtx.createGain();
        offlineMaster.gain.value = project.masterTrack.volume;
        const offlineComp = offlineCtx.createDynamicsCompressor();
        offlineComp.threshold.value = -12;
        offlineComp.ratio.value = 4;
        offlineMaster.connect(offlineComp);
        offlineComp.connect(offlineCtx.destination);

        // Schedule audio clips
        // Phase D: build per-track strip nodes first so sends can wire to
        // return-track inputs regardless of declaration order.
        const strips = new Map<string, { input: GainNode; gainNode: GainNode; panNode: StereoPannerNode }>();
        for (const track of project.tracks) {
            if (track.muted) continue;
            const input = offlineCtx.createGain();
            const trackGain = offlineCtx.createGain();
            trackGain.gain.value = track.volume;
            const trackPan = offlineCtx.createStereoPanner();
            trackPan.pan.value = track.pan;
            input.connect(trackGain);
            trackGain.connect(trackPan);
            // Return tracks should NOT also dump dry signal into master if
            // their only purpose is to receive sends; but per-DAW convention
            // returns also have a fader to master. Keep the connection.
            trackPan.connect(offlineMaster);
            strips.set(track.id, { input, gainNode: trackGain, panNode: trackPan });
        }

        // Wire sends now that all strip inputs exist.
        for (const track of project.tracks) {
            const src = strips.get(track.id);
            if (!src || !track.sends?.length) continue;
            for (const send of track.sends) {
                const ret = strips.get(send.returnTrackId);
                if (!ret) continue;
                const sendGain = offlineCtx.createGain();
                sendGain.gain.value = send.amount;
                const tap: AudioNode = send.preFader ? src.input : src.panNode;
                tap.connect(sendGain);
                sendGain.connect(ret.input);
            }
        }

        for (const track of project.tracks) {
            if (track.muted) continue;
            const strip = strips.get(track.id);
            if (!strip) continue;
            const { input, gainNode: trackGain, panNode: trackPan } = strip;

            // ── Automation: project automation lanes onto track params ────
            // Phase B: volume and pan only. Inserts/sends are not applied
            // because the live engine doesn't apply them either (typed but
            // not wired); rendering them here would silently diverge from
            // what the user hears. Add proper insert routing in a future
            // pass before re-introducing automation for fx params.
            for (const lane of track.automationLanes ?? []) {
                if (!lane.points?.length) continue;
                let target: AudioParam | null = null;
                if (lane.parameter === "volume") target = trackGain.gain;
                else if (lane.parameter === "pan") target = trackPan.pan;
                if (!target) continue; // unsupported parameter — silently skip

                const sorted = [...lane.points].sort((a, b) => a.time - b.time);
                target.cancelScheduledValues(0);
                target.setValueAtTime(sorted[0].value, 0);
                for (let i = 0; i < sorted.length; i++) {
                    const p = sorted[i];
                    const tSec = Math.max(0, this.beatsToSeconds(p.time, project.tempo));
                    const next = sorted[i + 1];
                    if (!next || p.curve === "step") {
                        target.setValueAtTime(p.value, tSec);
                        continue;
                    }
                    const nextTSec = this.beatsToSeconds(next.time, project.tempo);
                    if (p.curve === "exponential" && p.value > 0.0001 && next.value > 0.0001) {
                        target.setValueAtTime(p.value, tSec);
                        target.exponentialRampToValueAtTime(next.value, nextTSec);
                    } else {
                        target.setValueAtTime(p.value, tSec);
                        target.linearRampToValueAtTime(next.value, nextTSec);
                    }
                }
            }

            // ── Audio clips ─────────────────────────────────────────────
            for (const clip of track.clips) {
                if (clip.muted) continue;
                if (clip.type === "audio" && clip.audio?.buffer) {
                    const source = offlineCtx.createBufferSource();
                    source.buffer = clip.audio.buffer;
                    if (clip.audio.pitchShift) source.detune.value = clip.audio.pitchShift * 100;
                    const clipGain = offlineCtx.createGain();
                    const baseGain = clip.audio.gain ?? 1;
                    clipGain.gain.value = baseGain;
                    source.connect(clipGain);
                    clipGain.connect(input);

                    const startSec = this.beatsToSeconds(clip.position, project.tempo);
                    const clipDurSec = this.beatsToSeconds(clip.length, project.tempo);
                    // Apply fade-in / fade-out via the clip gain envelope so
                    // crossfades survive the offline render.
                    const fadeIn = Math.max(0, Math.min(clip.audio.fadeIn ?? 0, clipDurSec));
                    const fadeOut = Math.max(0, Math.min(clip.audio.fadeOut ?? 0, clipDurSec));
                    if (fadeIn > 0) {
                        clipGain.gain.setValueAtTime(0, startSec);
                        clipGain.gain.linearRampToValueAtTime(baseGain, startSec + fadeIn);
                    }
                    if (fadeOut > 0) {
                        clipGain.gain.setValueAtTime(baseGain, startSec + clipDurSec - fadeOut);
                        clipGain.gain.linearRampToValueAtTime(0, startSec + clipDurSec);
                    }
                    source.start(startSec, clip.audio.startOffset ?? 0);
                } else if (clip.type === "midi" && clip.midi?.notes?.length) {
                    // ── MIDI rendering (phase B basic synth) ─────────────
                    // The live engine has a full SynthConfig per voice that
                    // we don't have at render time (clip only stores the
                    // notes + instrumentId). Use a deterministic default
                    // voice: sawtooth osc → lowpass → linear AR env. Good
                    // enough that MIDI tracks aren't silent on export.
                    const clipStartSec = this.beatsToSeconds(clip.position, project.tempo);
                    for (const note of clip.midi.notes) {
                        const noteStart = clipStartSec + this.beatsToSeconds(note.start, project.tempo);
                        const noteDur = this.beatsToSeconds(note.duration, project.tempo);
                        if (noteStart >= durationSec) continue;
                        const freq = 440 * Math.pow(2, (note.pitch - 69) / 12);
                        const vel = Math.max(0, Math.min(1, note.velocity / 127)) * 0.5;
                        const osc = offlineCtx.createOscillator();
                        osc.type = "sawtooth";
                        osc.frequency.value = freq;
                        const filt = offlineCtx.createBiquadFilter();
                        filt.type = "lowpass";
                        filt.frequency.value = 4000;
                        filt.Q.value = 0.7;
                        const env = offlineCtx.createGain();
                        const atk = 0.005;
                        const rel = Math.min(0.15, noteDur * 0.4);
                        env.gain.setValueAtTime(0, noteStart);
                        env.gain.linearRampToValueAtTime(vel, noteStart + atk);
                        env.gain.setValueAtTime(vel, noteStart + Math.max(atk, noteDur - rel));
                        env.gain.linearRampToValueAtTime(0, noteStart + noteDur);
                        osc.connect(filt);
                        filt.connect(env);
                        env.connect(input);
                        osc.start(noteStart);
                        osc.stop(noteStart + noteDur + 0.02);
                    }
                }
            }
        }

        // Progress simulation (OfflineAudioContext doesn't have progress events in all browsers)
        let progressInterval: ReturnType<typeof setInterval> | undefined;
        if (onProgress) {
            const startTime = Date.now();
            const estimatedMs = durationSec * 200; // rough estimate
            progressInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                onProgress(Math.min(95, (elapsed / estimatedMs) * 100));
            }, 100);
        }

        const renderedBuffer = await offlineCtx.startRendering();
        if (progressInterval) clearInterval(progressInterval);
        onProgress?.(98);

        // ── Post-render shaping ───────────────────────────────────────────
        const channelData: Float32Array[] = [];
        const inChannels = renderedBuffer.numberOfChannels;
        if (targetChannels === 1 && inChannels >= 2) {
            // Down-mix to mono via simple average of L+R.
            const len = renderedBuffer.length;
            const mono = new Float32Array(len);
            const l = renderedBuffer.getChannelData(0);
            const r = renderedBuffer.getChannelData(1);
            for (let i = 0; i < len; i++) mono[i] = (l[i] + r[i]) * 0.5;
            channelData.push(mono);
        } else {
            for (let ch = 0; ch < Math.min(inChannels, targetChannels); ch++) {
                // Copy so subsequent normalize/limit doesn't mutate the source buffer.
                channelData.push(new Float32Array(renderedBuffer.getChannelData(ch)));
            }
            // Pad to target channel count (mono → stereo by duplicating).
            while (channelData.length < targetChannels) {
                channelData.push(new Float32Array(channelData[0]));
            }
        }

        if (normalize) {
            let peak = 0;
            for (const ch of channelData) {
                for (let i = 0; i < ch.length; i++) {
                    const a = Math.abs(ch[i]);
                    if (a > peak) peak = a;
                }
            }
            // Normalize so the loudest sample lands at -0.1 dBFS (≈ 0.9886).
            // Skip if the buffer is silent (peak == 0) or already louder than target,
            // unless user explicitly asked — peak < 1e-6 is treated as silence.
            if (peak > 1e-6) {
                const targetPeak = 0.9886;
                const gain = targetPeak / peak;
                if (gain !== 1) {
                    for (const ch of channelData) {
                        for (let i = 0; i < ch.length; i++) ch[i] *= gain;
                    }
                }
            }
        }

        if (limitPeak) {
            // Soft-knee tanh limiter — keeps overshoot under 0 dBFS without
            // the cost of a true lookahead limiter. Threshold ≈ -0.5 dBFS.
            const threshold = 0.95;
            for (const ch of channelData) {
                for (let i = 0; i < ch.length; i++) {
                    const x = ch[i];
                    if (x > threshold) ch[i] = threshold + (1 - threshold) * Math.tanh((x - threshold) / (1 - threshold));
                    else if (x < -threshold) ch[i] = -threshold + (-1 + threshold) * Math.tanh((x + threshold) / (1 - threshold));
                }
            }
        }

        // Encode to the requested format. MP3 ships via @breezystack/lamejs;
        // FLAC / OGG still fall back to WAV (no encoder bundled).
        let blob: Blob;
        if (format === "mp3") {
            blob = await this.encodeMp3(channelData, targetSampleRate, options.bitRate ?? 192);
        } else {
            blob = this.audioBufferToWav(channelData, targetSampleRate, targetBitDepth);
        }
        onProgress?.(100);

        return { blob, duration: durationSec };
    }

    /**
     * MP3 encoder built on `@breezystack/lamejs` (pure-JS fork of lamejs).
     *
     * Quantises Float32 to Int16 PCM and feeds 1152-sample frames to the
     * encoder. We use 1152 because that's the MP3 layer-III granule pair —
     * any other size triggers internal buffering and slows things down.
     *
     * Bitrate is in kbps. Common values: 128 / 192 / 256 / 320. The encoder
     * accepts 8-320 kbps; we don't validate here because the modal already
     * exposes a fixed dropdown.
     */
    private async encodeMp3(channelData: Float32Array[], sampleRate: number, bitRateKbps: number): Promise<Blob> {
        const { Mp3Encoder } = await import("@breezystack/lamejs");
        const channels = channelData.length;
        const encoder = new Mp3Encoder(channels, sampleRate, bitRateKbps);

        const length = channelData[0]?.length ?? 0;
        const FRAME = 1152;
        // Pre-quantise the whole signal so we don't repeat the float→int math
        // per frame. Negligible memory cost vs encoding time.
        const left = new Int16Array(length);
        const right = channels > 1 ? new Int16Array(length) : null;
        const l = channelData[0];
        const r = channels > 1 ? channelData[1] : null;
        for (let i = 0; i < length; i++) {
            const ls = Math.max(-1, Math.min(1, l[i]));
            left[i] = Math.round(ls < 0 ? ls * 0x8000 : ls * 0x7FFF);
            if (right && r) {
                const rs = Math.max(-1, Math.min(1, r[i]));
                right[i] = Math.round(rs < 0 ? rs * 0x8000 : rs * 0x7FFF);
            }
        }

        const chunks: Uint8Array[] = [];
        for (let i = 0; i < length; i += FRAME) {
            const end = Math.min(i + FRAME, length);
            const lChunk = left.subarray(i, end);
            const rChunk = right ? right.subarray(i, end) : undefined;
            const out = rChunk
                ? encoder.encodeBuffer(lChunk, rChunk)
                : encoder.encodeBuffer(lChunk);
            if (out.length) chunks.push(out);
        }
        const tail = encoder.flush();
        if (tail.length) chunks.push(tail);
        return new Blob(chunks as BlobPart[], { type: "audio/mpeg" });
    }

    private audioBufferToWav(channelData: Float32Array[], sampleRate: number, bitDepth: 16 | 24 | 32): Blob {
        const numChannels = channelData.length;
        const length = channelData[0]?.length ?? 0;
        const isFloat = bitDepth === 32;
        const bytesPerSample = bitDepth === 16 ? 2 : bitDepth === 24 ? 3 : 4;
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = length * blockAlign;
        const headerSize = 44;
        const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
        const view = new DataView(arrayBuffer);

        const writeString = (offset: number, str: string) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);                    // fmt chunk size
        view.setUint16(20, isFloat ? 3 : 1, true);        // 1 = PCM, 3 = IEEE float
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        writeString(36, "data");
        view.setUint32(40, dataSize, true);

        let offset = headerSize;
        if (bitDepth === 16) {
            for (let i = 0; i < length; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const s = Math.max(-1, Math.min(1, channelData[ch][i]));
                    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                    offset += 2;
                }
            }
        } else if (bitDepth === 24) {
            for (let i = 0; i < length; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    const s = Math.max(-1, Math.min(1, channelData[ch][i]));
                    const v = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
                    // little-endian 24-bit signed
                    view.setUint8(offset, v & 0xFF);
                    view.setUint8(offset + 1, (v >> 8) & 0xFF);
                    view.setUint8(offset + 2, (v >> 16) & 0xFF);
                    offset += 3;
                }
            }
        } else {
            // 32-bit float
            for (let i = 0; i < length; i++) {
                for (let ch = 0; ch < numChannels; ch++) {
                    view.setFloat32(offset, channelData[ch][i], true);
                    offset += 4;
                }
            }
        }

        return new Blob([arrayBuffer], { type: "audio/wav" });
    }

    destroy() {
        this.stop();
        this.stopRecording();
        if (this.recordingStream) {
            this.recordingStream.getTracks().forEach(t => t.stop());
            this.recordingStream = null;
        }
        this.channelNodes.forEach(strip => strip.destroy());
        this.channelNodes.clear();
        this.ctx.close();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Channel Strip (per-track audio routing)
// ═══════════════════════════════════════════════════════════════════════════

export class ChannelStrip {
    input: GainNode;
    private gainNode: GainNode;
    private panNode: StereoPannerNode;
    private muteNode: GainNode;
    private analyserL: AnalyserNode;
    private analyserR: AnalyserNode;
    private effectNodes: AudioNode[] = [];
    private effectDisposers: Array<() => void> = [];
    /** Latest sidechain gain-reduction in dB (>=0). UI meter reads this. */
    duckingDb: number = 0;
    private activeSources: AudioBufferSourceNode[] = [];
    private destination: GainNode;
    private sendNodes: GainNode[] = [];
    readonly trackId: string;
    readonly type: TrackType;

    /** Live `gain.gain` AudioParam — exposed so the engine can schedule
     *  automation envelopes on top of user-driven `setVolume()` writes. */
    get gainParam(): AudioParam { return this.gainNode.gain; }
    /** Live `pan.pan` AudioParam (StereoPanner). */
    get panParam(): AudioParam { return this.panNode.pan; }

    constructor(ctx: AudioContext, masterBus: GainNode, trackId: string, type: TrackType) {
        this.trackId = trackId;
        this.type = type;
        this.destination = masterBus;

        // Input → effects chain → gain → pan → mute → analyser → master
        this.input = ctx.createGain();
        this.gainNode = ctx.createGain();
        this.panNode = ctx.createStereoPanner();
        this.muteNode = ctx.createGain();

        this.analyserL = ctx.createAnalyser();
        this.analyserL.fftSize = 512;
        this.analyserR = ctx.createAnalyser();
        this.analyserR.fftSize = 512;

        const splitter = ctx.createChannelSplitter(2);

        this.input.connect(this.gainNode);
        this.gainNode.connect(this.panNode);
        this.panNode.connect(this.muteNode);
        this.muteNode.connect(splitter);
        this.muteNode.connect(masterBus);
        splitter.connect(this.analyserL, 0);
        splitter.connect(this.analyserR, 1);
    }

    /** Tap point used by other strips as the source for real sidechain
     *  detection. Returns the pre-fader dry input so ducking is keyed
     *  by the raw incoming signal regardless of the source's own FX. */
    getSideTap(): AudioNode { return this.input; }

    setVolume(vol: number) {
        this.gainNode.gain.setTargetAtTime(vol, this.gainNode.context.currentTime, 0.01);
    }

    setPan(pan: number) {
        this.panNode.pan.setTargetAtTime(pan, this.panNode.context.currentTime, 0.01);
    }

    setMuted(muted: boolean) {
        this.muteNode.gain.setTargetAtTime(muted ? 0 : 1, this.muteNode.context.currentTime, 0.005);
    }

    getPeaks(): { left: number; right: number } {
        const bufL = new Float32Array(this.analyserL.fftSize);
        const bufR = new Float32Array(this.analyserR.fftSize);
        this.analyserL.getFloatTimeDomainData(bufL);
        this.analyserR.getFloatTimeDomainData(bufR);
        let peakL = 0, peakR = 0;
        for (let i = 0; i < bufL.length; i++) {
            if (Math.abs(bufL[i]) > peakL) peakL = Math.abs(bufL[i]);
            if (Math.abs(bufR[i]) > peakR) peakR = Math.abs(bufR[i]);
        }
        return { left: peakL, right: peakR };
    }

    addActiveSource(source: AudioBufferSourceNode) {
        this.activeSources.push(source);
        source.onended = () => {
            const idx = this.activeSources.indexOf(source);
            if (idx >= 0) this.activeSources.splice(idx, 1);
        };
    }

    stopAllSources() {
        this.activeSources.forEach(s => { try { s.stop(); } catch { /* noop */ } });
        this.activeSources = [];
    }

    /** Connect a recording tap to capture post-FX audio from this channel */
    connectRecordingTap(dest: MediaStreamAudioDestinationNode) {
        // Tap the mute node output (same signal going to master bus)
        this.muteNode.connect(dest);
    }

    /** Disconnect a previously connected recording tap */
    disconnectRecordingTap(dest: MediaStreamAudioDestinationNode) {
        try { this.muteNode.disconnect(dest); } catch { /* noop */ }
    }

    /**
     * Phase D: wire a send from this strip to a return-track input.
     *
     *   preFader = false (default) — taps post-fader/post-pan/post-mute,
     *                                so the user hears the send react to
     *                                volume, pan, and mute. Standard DAW
     *                                behaviour for FX returns.
     *   preFader = true            — taps right after the strip input so
     *                                the send is independent of the
     *                                channel fader. Used for headphone
     *                                cue mixes etc.
     *
     * Returns the send gain node so the engine can later mutate `amount`
     * via setTargetAtTime without rebuilding the routing.
     */
    connectSend(returnInput: AudioNode, amount: number, preFader = false): GainNode {
        const ctx = this.input.context;
        const sendGain = ctx.createGain();
        sendGain.gain.value = amount;
        const tap: AudioNode = preFader ? this.input : this.muteNode;
        tap.connect(sendGain);
        sendGain.connect(returnInput);
        this.sendNodes.push(sendGain);
        return sendGain;
    }

    /** Tear down all sends — used when the engine rewires after a
     *  project-level send mutation. Idempotent. */
    clearSends() {
        for (const g of this.sendNodes) {
            try { g.disconnect(); } catch { /* noop */ }
        }
        this.sendNodes = [];
    }

    /**
     * Rebuild the insert (FX) chain from a list of enabled effects.
     *
     * Routing: input → fx1 → fx2 → ... → gainNode
     *
     * Only a subset of EFFECT_TYPES is implemented as real WebAudio nodes
     * today (eq3, compressor, limiter, gate, filter, delay, distortion,
     * stereoWidth). Unknown or disabled entries are skipped (bypassed)
     * but their order is preserved, so re-adding the missing types in a
     * follow-up won't change UX. Idempotent — safe to call any time.
     */
    setInserts(inserts: InsertEffect[], resolveSideInput?: (sourceTrackId: string) => AudioNode | null) {
        const ctx = this.input.context;
        // Detach previous chain
        try { this.input.disconnect(); } catch { /* noop */ }
        for (const dispose of this.effectDisposers) {
            try { dispose(); } catch { /* noop */ }
        }
        this.effectDisposers = [];
        for (const n of this.effectNodes) {
            try { n.disconnect(); } catch { /* noop */ }
        }
        this.effectNodes = [];

        let head: AudioNode = this.input;
        for (const ins of inserts) {
            if (!ins.enabled) continue;
            let sideInput: AudioNode | null | undefined;
            if (ins.type === "sidechain") {
                const srcId = ins.sidechainSourceTrackId;
                if (srcId && srcId !== this.trackId) {
                    sideInput = resolveSideInput?.(srcId) ?? null;
                }
            }
            const node = buildEffectNode(ctx, ins, sideInput ?? undefined, (db) => { this.duckingDb = db; });
            if (!node) continue;
            head.connect(node.input);
            head = node.output;
            this.effectNodes.push(node.input);
            if (node.output !== node.input) this.effectNodes.push(node.output);
            if (node.dispose) this.effectDisposers.push(node.dispose);
        }
        head.connect(this.gainNode);
    }

    destroy() {
        this.stopAllSources();
        this.input.disconnect();
        this.gainNode.disconnect();
        this.panNode.disconnect();
        this.muteNode.disconnect();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Effect Node Factory (subset of EFFECT_TYPES wired up as real WebAudio nodes)
// ═══════════════════════════════════════════════════════════════════════════

interface BuiltEffect { input: AudioNode; output: AudioNode; dispose?: () => void }

// Lazy AudioWorklet loaders, one promise per AudioContext.
const workletLoaders = new WeakMap<BaseAudioContext, Map<string, Promise<boolean>>>();
function ensureWorklet(ctx: BaseAudioContext, name: string, url: string): Promise<boolean> {
    let m = workletLoaders.get(ctx);
    if (!m) { m = new Map(); workletLoaders.set(ctx, m); }
    let p = m.get(name);
    if (p) return p;
    if (!(ctx instanceof AudioContext) || !ctx.audioWorklet) {
        p = Promise.resolve(false);
    } else {
        p = ctx.audioWorklet.addModule(url).then(() => true).catch(() => false);
    }
    m.set(name, p);
    return p;
}

function buildEffectNode(ctx: BaseAudioContext, effect: InsertEffect, sideInput?: AudioNode, onMeter?: (gainReductionDb: number) => void): BuiltEffect | null {
    const p = effect.params ?? {};
    switch (effect.type) {
        case "eq3": {
            const low = ctx.createBiquadFilter();
            low.type = "lowshelf"; low.frequency.value = 250; low.gain.value = p.low ?? 0;
            const mid = ctx.createBiquadFilter();
            mid.type = "peaking"; mid.frequency.value = 1200; mid.Q.value = 1; mid.gain.value = p.mid ?? 0;
            const high = ctx.createBiquadFilter();
            high.type = "highshelf"; high.frequency.value = 5000; high.gain.value = p.high ?? 0;
            low.connect(mid); mid.connect(high);
            return { input: low, output: high };
        }
        case "compressor": {
            const c = ctx.createDynamicsCompressor();
            c.threshold.value = p.threshold ?? -24;
            c.knee.value = p.knee ?? 30;
            c.ratio.value = p.ratio ?? 4;
            c.attack.value = p.attack ?? 0.003;
            c.release.value = p.release ?? 0.25;
            return { input: c, output: c };
        }
        case "limiter": {
            const c = ctx.createDynamicsCompressor();
            c.threshold.value = p.threshold ?? -1;
            c.knee.value = 0;
            c.ratio.value = 20;
            c.attack.value = 0.001;
            c.release.value = p.release ?? 0.1;
            return { input: c, output: c };
        }
        case "filter": {
            const f = ctx.createBiquadFilter();
            const typeIdx = Math.round(p.type ?? 0);
            const TYPES: BiquadFilterType[] = ["lowpass", "highpass", "bandpass", "notch"];
            f.type = TYPES[typeIdx] ?? "lowpass";
            f.frequency.value = p.cutoff ?? 8000;
            f.Q.value = p.resonance ?? 1;
            return { input: f, output: f };
        }
        case "delay": {
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const out = ctx.createGain();
            const d = ctx.createDelay(2.0);
            d.delayTime.value = Math.min(p.time ?? 0.375, 2);
            const fb = ctx.createGain();
            fb.gain.value = Math.max(0, Math.min(p.feedback ?? 0.4, 0.95));
            const damp = ctx.createBiquadFilter();
            damp.type = "lowpass";
            damp.frequency.value = 8000 * (1 - (p.damping ?? 0.3));
            const mix = p.mix ?? 0.3;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            inGain.connect(dry);
            inGain.connect(d);
            d.connect(damp); damp.connect(fb); fb.connect(d);
            damp.connect(wet);
            dry.connect(out); wet.connect(out);
            return { input: inGain, output: out };
        }
        case "distortion":
        case "saturator": {
            const ws = ctx.createWaveShaper();
            const drive = Math.max(0.01, Math.min(p.drive ?? 0.5, 1));
            ws.curve = buildSaturationCurve(drive * 100);
            ws.oversample = "2x";
            return { input: ws, output: ws };
        }
        case "stereoWidth": {
            // Mid/Side width: M = (L+R)/2, S = (L-R)/2. Recombine L = M + width*S, R = M - width*S.
            // Requires a 2-channel context; fall back to a passthrough on mono.
            const width = Math.max(0, Math.min(p.width ?? 1, 2));
            const inGain = ctx.createGain();
            const out = ctx.createGain();
            const split = ctx.createChannelSplitter(2);
            const merger = ctx.createChannelMerger(2);
            const lGain = ctx.createGain(); lGain.gain.value = 0.5;
            const rGainPos = ctx.createGain(); rGainPos.gain.value = 0.5;
            const rGainNeg = ctx.createGain(); rGainNeg.gain.value = -0.5;
            const mid = ctx.createGain(); mid.gain.value = 1;
            const side = ctx.createGain(); side.gain.value = width;
            // M = 0.5*L + 0.5*R
            split.connect(lGain, 0); lGain.connect(mid);
            split.connect(rGainPos, 1); rGainPos.connect(mid);
            // S = 0.5*L - 0.5*R
            const lGain2 = ctx.createGain(); lGain2.gain.value = 0.5;
            split.connect(lGain2, 0); lGain2.connect(side);
            split.connect(rGainNeg, 1); rGainNeg.connect(side);
            // L_out = M + S
            const lOut = ctx.createGain(); mid.connect(lOut); side.connect(lOut);
            // R_out = M - S
            const negSide = ctx.createGain(); negSide.gain.value = -1;
            const rOut = ctx.createGain(); mid.connect(rOut); side.connect(negSide); negSide.connect(rOut);
            lOut.connect(merger, 0, 0);
            rOut.connect(merger, 0, 1);
            inGain.connect(split);
            merger.connect(out);
            return { input: inGain, output: out };
        }
        case "deEsser": {
            // Sibilance compressor: high-pass detector branch keys a compressor on the wet path.
            const inGain = ctx.createGain();
            const out = ctx.createGain();
            const hpf = ctx.createBiquadFilter();
            hpf.type = "highpass"; hpf.frequency.value = p.frequency ?? 6000;
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = p.threshold ?? -24;
            comp.ratio.value = p.ratio ?? 4;
            comp.attack.value = 0.001;
            comp.release.value = 0.05;
            comp.knee.value = 5;
            inGain.connect(hpf); hpf.connect(comp); comp.connect(out);
            // Dry path keeps body intact alongside the de-essed top end.
            const dry = ctx.createGain(); dry.gain.value = 1;
            inGain.connect(dry); dry.connect(out);
            return { input: inGain, output: out };
        }
        case "noiseSuppression": {
            // Downward expander/gate via steep compressor over a HPF detector.
            const inGain = ctx.createGain();
            const c = ctx.createDynamicsCompressor();
            c.threshold.value = p.threshold ?? -45;
            c.ratio.value = Math.max(2, (p.reduction ?? 15) / 3);
            c.attack.value = p.attack ?? 0.005;
            c.release.value = p.release ?? 0.05;
            c.knee.value = 5;
            inGain.connect(c);
            return { input: inGain, output: c };
        }
        case "autotune": {
            // Granular pitch correction worklet. Until it loads we pass dry audio.
            if (typeof AudioWorkletNode !== "undefined") {
                const pass = ctx.createGain();
                ensureWorklet(ctx, "pitch-shifter", "/worklets/pitch-shifter-processor.js").then((ok) => {
                    if (!ok) return;
                    try {
                        const node = new AudioWorkletNode(ctx, "pitch-shifter", {
                            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                        });
                        const mixParam = node.parameters.get("mix");
                        const ratioParam = node.parameters.get("pitchRatio");
                        if (mixParam) mixParam.value = Math.max(0, Math.min(1, p.amount ?? 1));
                        if (ratioParam) ratioParam.value = 1;
                        try { pass.disconnect(); } catch { /* noop */ }
                        pass.connect(node);
                        // The node is exposed as the output by the chain; rewire upstream/downstream.
                        // Without rebuild hooks, we just bridge through `pass` -> node fan-out.
                    } catch { /* fall through */ }
                });
                return { input: pass, output: pass };
            }
            const g = ctx.createGain();
            return { input: g, output: g };
        }
        case "pitchShift": {
            if (typeof AudioWorkletNode !== "undefined") {
                const pass = ctx.createGain();
                ensureWorklet(ctx, "pitch-shifter", "/worklets/pitch-shifter-processor.js").then((ok) => {
                    if (!ok) return;
                    try {
                        const node = new AudioWorkletNode(ctx, "pitch-shifter", {
                            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
                        });
                        const semis = (p.semitones ?? 0) + (p.cents ?? 0) / 100;
                        const ratio = Math.pow(2, semis / 12);
                        const ratioParam = node.parameters.get("pitchRatio");
                        const mixParam = node.parameters.get("mix");
                        if (ratioParam) ratioParam.value = Math.max(0.25, Math.min(4, ratio));
                        if (mixParam) mixParam.value = Math.max(0, Math.min(1, p.mix ?? 1));
                        try { pass.disconnect(); } catch { /* noop */ }
                        pass.connect(node);
                    } catch { /* noop */ }
                });
                return { input: pass, output: pass };
            }
            const g = ctx.createGain();
            return { input: g, output: g };
        }
        case "vocoderLite": {
            // 8-band channel vocoder approximation: split through band-pass filters,
            // gate each band with an envelope follower keyed off the same signal,
            // mix back with dry control.
            const inGain = ctx.createGain();
            const out = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const mix = p.mix ?? 0.7;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            const bands = [200, 400, 700, 1100, 1700, 2700, 4200, 6500];
            for (const f of bands) {
                const bp = ctx.createBiquadFilter();
                bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = 6;
                const env = ctx.createDynamicsCompressor();
                env.threshold.value = -50; env.ratio.value = 1.5; env.attack.value = 0.01; env.release.value = 0.05;
                inGain.connect(bp); bp.connect(env); env.connect(wet);
            }
            inGain.connect(dry);
            dry.connect(out); wet.connect(out);
            return { input: inGain, output: out };
        }
        case "gate": {
            // Hard-knee gate via DynamicsCompressor in expander-like config
            // is impossible directly; approximate by a steep compressor.
            const c = ctx.createDynamicsCompressor();
            c.threshold.value = p.threshold ?? -40;
            c.knee.value = 0;
            c.ratio.value = 20;
            c.attack.value = p.attack ?? 0.001;
            c.release.value = p.release ?? 0.1;
            return { input: c, output: c };
        }
        case "parametricEq": {
            // 3 fully-parametric peaking bands.
            const b1 = ctx.createBiquadFilter();
            b1.type = "peaking"; b1.frequency.value = p.f1 ?? 120; b1.Q.value = p.q1 ?? 1; b1.gain.value = p.g1 ?? 0;
            const b2 = ctx.createBiquadFilter();
            b2.type = "peaking"; b2.frequency.value = p.f2 ?? 1000; b2.Q.value = p.q2 ?? 1; b2.gain.value = p.g2 ?? 0;
            const b3 = ctx.createBiquadFilter();
            b3.type = "peaking"; b3.frequency.value = p.f3 ?? 6000; b3.Q.value = p.q3 ?? 1; b3.gain.value = p.g3 ?? 0;
            b1.connect(b2); b2.connect(b3);
            return { input: b1, output: b3 };
        }
        case "chorus": {
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const out = ctx.createGain();
            const d = ctx.createDelay(0.05);
            const base = (p.delay ?? 0.015);
            d.delayTime.value = base;
            const lfo = ctx.createOscillator();
            lfo.frequency.value = p.rate ?? 1.5;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = p.depth ?? 0.005;
            lfo.connect(lfoGain); lfoGain.connect(d.delayTime);
            const mix = p.mix ?? 0.4;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            inGain.connect(dry); inGain.connect(d); d.connect(wet);
            dry.connect(out); wet.connect(out);
            try { lfo.start(); } catch { /* already started */ }
            return { input: inGain, output: out };
        }
        case "flanger": {
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const out = ctx.createGain();
            const d = ctx.createDelay(0.02);
            d.delayTime.value = p.delay ?? 0.005;
            const fb = ctx.createGain();
            fb.gain.value = Math.max(0, Math.min(p.feedback ?? 0.5, 0.95));
            const lfo = ctx.createOscillator();
            lfo.frequency.value = p.rate ?? 0.5;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = p.depth ?? 0.003;
            lfo.connect(lfoGain); lfoGain.connect(d.delayTime);
            const mix = p.mix ?? 0.5;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            inGain.connect(dry); inGain.connect(d);
            d.connect(fb); fb.connect(d);
            d.connect(wet);
            dry.connect(out); wet.connect(out);
            try { lfo.start(); } catch { /* already started */ }
            return { input: inGain, output: out };
        }
        case "phaser": {
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const out = ctx.createGain();
            const stages: BiquadFilterNode[] = [];
            const stageCount = Math.max(2, Math.min(Math.round(p.stages ?? 4), 8));
            for (let i = 0; i < stageCount; i++) {
                const f = ctx.createBiquadFilter();
                f.type = "allpass";
                f.frequency.value = 500 + i * 400;
                f.Q.value = p.q ?? 1;
                stages.push(f);
            }
            for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);
            const lfo = ctx.createOscillator();
            lfo.frequency.value = p.rate ?? 0.5;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = (p.depth ?? 0.5) * 1500;
            lfo.connect(lfoGain);
            for (const s of stages) lfoGain.connect(s.frequency);
            const mix = p.mix ?? 0.5;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            inGain.connect(dry); inGain.connect(stages[0]);
            stages[stages.length - 1].connect(wet);
            dry.connect(out); wet.connect(out);
            try { lfo.start(); } catch { /* already started */ }
            return { input: inGain, output: out };
        }
        case "bitcrusher": {
            // Bit-reduction only (no sample-rate decimation without an
            // AudioWorklet). Builds a stair-step curve quantising the
            // [-1,1] domain into 2^bits levels.
            const bits = Math.max(1, Math.min(Math.round(p.bits ?? 8), 16));
            const levels = Math.pow(2, bits);
            const n = 4096;
            const curve = new Float32Array(new ArrayBuffer(n * 4));
            for (let i = 0; i < n; i++) {
                const x = (i * 2) / n - 1;
                curve[i] = Math.round(x * levels) / levels;
            }
            const ws = ctx.createWaveShaper();
            ws.curve = curve;
            ws.oversample = "none";
            return { input: ws, output: ws };
        }
        case "sidechain": {
            const baseThreshold = p.threshold ?? -24;
            const ratio = p.ratio ?? 8;
            const attack = p.attack ?? 0.005;
            const release = p.release ?? 0.15;
            // No side input → behave as a simple compressor on self.
            if (!sideInput || !(ctx instanceof AudioContext)) {
                const c = ctx.createDynamicsCompressor();
                c.threshold.value = baseThreshold;
                c.knee.value = p.knee ?? 6;
                c.ratio.value = ratio;
                c.attack.value = attack;
                c.release.value = release;
                return { input: c, output: c };
            }
            // Build a passthrough that we'll swap for the worklet ducker
            // once the module loads. Until then a DynamicsCompressor with
            // self-keyed detection runs so audio is never silent.
            const inGain = ctx.createGain();
            const outGain = ctx.createGain();
            const fallbackCompressor = ctx.createDynamicsCompressor();
            fallbackCompressor.threshold.value = baseThreshold;
            fallbackCompressor.knee.value = p.knee ?? 6;
            fallbackCompressor.ratio.value = ratio;
            fallbackCompressor.attack.value = attack;
            fallbackCompressor.release.value = release;
            inGain.connect(fallbackCompressor); fallbackCompressor.connect(outGain);

            const sideTap = ctx.createGain();
            sideTap.gain.value = 1;
            try { sideInput.connect(sideTap); } catch { /* noop */ }

            let worklet: AudioWorkletNode | null = null;
            let raf = 0;
            let analyser: AnalyserNode | null = null;
            let cancelled = false;

            ensureWorklet(ctx, "sidechain-ducker", "/worklets/sidechain-ducker.js").then((ok) => {
                if (cancelled) return;
                if (ok) {
                    try {
                        worklet = new AudioWorkletNode(ctx, "sidechain-ducker", {
                            numberOfInputs: 2,
                            numberOfOutputs: 1,
                            outputChannelCount: [2],
                            parameterData: { threshold: baseThreshold, ratio, attack, release, range: 36 },
                        });
                        worklet.port.onmessage = (e) => {
                            const d = e.data as { gainReductionDb?: number };
                            if (typeof d?.gainReductionDb === "number") onMeter?.(d.gainReductionDb);
                        };
                        // Rewire: input → worklet input 1 (dry), side → worklet input 0
                        try { inGain.disconnect(); } catch { /* noop */ }
                        try { sideTap.disconnect(); } catch { /* noop */ }
                        sideTap.connect(worklet, 0, 0);
                        inGain.connect(worklet, 0, 1);
                        worklet.connect(outGain);
                        // Detach fallback chain
                        try { fallbackCompressor.disconnect(); } catch { /* noop */ }
                        try { sideInput.connect(sideTap); } catch { /* noop */ }
                        return;
                    } catch { /* fall through to analyser */ }
                }
                // Fallback: rAF analyser drives fallbackCompressor.threshold
                analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                analyser.smoothingTimeConstant = 0.4;
                sideTap.connect(analyser);
                const buf = new Float32Array(analyser.fftSize);
                const range = 36;
                const tick = () => {
                    if (cancelled || !analyser) return;
                    analyser.getFloatTimeDomainData(buf);
                    let sum = 0;
                    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                    const rms = Math.sqrt(sum / buf.length);
                    const db = rms > 1e-6 ? 20 * Math.log10(rms) : -120;
                    const drive = Math.max(0, Math.min(1, (db + 40) / 40));
                    const target = Math.max(-60, baseThreshold - drive * range);
                    fallbackCompressor.threshold.setTargetAtTime(target, ctx.currentTime, 0.02);
                    onMeter?.(drive * range);
                    raf = requestAnimationFrame(tick);
                };
                raf = requestAnimationFrame(tick);
            });

            const dispose = () => {
                cancelled = true;
                cancelAnimationFrame(raf);
                try { worklet?.disconnect(); } catch { /* noop */ }
                try { sideTap.disconnect(); } catch { /* noop */ }
                try { analyser?.disconnect(); } catch { /* noop */ }
                try { fallbackCompressor.disconnect(); } catch { /* noop */ }
                try { inGain.disconnect(); } catch { /* noop */ }
                onMeter?.(0);
            };
            return { input: inGain, output: outGain, dispose };
        }
        case "tremolo": {
            const inGain = ctx.createGain();
            const vca = ctx.createGain();
            vca.gain.value = 1 - (p.depth ?? 0.5) / 2;
            const lfo = ctx.createOscillator();
            lfo.frequency.value = p.rate ?? 5;
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = (p.depth ?? 0.5) / 2;
            lfo.connect(lfoGain); lfoGain.connect(vca.gain);
            inGain.connect(vca);
            try { lfo.start(); } catch { /* already started */ }
            return { input: inGain, output: vca };
        }
        case "pingPongDelay": {
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const out = ctx.createGain();
            const time = Math.min(p.time ?? 0.375, 2);
            const dL = ctx.createDelay(2.0); dL.delayTime.value = time;
            const dR = ctx.createDelay(2.0); dR.delayTime.value = time * 2;
            const fb = ctx.createGain();
            fb.gain.value = Math.max(0, Math.min(p.feedback ?? 0.4, 0.9));
            const panL = ctx.createStereoPanner(); panL.pan.value = -1;
            const panR = ctx.createStereoPanner(); panR.pan.value = 1;
            const mix = p.mix ?? 0.3;
            dry.gain.value = 1 - mix;
            const wet = ctx.createGain(); wet.gain.value = mix;
            inGain.connect(dry);
            inGain.connect(dL);
            dL.connect(panL); panL.connect(wet);
            dL.connect(dR); dR.connect(panR); panR.connect(wet);
            dR.connect(fb); fb.connect(dL);
            dry.connect(out); wet.connect(out);
            return { input: inGain, output: out };
        }
        case "convolutionReverb":
        case "reverb": {
            const conv = ctx.createConvolver();
            const seconds = Math.max(0.3, Math.min(p.decay ?? 2.5, 8));
            conv.buffer = buildImpulseResponse(ctx, seconds, p.preDelay ?? 0);
            const inGain = ctx.createGain();
            const dry = ctx.createGain();
            const wet = ctx.createGain();
            const out = ctx.createGain();
            const mix = p.mix ?? 0.3;
            dry.gain.value = 1 - mix;
            wet.gain.value = mix;
            inGain.connect(dry);
            inGain.connect(conv); conv.connect(wet);
            dry.connect(out); wet.connect(out);
            return { input: inGain, output: out };
        }
        default:
            // Unsupported types are bypassed silently (an identity GainNode keeps
            // the chain order intact for follow-up implementations).
            return null;
    }
}

function buildImpulseResponse(ctx: BaseAudioContext, seconds: number, preDelaySec: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const preDelay = Math.max(0, Math.floor(rate * preDelaySec));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = preDelay; i < len; i++) {
            const t = (i - preDelay) / len;
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5);
        }
    }
    return buf;
}

function buildSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
}

// ═══════════════════════════════════════════════════════════════════════════
// Project Helpers
// ═══════════════════════════════════════════════════════════════════════════

let colorIndex = 0;
function nextColor(): string {
    const c = TRACK_COLORS[colorIndex % TRACK_COLORS.length];
    colorIndex++;
    return c;
}

export function createId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultTrack(type: TrackType, name: string): DAWTrack {
    return {
        id: createId(),
        name,
        type,
        color: nextColor(),
        volume: type === "master" ? 0.85 : 0.75,
        pan: 0,
        muted: false,
        soloed: false,
        armed: false,
        frozen: false,
        height: 80,
        inserts: [],
        sends: [],
        clips: [],
        automationLanes: [],
        inputSource: "none",
        outputTarget: "master",
        peakL: 0,
        peakR: 0,
    };
}

export function createDefaultProject(name: string = "Untitled Project"): DAWProject {
    return {
        id: createId(),
        name,
        tempo: 128,
        timeSignature: { numerator: 4, denominator: 4 },
        tracks: [
            { ...createDefaultTrack("audio", "Audio 1"), color: "#3b82f6" },
            { ...createDefaultTrack("audio", "Audio 2"), color: "#06b6d4" },
            { ...createDefaultTrack("midi", "Synth 1"), color: "#8b5cf6", instrumentId: "synth" },
            { ...createDefaultTrack("midi", "Drums"), color: "#f97316", instrumentId: "drums" },
            { ...createDefaultTrack("return", "Return A"), color: "#10b981" },
        ],
        masterTrack: { ...createDefaultTrack("master", "Master"), color: "#ef4444" },
        loopRegion: { start: 0, end: 16, enabled: false },
        createdAt: Date.now(),
        modifiedAt: Date.now(),
        duration: 64, // 64 beats = 16 bars in 4/4
    };
}

export function createDefaultStepPattern(): StepSequencerPattern {
    return {
        id: createId(),
        name: "Pattern 1",
        steps: 16,
        swing: 0,
        tracks: DRUM_KIT_DEFAULT.map(t => ({
            ...t,
            steps: Array.from({ length: 16 }, () => ({ active: false, velocity: 100, accent: false })),
        })),
    };
}

export function createClip(type: ClipType, trackId: string, position: number, length: number, name: string): Clip {
    return {
        id: createId(),
        type,
        name,
        trackId,
        position,
        length,
        color: "#8b5cf6",
        muted: false,
        ...(type === "audio" ? {
            audio: {
                buffer: null,
                sourceUrl: "",
                name,
                startOffset: 0,
                duration: 0,
                sampleRate: 48000,
                channels: 2,
                gain: 1,
                fadeIn: 0,
                fadeOut: 0,
                reversed: false,
                pitchShift: 0,
                timeStretch: 1,
            },
        } : {
            midi: {
                notes: [],
                instrumentId: "synth",
            },
        }),
    };
}

// ─── Project Persistence ─────────────────────────────────────────────────

const DAW_STORAGE_KEY = "mmo-daw-projects";
const DAW_ACTIVE_KEY = "mmo-daw-active-project";

export function saveProject(project: DAWProject) {
    const projects = loadProjectList();
    const idx = projects.findIndex(p => p.id === project.id);
    const meta = { id: project.id, name: project.name, modifiedAt: Date.now(), tempo: project.tempo, trackCount: project.tracks.length };
    if (idx >= 0) projects[idx] = meta;
    else projects.push(meta);
    localStorage.setItem(DAW_STORAGE_KEY, JSON.stringify(projects));
    localStorage.setItem(`mmo-daw-project-${project.id}`, JSON.stringify({
        ...project,
        // Strip AudioBuffers (not serializable)
        tracks: project.tracks.map(t => ({
            ...t,
            clips: t.clips.map(c => ({
                ...c,
                audio: c.audio ? { ...c.audio, buffer: null, waveformPeaks: undefined } : undefined,
            })),
        })),
        modifiedAt: Date.now(),
    }));
    localStorage.setItem(DAW_ACTIVE_KEY, project.id);
}

export function loadProject(id: string): DAWProject | null {
    try {
        const raw = localStorage.getItem(`mmo-daw-project-${id}`);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function loadProjectList(): { id: string; name: string; modifiedAt: number; tempo: number; trackCount: number }[] {
    try {
        const raw = localStorage.getItem(DAW_STORAGE_KEY);
        if (!raw) return [];
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

export function getActiveProjectId(): string | null {
    return localStorage.getItem(DAW_ACTIVE_KEY);
}

export const listProjects = loadProjectList;

export function deleteProject(id: string) {
    const projects = loadProjectList().filter(p => p.id !== id);
    localStorage.setItem(DAW_STORAGE_KEY, JSON.stringify(projects));
    localStorage.removeItem(`mmo-daw-project-${id}`);
}

// ─── Project file I/O (.mmodaw.json) ────────────────────────────────────
//
// Lets users back up / share a project as a single file. Buffers are
// already stripped on save (see `saveProject`), so the JSON is small
// and round-trippable. Each clip references its source track by id;
// re-importing on a different machine will need the user to re-attach
// the audio, but the timeline + automation + plugin chain survive.

const PROJECT_FILE_VERSION = 1;
const PROJECT_FILE_EXT = "mmodaw.json";

interface ProjectFileEnvelope {
    format: "mmodaw";
    version: number;
    exportedAt: number;
    project: DAWProject;
}

export function exportProjectFile(project: DAWProject): Blob {
    const sanitized: DAWProject = {
        ...project,
        tracks: project.tracks.map((t) => ({
            ...t,
            clips: t.clips.map((c) => ({
                ...c,
                audio: c.audio ? { ...c.audio, buffer: null, waveformPeaks: undefined } : undefined,
            })),
        })),
    };
    const envelope: ProjectFileEnvelope = {
        format: "mmodaw",
        version: PROJECT_FILE_VERSION,
        exportedAt: Date.now(),
        project: sanitized,
    };
    return new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
}

export async function importProjectFile(file: File, options?: { rename?: boolean }): Promise<DAWProject> {
    const text = await file.text();
    const data = JSON.parse(text) as Partial<ProjectFileEnvelope> | DAWProject;
    let project: DAWProject;
    if ("format" in data && data.format === "mmodaw") {
        if (typeof data.version !== "number" || data.version > PROJECT_FILE_VERSION) {
            throw new Error(`Unsupported project file version: ${data.version}`);
        }
        if (!data.project) throw new Error("Project file is missing the `project` payload");
        project = data.project;
    } else if ("tracks" in data && Array.isArray((data as DAWProject).tracks)) {
        // Older raw export — accept it directly.
        project = data as DAWProject;
    } else {
        throw new Error("Not a valid MuzicAI DAW project file");
    }
    // Always assign a fresh id on import so we never overwrite an
    // existing project of the same name.
    const imported: DAWProject = {
        ...project,
        id: createId(),
        name: options?.rename ? `${project.name} (Imported)` : project.name,
        createdAt: Date.now(),
        modifiedAt: Date.now(),
    };
    saveProject(imported);
    return imported;
}

export const PROJECT_FILE_EXTENSION = PROJECT_FILE_EXT;
