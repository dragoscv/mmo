// ─── DAW Audio Engine ─────────────────────────────────────────────────────
// Web Audio API based DAW engine with multi-track mixing, effects, instruments,
// MIDI, automation, and real-time audio processing.

import { dlog } from "./dev-debugger";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type TrackType = "audio" | "midi" | "return" | "master";
export type ClipType = "audio" | "midi";
export type ToolMode = "select" | "draw" | "erase" | "slice" | "mute" | "automation";
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
}

export type EffectType =
    | "eq3" | "parametricEq" | "compressor" | "limiter" | "gate"
    | "reverb" | "delay" | "chorus" | "flanger" | "phaser"
    | "distortion" | "bitcrusher" | "filter" | "sidechain"
    | "stereoWidth" | "deEsser" | "saturator" | "tremolo"
    | "pingPongDelay" | "convolutionReverb";

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
    sidechain: { threshold: -20, ratio: 8, attack: 0.001, release: 0.2, sourceTrackId: 0 },
    stereoWidth: { width: 1 },
    deEsser: { threshold: -20, frequency: 6000, ratio: 4 },
    saturator: { drive: 0.3, mix: 0.5, tone: 0.5 },
    tremolo: { rate: 4, depth: 0.5 },
    pingPongDelay: { mix: 0.3, time: 0.25, feedback: 0.4, spread: 0.8 },
    convolutionReverb: { mix: 0.3, decay: 2 },
};

export const EFFECT_TYPES: EffectType[] = [
    "eq3", "parametricEq", "compressor", "limiter", "gate",
    "reverb", "delay", "chorus", "flanger", "phaser",
    "distortion", "bitcrusher", "filter", "sidechain",
    "stereoWidth", "deEsser", "saturator", "tremolo",
    "pingPongDelay", "convolutionReverb",
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
    }

    pause() {
        this.isPlaying = false;
        if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
        }
    }

    seek(beat: number) {
        this.currentBeat = Math.max(0, beat);
        if (this.isPlaying) {
            this.startTime = this.ctx.currentTime - this.beatsToSeconds(this.currentBeat, 120);
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

                // Check if we've passed the end of the project (song mode only)
                if (this._playbackMode === "song" && beat > project.duration && !project.loopRegion.enabled) {
                    this.stop();
                    this.onPlaybackEnd?.();
                    return;
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

        const source = this.ctx.createBufferSource();
        source.buffer = clip.audio.buffer;
        source.playbackRate.value = clip.audio.timeStretch;

        if (clip.audio.pitchShift !== 0) {
            source.detune.value = clip.audio.pitchShift * 100;
        }

        // Clip gain
        const clipGain = this.ctx.createGain();
        clipGain.gain.value = clip.audio.gain;

        // Fade in/out
        if (clip.audio.fadeIn > 0) {
            clipGain.gain.setValueAtTime(0, time);
            clipGain.gain.linearRampToValueAtTime(clip.audio.gain, time + clip.audio.fadeIn);
        }
        const clipDuration = clip.audio.duration / clip.audio.timeStretch;
        if (clip.audio.fadeOut > 0) {
            clipGain.gain.setValueAtTime(clip.audio.gain, time + clipDuration - clip.audio.fadeOut);
            clipGain.gain.linearRampToValueAtTime(0, time + clipDuration);
        }

        source.connect(clipGain);
        clipGain.connect(strip.input);
        source.start(time, clip.audio.startOffset, clip.audio.duration);
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
        const blockSize = Math.floor(data.length / numPeaks);
        for (let i = 0; i < numPeaks; i++) {
            let max = 0;
            for (let j = 0; j < blockSize; j++) {
                const abs = Math.abs(data[i * blockSize + j]);
                if (abs > max) max = abs;
            }
            peaks[i] = max;
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
     * Returns a Blob + estimated size info during render via the onProgress callback.
     */
    async exportProject(
        project: DAWProject,
        format: "wav" | "mp3" | "flac" | "ogg",
        bitRate: number,
        onProgress?: (pct: number) => void,
    ): Promise<{ blob: Blob; duration: number }> {
        const sampleRate = this.ctx.sampleRate;
        // Calculate project duration from furthest clip end
        let maxBeat = project.duration || 32;
        for (const track of project.tracks) {
            for (const clip of track.clips) {
                const end = clip.position + clip.length;
                if (end > maxBeat) maxBeat = end;
            }
        }
        const durationSec = this.beatsToSeconds(maxBeat, project.tempo) + 1; // +1s tail for reverb/delay
        const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSec), sampleRate);

        // Create offline master chain
        const offlineMaster = offlineCtx.createGain();
        offlineMaster.gain.value = project.masterTrack.volume;
        const offlineComp = offlineCtx.createDynamicsCompressor();
        offlineComp.threshold.value = -12;
        offlineComp.ratio.value = 4;
        offlineMaster.connect(offlineComp);
        offlineComp.connect(offlineCtx.destination);

        // Schedule audio clips
        for (const track of project.tracks) {
            if (track.muted) continue;
            const trackGain = offlineCtx.createGain();
            trackGain.gain.value = track.volume;
            const trackPan = offlineCtx.createStereoPanner();
            trackPan.pan.value = track.pan;
            trackGain.connect(trackPan);
            trackPan.connect(offlineMaster);

            for (const clip of track.clips) {
                if (clip.muted || !clip.audio?.buffer) continue;
                const source = offlineCtx.createBufferSource();
                source.buffer = clip.audio.buffer;
                const clipGain = offlineCtx.createGain();
                clipGain.gain.value = clip.audio.gain ?? 1;
                source.connect(clipGain);
                clipGain.connect(trackGain);
                const startSec = this.beatsToSeconds(clip.position, project.tempo);
                source.start(startSec);
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

        // Encode to WAV (native). Other formats would require encoders.
        const blob = this.audioBufferToWav(renderedBuffer);
        onProgress?.(100);

        return { blob, duration: durationSec };
    }

    private audioBufferToWav(buffer: AudioBuffer): Blob {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const length = buffer.length;
        const bytesPerSample = 2; // 16-bit
        const blockAlign = numChannels * bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = length * blockAlign;
        const headerSize = 44;
        const arrayBuffer = new ArrayBuffer(headerSize + dataSize);
        const view = new DataView(arrayBuffer);

        // WAV header
        const writeString = (offset: number, str: string) => {
            for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
        };
        writeString(0, "RIFF");
        view.setUint32(4, 36 + dataSize, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true); // bits per sample
        writeString(36, "data");
        view.setUint32(40, dataSize, true);

        // Interleave channels
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

        let offset = headerSize;
        for (let i = 0; i < length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                const sample = Math.max(-1, Math.min(1, channels[ch][i]));
                view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
                offset += 2;
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
    private activeSources: AudioBufferSourceNode[] = [];
    private destination: GainNode;
    readonly trackId: string;
    readonly type: TrackType;

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

    destroy() {
        this.stopAllSources();
        this.input.disconnect();
        this.gainNode.disconnect();
        this.panNode.disconnect();
        this.muteNode.disconnect();
    }
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
