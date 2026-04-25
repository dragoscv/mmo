"use client";

/**
 * Live Performance Engine
 *
 * Single low-latency AudioContext orchestrating all sound sources for a live show:
 *   - Voice mic (delegated to AudioFxEngine — full FX chain, pitch detect)
 *   - Backing track (negativ/karaoke) playback with tempo + key shift
 *   - 4× Looper banks (record from voice, loop playback)
 *   - 8× Sample pads (drag/drop audio, one-shot or loop)
 *   - Metronome (private monitor or also recorded)
 *   - Master bus → soft limiter → speakers + recording dest
 *
 * Routing:
 *
 *   voice.output ─┐
 *   backing ──────┤
 *   loopers ──────┼─→ mainBus → limiter → analyser → ┬─→ destination (speakers)
 *   pads ─────────┘                                  └─→ recDest (MediaRecorder)
 *
 *   metronome (monitor) ─→ destination (NOT recorded if monitor-only)
 *   metronome (full)    ─→ mainBus
 *
 * All sources are mono-or-stereo via channel count merge into the mainBus.
 */

import { AudioFxEngine, NOTE_NAMES, type LiveMeterData } from "./audio-fx-engine";
import { dlog } from "@/lib/dev-debugger";

// ─── Types ───────────────────────────────────────────────────────────────────

export type LooperState = "empty" | "recording" | "playing" | "stopped" | "overdubbing";

export interface LooperBank {
    id: number;
    state: LooperState;
    buffer: AudioBuffer | null;
    durationBeats: number;
    volume: number;
    muted: boolean;
}

export interface PadSlot {
    id: number;
    name: string;
    color: string;
    buffer: AudioBuffer | null;
    isPlaying: boolean;
    volume: number;
    loop: boolean;
}

export interface SetSong {
    id: string;
    name: string;
    tempo: number;
    keyIndex: number;
    scaleIndex: number;
    backingUrl?: string;
    voiceChainPresetId?: string;
}

export interface LiveEngineState {
    masterVolume: number;
    monitorVolume: number;
    masterPeakL: number;
    masterPeakR: number;
    isLimiting: boolean;
    tempo: number;
    isMetronomeOn: boolean;
    metronomeMonitorOnly: boolean;
    metronomeVolume: number;
    keyIndex: number;
    scaleIndex: number;
    isRecording: boolean;
    recordingDuration: number;
    backingLoaded: boolean;
    backingName: string;
    backingIsPlaying: boolean;
    backingPosition: number;
    backingDuration: number;
    backingVolume: number;
    backingTempoRatio: number;
    backingPitchSemis: number;
    backingLoopActive: boolean;
    loopers: LooperBank[];
    activeLooperId: number | null;
    looperBeatLength: number;
    pads: PadSlot[];
    tunerNote: string;
    tunerCents: number;
    tunerFrequency: number;
    tunerConfidence: number;
}

export const DEFAULT_PAD_COLORS = [
    "#f43f5e", "#f97316", "#eab308", "#22c55e",
    "#06b6d4", "#3b82f6", "#a855f7", "#ec4899",
];

// ─── Engine ──────────────────────────────────────────────────────────────────

export class LiveEngine {
    readonly ctx: AudioContext;
    readonly voice: AudioFxEngine;

    // Master signal path
    private mainBus: GainNode;
    /** Insert gain between `voice.output` and `mainBus` so we can mute the
     *  dry mic without touching the user's voice output gain slider — used
     *  by the Instrument widget's "Hear mic" toggle. */
    private voiceMonitorGain: GainNode;
    /** Public bus for additional in-app sources (e.g. instrument synth) that
     *  should land on the master mix without going through the voice FX
     *  engine. */
    readonly instrumentBus: GainNode;
    private masterLimiter: DynamicsCompressorNode;
    private masterGain: GainNode;
    private monitorGain: GainNode;
    private masterAnalyserL: AnalyserNode;
    private masterAnalyserR: AnalyserNode;
    private masterSplitter: ChannelSplitterNode;
    /** High-resolution FFT analyser on the master bus (mono mix, post-limiter)
     *  for the visualizer widget. fftSize=1024 → 512 frequency bins. */
    private masterFftAnalyser: AnalyserNode;

    // Recording
    private recordDest: MediaStreamAudioDestinationNode;
    private mediaRecorder: MediaRecorder | null = null;
    private recordedChunks: Blob[] = [];
    private recordStartedAt = 0;

    // Network streaming (WebRTC) — separate tap so quality is independent
    // of the recorder, and the same stream can be reused across reconnects.
    private streamDest: MediaStreamAudioDestinationNode | null = null;
    // Remote audio coming back from the peer (e.g. phone mic acting as input)
    private remoteInputSource: MediaStreamAudioSourceNode | null = null;
    private remoteInputGain: GainNode | null = null;

    // Backing track
    private backingAudio: HTMLAudioElement | null = null;
    private backingSource: MediaElementAudioSourceNode | null = null;
    private backingGain: GainNode;

    // Metronome
    private metroSchedulerId: number | null = null;
    private metroNextBeatTime = 0;
    private metroBeatCount = 0;
    private metroGain: GainNode;            // routed to mainBus (recorded)
    private metroMonitorGain: GainNode;     // routed direct to destination

    // Loopers
    private looperGains: GainNode[] = [];
    private looperSources: (AudioBufferSourceNode | null)[] = [];
    private looperRecorder: MediaRecorder | null = null;
    private looperRecordChunks: Blob[] = [];
    private looperRecordingId: number | null = null;
    private looperRecordDest: MediaStreamAudioDestinationNode | null = null;

    // Pads
    private padGains: GainNode[] = [];
    private padSources: (AudioBufferSourceNode | null)[] = [];

    // State
    state: LiveEngineState;
    onStateChange?: () => void;

    // Tap BPM
    private tapTimes: number[] = [];

    constructor() {
        // Aggressively low latency
        this.ctx = new AudioContext({ latencyHint: 0.001, sampleRate: 48000 });
        dlog("live", "engine constructed", { sampleRate: this.ctx.sampleRate, baseLatency: this.ctx.baseLatency });

        // Voice engine — shares no AudioContext (uses its own). For routing we'll connect its output to our mainBus.
        // We pass our own ctx so they share clock/sample rate.
        this.voice = new AudioFxEngine(this.ctx);

        // ── Build master signal path ───────────────────────────────
        this.mainBus = this.ctx.createGain();
        this.mainBus.gain.value = 1.0;

        this.masterLimiter = this.ctx.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -1.5;
        this.masterLimiter.knee.value = 0;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = 0.001;
        this.masterLimiter.release.value = 0.05;

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.85;

        this.monitorGain = this.ctx.createGain();
        this.monitorGain.gain.value = 0.85;

        // L/R analysers for metering
        this.masterSplitter = this.ctx.createChannelSplitter(2);
        this.masterAnalyserL = this.ctx.createAnalyser();
        this.masterAnalyserL.fftSize = 256;
        this.masterAnalyserR = this.ctx.createAnalyser();
        this.masterAnalyserR.fftSize = 256;
        // Hi-res analyser for visualization (separate from peak meters so we
        // can size them independently without affecting metering accuracy).
        this.masterFftAnalyser = this.ctx.createAnalyser();
        this.masterFftAnalyser.fftSize = 1024;
        this.masterFftAnalyser.smoothingTimeConstant = 0.75;
        this.masterFftAnalyser.minDecibels = -90;
        this.masterFftAnalyser.maxDecibels = -10;

        // Backing
        this.backingGain = this.ctx.createGain();
        this.backingGain.gain.value = 0.85;
        this.backingGain.connect(this.mainBus);

        // Metronome buses
        this.metroGain = this.ctx.createGain();
        this.metroGain.gain.value = 0;
        this.metroGain.connect(this.mainBus);
        this.metroMonitorGain = this.ctx.createGain();
        this.metroMonitorGain.gain.value = 0.5;
        this.metroMonitorGain.connect(this.ctx.destination);

        // Voice → voiceMonitor → mainBus (the monitor gain lets us mute the
        // dry mic independently when the user only wants to hear the
        // re-voiced instrument).
        this.voiceMonitorGain = this.ctx.createGain();
        this.voiceMonitorGain.gain.value = 1.0;
        this.voice.output.connect(this.voiceMonitorGain);
        this.voiceMonitorGain.connect(this.mainBus);

        // Instrument bus → mainBus (separate node so muting the mic does not
        // mute the synth and vice-versa).
        this.instrumentBus = this.ctx.createGain();
        this.instrumentBus.gain.value = 1.0;
        this.instrumentBus.connect(this.mainBus);

        // mainBus → limiter → masterGain → destination
        this.mainBus.connect(this.masterLimiter);
        this.masterLimiter.connect(this.masterGain);
        this.masterGain.connect(this.ctx.destination);

        // Parallel: limiter → meters
        this.masterLimiter.connect(this.masterSplitter);
        this.masterSplitter.connect(this.masterAnalyserL, 0);
        this.masterSplitter.connect(this.masterAnalyserR, 1);
        // Parallel: limiter → hi-res visualization analyser
        this.masterLimiter.connect(this.masterFftAnalyser);

        // Recording destination — full master mix (post-limiter)
        this.recordDest = this.ctx.createMediaStreamDestination();
        this.masterLimiter.connect(this.recordDest);

        // Init looper gains
        for (let i = 0; i < 4; i++) {
            const g = this.ctx.createGain();
            g.gain.value = 0.85;
            g.connect(this.mainBus);
            this.looperGains.push(g);
            this.looperSources.push(null);
        }

        // Init pad gains
        for (let i = 0; i < 8; i++) {
            const g = this.ctx.createGain();
            g.gain.value = 0.85;
            g.connect(this.mainBus);
            this.padGains.push(g);
            this.padSources.push(null);
        }

        // Initial state
        this.state = {
            masterVolume: 0.85,
            monitorVolume: 0.85,
            masterPeakL: 0,
            masterPeakR: 0,
            isLimiting: false,
            tempo: 120,
            isMetronomeOn: false,
            metronomeMonitorOnly: true,
            metronomeVolume: 0.5,
            keyIndex: 0,
            scaleIndex: 1,
            isRecording: false,
            recordingDuration: 0,
            backingLoaded: false,
            backingName: "",
            backingIsPlaying: false,
            backingPosition: 0,
            backingDuration: 0,
            backingVolume: 0.85,
            backingTempoRatio: 1.0,
            backingPitchSemis: 0,
            backingLoopActive: false,
            loopers: Array.from({ length: 4 }, (_, i) => ({
                id: i,
                state: "empty" as LooperState,
                buffer: null,
                durationBeats: 0,
                volume: 0.85,
                muted: false,
            })),
            activeLooperId: null,
            looperBeatLength: 4,
            pads: Array.from({ length: 8 }, (_, i) => ({
                id: i,
                name: `Pad ${i + 1}`,
                color: DEFAULT_PAD_COLORS[i],
                buffer: null,
                isPlaying: false,
                volume: 0.85,
                loop: false,
            })),
            tunerNote: "—",
            tunerCents: 0,
            tunerFrequency: 0,
            tunerConfidence: 0,
        };
    }

    private notify() { this.onStateChange?.(); }

    // ─── Master ──────────────────────────────────────────────────────

    setMasterVolume(v: number) {
        const clamped = Math.max(0, Math.min(2, v));
        this.state.masterVolume = clamped;
        this.masterGain.gain.value = clamped;
        this.notify();
    }

    setMonitorVolume(v: number) {
        const clamped = Math.max(0, Math.min(2, v));
        this.state.monitorVolume = clamped;
        this.monitorGain.gain.value = clamped;
        this.metroMonitorGain.gain.value = clamped * this.state.metronomeVolume;
        this.notify();
    }

    /**
     * Mute / unmute the dry mic monitor (everything coming from the voice FX
     * engine). When `false`, the mic is silenced on the master mix while
     * recording, streaming, loopers and the instrument bus continue to
     * receive a clean voice tap unaffected. Ramps to avoid clicks.
     */
    setVoiceMonitor(enabled: boolean, fadeMs = 30) {
        const t = this.ctx.currentTime;
        const target = enabled ? 1 : 0;
        try {
            this.voiceMonitorGain.gain.cancelScheduledValues(t);
            this.voiceMonitorGain.gain.setTargetAtTime(target, t, Math.max(0.005, fadeMs / 1000));
        } catch {
            this.voiceMonitorGain.gain.value = target;
        }
    }

    // ─── Tempo / Key ─────────────────────────────────────────────────

    setTempo(bpm: number) {
        this.state.tempo = Math.max(20, Math.min(300, bpm));
        this.notify();
    }

    setKey(idx: number) {
        this.state.keyIndex = ((idx % 12) + 12) % 12;
        this.notify();
    }

    setScale(idx: number) {
        this.state.scaleIndex = idx;
        this.notify();
    }

    // ─── Tap BPM ─────────────────────────────────────────────────────

    tapBpm(): number | null {
        const now = performance.now();
        // Reset if last tap was >2s ago
        if (this.tapTimes.length > 0 && now - this.tapTimes[this.tapTimes.length - 1] > 2000) {
            this.tapTimes = [];
        }
        this.tapTimes.push(now);
        // Keep last 8 taps
        if (this.tapTimes.length > 8) this.tapTimes.shift();
        if (this.tapTimes.length < 2) return null;
        const intervals: number[] = [];
        for (let i = 1; i < this.tapTimes.length; i++) {
            intervals.push(this.tapTimes[i] - this.tapTimes[i - 1]);
        }
        const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const bpm = 60_000 / avg;
        this.setTempo(bpm);
        return bpm;
    }

    // ─── Metronome ───────────────────────────────────────────────────

    toggleMetronome() {
        if (this.state.isMetronomeOn) this.stopMetronome();
        else this.startMetronome();
    }

    setMetronomeMonitorOnly(monitorOnly: boolean) {
        this.state.metronomeMonitorOnly = monitorOnly;
        this.notify();
    }

    setMetronomeVolume(v: number) {
        this.state.metronomeVolume = Math.max(0, Math.min(1, v));
        this.metroMonitorGain.gain.value = this.state.monitorVolume * this.state.metronomeVolume;
        this.notify();
    }

    private startMetronome() {
        this.state.isMetronomeOn = true;
        this.metroNextBeatTime = this.ctx.currentTime + 0.05;
        this.metroBeatCount = 0;
        const scheduler = () => {
            const lookahead = 0.1;
            while (this.metroNextBeatTime < this.ctx.currentTime + lookahead) {
                this.scheduleClick(this.metroNextBeatTime, this.metroBeatCount % 4 === 0);
                this.metroNextBeatTime += 60 / this.state.tempo;
                this.metroBeatCount++;
            }
            this.metroSchedulerId = window.setTimeout(scheduler, 25);
        };
        scheduler();
        this.notify();
    }

    private stopMetronome() {
        this.state.isMetronomeOn = false;
        if (this.metroSchedulerId !== null) {
            clearTimeout(this.metroSchedulerId);
            this.metroSchedulerId = null;
        }
        this.notify();
    }

    private scheduleClick(time: number, isAccent: boolean) {
        const osc = this.ctx.createOscillator();
        const env = this.ctx.createGain();
        osc.frequency.value = isAccent ? 1500 : 1000;
        env.gain.setValueAtTime(0, time);
        env.gain.linearRampToValueAtTime(0.6, time + 0.001);
        env.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
        osc.connect(env);
        // Route based on monitor-only setting
        if (this.state.metronomeMonitorOnly) {
            env.connect(this.metroMonitorGain);
        } else {
            env.connect(this.metroGain);
            this.metroGain.gain.value = this.state.metronomeVolume;
            // Also still hear it in monitor
            env.connect(this.metroMonitorGain);
        }
        osc.start(time);
        osc.stop(time + 0.1);
    }

    // ─── Backing Track ───────────────────────────────────────────────

    async loadBackingTrack(file: File | string) {
        await this.unloadBackingTrack();
        const url = typeof file === "string" ? file : URL.createObjectURL(file);
        const name = typeof file === "string" ? url.split("/").pop() ?? "Backing" : file.name;

        const audio = new Audio(url);
        audio.crossOrigin = "anonymous";
        audio.preservesPitch = false;  // we handle pitch via detune
        await new Promise<void>((resolve, reject) => {
            audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
            audio.addEventListener("error", () => reject(new Error("backing load failed")), { once: true });
            audio.load();
        });

        this.backingAudio = audio;
        this.backingSource = this.ctx.createMediaElementSource(audio);
        this.backingSource.connect(this.backingGain);

        this.state.backingLoaded = true;
        this.state.backingName = name;
        this.state.backingDuration = audio.duration || 0;
        this.state.backingPosition = 0;
        this.state.backingIsPlaying = false;
        this.notify();
    }

    async unloadBackingTrack() {
        if (this.backingAudio) {
            this.backingAudio.pause();
            this.backingAudio.src = "";
            this.backingAudio = null;
        }
        if (this.backingSource) {
            try { this.backingSource.disconnect(); } catch { /* ok */ }
            this.backingSource = null;
        }
        this.state.backingLoaded = false;
        this.state.backingName = "";
        this.state.backingDuration = 0;
        this.state.backingPosition = 0;
        this.state.backingIsPlaying = false;
        this.notify();
    }

    backingPlay() {
        if (!this.backingAudio) return;
        if (this.ctx.state === "suspended") this.ctx.resume();
        this.backingAudio.play().catch(() => { /* ok */ });
        this.state.backingIsPlaying = true;
        this.notify();
    }

    backingPause() {
        if (!this.backingAudio) return;
        this.backingAudio.pause();
        this.state.backingIsPlaying = false;
        this.notify();
    }

    backingToggle() {
        if (this.state.backingIsPlaying) this.backingPause();
        else this.backingPlay();
    }

    backingStop() {
        if (!this.backingAudio) return;
        this.backingAudio.pause();
        this.backingAudio.currentTime = 0;
        this.state.backingIsPlaying = false;
        this.state.backingPosition = 0;
        this.notify();
    }

    backingSeek(seconds: number) {
        if (!this.backingAudio) return;
        this.backingAudio.currentTime = Math.max(0, Math.min(this.state.backingDuration, seconds));
        this.state.backingPosition = this.backingAudio.currentTime;
        this.notify();
    }

    setBackingVolume(v: number) {
        this.state.backingVolume = Math.max(0, Math.min(2, v));
        this.backingGain.gain.value = this.state.backingVolume;
        this.notify();
    }

    setBackingTempoRatio(r: number) {
        this.state.backingTempoRatio = Math.max(0.5, Math.min(1.5, r));
        if (this.backingAudio) this.backingAudio.playbackRate = this.state.backingTempoRatio;
        this.notify();
    }

    setBackingPitchSemis(s: number) {
        this.state.backingPitchSemis = Math.max(-12, Math.min(12, Math.round(s)));
        // HTMLAudioElement doesn't support detune; would need OfflineAudioContext re-render or custom processor.
        // For now, record state — actual pitch shift TBD.
        this.notify();
    }

    setBackingLoop(active: boolean) {
        this.state.backingLoopActive = active;
        if (this.backingAudio) this.backingAudio.loop = active;
        this.notify();
    }

    // ─── Recording (full session) ────────────────────────────────────

    async startRecording() {
        if (this.state.isRecording) return;
        try {
            const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : "audio/webm";
            this.mediaRecorder = new MediaRecorder(this.recordDest.stream, { mimeType: mime, audioBitsPerSecond: 192_000 });
            this.recordedChunks = [];
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) this.recordedChunks.push(e.data);
            };
            this.mediaRecorder.start(1000);
            this.recordStartedAt = Date.now();
            this.state.isRecording = true;
            this.state.recordingDuration = 0;
            this.notify();
            dlog("live", "recording started", { mime });
        } catch (e) {
            console.error("[LiveEngine] startRecording failed:", e);
            dlog("live", "recording start failed", { error: String(e) }, "error");
        }
    }

    async stopRecording(): Promise<Blob | null> {
        if (!this.mediaRecorder || !this.state.isRecording) return null;
        return new Promise((resolve) => {
            this.mediaRecorder!.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder!.mimeType || "audio/webm" });
                this.recordedChunks = [];
                this.state.isRecording = false;
                this.state.recordingDuration = 0;
                this.notify();
                resolve(blob);
            };
            this.mediaRecorder!.stop();
        });
    }

    /**
     * Stop recording and resolve with both the blob and its duration.
     * Mirrors MixerEngine.stopRecordingAsync — used by the context layer to
     * pipe the result through `uploadRecording`.
     */
    async stopRecordingAsync(): Promise<{ blob: Blob; duration: number } | null> {
        if (!this.mediaRecorder || !this.state.isRecording) return null;
        const duration = this.recordStartedAt ? Date.now() - this.recordStartedAt : 0;
        const blob = await this.stopRecording();
        if (!blob) return null;
        return { blob, duration };
    }

    /**
     * Legacy toggle — start/stop only. Persistence is owned by the context
     * layer (see live-context.tsx → toggleRecording) so a single code path
     * handles upload + toast across desktop, remote, and keyboard shortcuts.
     */
    toggleRecording() {
        if (this.state.isRecording) void this.stopRecording();
        else void this.startRecording();
    }

    // ─── Loopers ─────────────────────────────────────────────────────

    setLooperBeatLength(beats: number) {
        this.state.looperBeatLength = Math.max(1, Math.min(64, beats));
        this.notify();
    }

    setLooperVolume(id: number, v: number) {
        const looper = this.state.loopers[id];
        if (!looper) return;
        looper.volume = Math.max(0, Math.min(2, v));
        this.looperGains[id].gain.value = looper.volume * (looper.muted ? 0 : 1);
        this.notify();
    }

    toggleLooperMute(id: number) {
        const looper = this.state.loopers[id];
        if (!looper) return;
        looper.muted = !looper.muted;
        this.looperGains[id].gain.value = looper.volume * (looper.muted ? 0 : 1);
        this.notify();
    }

    async startLooperRecording(id: number) {
        if (this.looperRecordingId !== null) return;
        const looper = this.state.loopers[id];
        if (!looper) return;
        this.looperRecordingId = id;
        looper.state = "recording";
        this.state.activeLooperId = id;

        // Record from voice output (most useful for vocalists)
        this.looperRecordDest = this.ctx.createMediaStreamDestination();
        this.voice.output.connect(this.looperRecordDest);
        try {
            const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
            this.looperRecorder = new MediaRecorder(this.looperRecordDest.stream, { mimeType: mime });
            this.looperRecordChunks = [];
            this.looperRecorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) this.looperRecordChunks.push(e.data);
            };
            this.looperRecorder.start();
            this.notify();
        } catch (e) {
            console.error("[LiveEngine] looper record failed:", e);
            looper.state = "empty";
            this.looperRecordingId = null;
            this.notify();
        }
    }

    async stopLooperRecording() {
        if (this.looperRecordingId === null || !this.looperRecorder) return;
        const id = this.looperRecordingId;
        const looper = this.state.loopers[id];
        return new Promise<void>((resolve) => {
            this.looperRecorder!.onstop = async () => {
                try {
                    const blob = new Blob(this.looperRecordChunks, { type: this.looperRecorder!.mimeType });
                    const arrayBuffer = await blob.arrayBuffer();
                    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
                    looper.buffer = audioBuffer;
                    looper.durationBeats = (audioBuffer.duration / 60) * this.state.tempo;
                    looper.state = "playing";
                    this.playLooper(id);
                } catch (e) {
                    console.error("[LiveEngine] looper decode failed:", e);
                    looper.state = "empty";
                }
                this.looperRecorder = null;
                this.looperRecordChunks = [];
                if (this.looperRecordDest) {
                    try { this.voice.output.disconnect(this.looperRecordDest); } catch { /* ok */ }
                    this.looperRecordDest = null;
                }
                this.looperRecordingId = null;
                this.notify();
                resolve();
            };
            this.looperRecorder!.stop();
        });
    }

    toggleLooper(id: number) {
        const looper = this.state.loopers[id];
        if (!looper) return;
        if (looper.state === "empty") {
            void this.startLooperRecording(id);
        } else if (looper.state === "recording") {
            void this.stopLooperRecording();
        } else if (looper.state === "playing") {
            this.stopLooperPlayback(id);
        } else if (looper.state === "stopped") {
            this.playLooper(id);
        }
    }

    clearLooper(id: number) {
        const looper = this.state.loopers[id];
        if (!looper) return;
        this.stopLooperPlayback(id);
        looper.buffer = null;
        looper.state = "empty";
        looper.durationBeats = 0;
        this.notify();
    }

    private playLooper(id: number) {
        const looper = this.state.loopers[id];
        if (!looper || !looper.buffer) return;
        this.stopLooperPlayback(id);
        const src = this.ctx.createBufferSource();
        src.buffer = looper.buffer;
        src.loop = true;
        src.connect(this.looperGains[id]);
        src.start();
        this.looperSources[id] = src;
        looper.state = "playing";
        this.notify();
    }

    private stopLooperPlayback(id: number) {
        const src = this.looperSources[id];
        if (src) {
            try { src.stop(); src.disconnect(); } catch { /* ok */ }
            this.looperSources[id] = null;
        }
        const looper = this.state.loopers[id];
        if (looper && looper.buffer) looper.state = "stopped";
    }

    stopAllLoopers() {
        for (let i = 0; i < this.looperSources.length; i++) this.stopLooperPlayback(i);
        this.notify();
    }

    // ─── Pads ────────────────────────────────────────────────────────

    async loadPad(id: number, file: File) {
        const pad = this.state.pads[id];
        if (!pad) return;
        try {
            const arr = await file.arrayBuffer();
            const buf = await this.ctx.decodeAudioData(arr);
            pad.buffer = buf;
            pad.name = file.name.replace(/\.[^.]+$/, "");
            this.notify();
        } catch (e) {
            console.error("[LiveEngine] pad load failed:", e);
        }
    }

    triggerPad(id: number) {
        const pad = this.state.pads[id];
        if (!pad || !pad.buffer) return;
        if (this.ctx.state === "suspended") this.ctx.resume();
        // Stop any existing playback
        const existing = this.padSources[id];
        if (existing) {
            try { existing.stop(); existing.disconnect(); } catch { /* ok */ }
        }
        const src = this.ctx.createBufferSource();
        src.buffer = pad.buffer;
        src.loop = pad.loop;
        src.connect(this.padGains[id]);
        src.onended = () => {
            if (this.padSources[id] === src) {
                this.padSources[id] = null;
                pad.isPlaying = false;
                this.notify();
            }
        };
        src.start();
        this.padSources[id] = src;
        pad.isPlaying = true;
        this.notify();
    }

    stopPad(id: number) {
        const src = this.padSources[id];
        if (src) {
            try { src.stop(); src.disconnect(); } catch { /* ok */ }
            this.padSources[id] = null;
        }
        const pad = this.state.pads[id];
        if (pad) pad.isPlaying = false;
        this.notify();
    }

    setPadVolume(id: number, v: number) {
        const pad = this.state.pads[id];
        if (!pad) return;
        pad.volume = Math.max(0, Math.min(2, v));
        this.padGains[id].gain.value = pad.volume;
        this.notify();
    }

    setPadLoop(id: number, loop: boolean) {
        const pad = this.state.pads[id];
        if (!pad) return;
        pad.loop = loop;
        if (this.padSources[id]) this.padSources[id]!.loop = loop;
        this.notify();
    }

    clearPad(id: number) {
        this.stopPad(id);
        const pad = this.state.pads[id];
        if (!pad) return;
        pad.buffer = null;
        pad.name = `Pad ${id + 1}`;
        this.notify();
    }

    // ─── Metering / Tuner Tick ───────────────────────────────────────

    /** Hi-res master FFT analyser — for the visualizer widget. */
    get masterAnalyser(): AnalyserNode { return this.masterFftAnalyser; }
    /** Per-channel master analysers — for stereo / vectorscope visualizations. */
    get masterAnalyserNodes(): { L: AnalyserNode; R: AnalyserNode } {
        return { L: this.masterAnalyserL, R: this.masterAnalyserR };
    }

    /** Reusable scratch buffers for compact broadcast helpers. */
    private _spectrumScratch: Uint8Array<ArrayBuffer> | null = null;
    private _waveformScratch: Uint8Array<ArrayBuffer> | null = null;

    /** Downsample the master spectrum to N bytes (default 32) for cheap
     *  remote broadcast. Each output bin is the max of its source range,
     *  so transient peaks survive the downsample. */
    getCompactSpectrum(bins = 32): number[] {
        const a = this.masterFftAnalyser;
        const srcLen = a.frequencyBinCount;
        if (!this._spectrumScratch || this._spectrumScratch.length !== srcLen) {
            this._spectrumScratch = new Uint8Array(new ArrayBuffer(srcLen));
        }
        a.getByteFrequencyData(this._spectrumScratch);
        // Logarithmic-ish bucketing biased toward lower frequencies, where
        // most musical energy lives. Each bucket grows wider with index.
        const out = new Array<number>(bins);
        const logMax = Math.log2(srcLen);
        for (let i = 0; i < bins; i++) {
            const lo = Math.floor(Math.pow(2, (i / bins) * logMax));
            const hi = Math.max(lo + 1, Math.floor(Math.pow(2, ((i + 1) / bins) * logMax)));
            let max = 0;
            for (let j = lo; j < hi && j < srcLen; j++) {
                if (this._spectrumScratch[j] > max) max = this._spectrumScratch[j];
            }
            out[i] = max;
        }
        return out;
    }

    /** Downsample the master time-domain waveform to N bytes (default 32). */
    getCompactWaveform(bins = 32): number[] {
        const a = this.masterFftAnalyser;
        const srcLen = a.fftSize;
        if (!this._waveformScratch || this._waveformScratch.length !== srcLen) {
            this._waveformScratch = new Uint8Array(new ArrayBuffer(srcLen));
        }
        a.getByteTimeDomainData(this._waveformScratch);
        const out = new Array<number>(bins);
        const stride = srcLen / bins;
        for (let i = 0; i < bins; i++) {
            // Sample at the bucket center — preserves zero-crossings nicely.
            out[i] = this._waveformScratch[Math.floor((i + 0.5) * stride)] ?? 128;
        }
        return out;
    }

    /**
     * Call this from a requestAnimationFrame loop to update peaks/tuner.
     * Returns a fresh meter snapshot.
     */
    tickMeters(): { peakL: number; peakR: number; isLimiting: boolean; voiceMeter: LiveMeterData } {
        // Master peaks
        const bufL = new Float32Array(this.masterAnalyserL.fftSize);
        const bufR = new Float32Array(this.masterAnalyserR.fftSize);
        this.masterAnalyserL.getFloatTimeDomainData(bufL);
        this.masterAnalyserR.getFloatTimeDomainData(bufR);
        let pL = 0, pR = 0;
        for (let i = 0; i < bufL.length; i++) {
            const aL = Math.abs(bufL[i]);
            const aR = Math.abs(bufR[i]);
            if (aL > pL) pL = aL;
            if (aR > pR) pR = aR;
        }
        // Smoothing
        this.state.masterPeakL = Math.max(this.state.masterPeakL * 0.7, pL);
        this.state.masterPeakR = Math.max(this.state.masterPeakR * 0.7, pR);

        const isLimiting = this.masterLimiter.reduction < -0.5;
        this.state.isLimiting = isLimiting;

        // Voice meter (also drives tuner)
        const voiceMeter = this.voice.getMeterData();
        if (this.voice.inputActive) {
            this.state.tunerNote = voiceMeter.pitch.note;
            this.state.tunerCents = voiceMeter.pitch.cents;
            this.state.tunerFrequency = voiceMeter.pitch.frequency;
            this.state.tunerConfidence = voiceMeter.pitch.confidence;
        }

        // Backing position
        if (this.backingAudio && this.state.backingIsPlaying) {
            this.state.backingPosition = this.backingAudio.currentTime;
        }

        // Recording duration
        if (this.state.isRecording) {
            this.state.recordingDuration = Date.now() - this.recordStartedAt;
        }

        return { peakL: this.state.masterPeakL, peakR: this.state.masterPeakR, isLimiting, voiceMeter };
    }

    // ─── Network streaming taps ──────────────────────────────────────

    /**
     * Returns a MediaStream of the post-limiter master mix. Created lazily
     * so we don't allocate audio nodes when no peer is streaming.
     * Reused across reconnects.
     */
    getOutputStream(): MediaStream {
        if (!this.streamDest) {
            this.streamDest = this.ctx.createMediaStreamDestination();
            this.masterLimiter.connect(this.streamDest);
        }
        return this.streamDest.stream;
    }

    /**
     * Route an incoming MediaStream (from the remote peer's mic) into the
     * voice processor's input bus. This sums with any local mic input,
     * so a duet is possible. Pass null to disconnect.
     */
    attachRemoteInput(stream: MediaStream | null) {
        // Tear down previous
        if (this.remoteInputSource) {
            try { this.remoteInputSource.disconnect(); } catch { /* ok */ }
            this.remoteInputSource = null;
        }
        if (this.remoteInputGain) {
            try { this.remoteInputGain.disconnect(); } catch { /* ok */ }
            this.remoteInputGain = null;
        }

        if (!stream || stream.getAudioTracks().length === 0) return;

        this.remoteInputSource = this.ctx.createMediaStreamSource(stream);
        this.remoteInputGain = this.ctx.createGain();
        this.remoteInputGain.gain.value = 1.0;
        this.remoteInputSource.connect(this.remoteInputGain);
        this.remoteInputGain.connect(this.voice.input);
    }

    setRemoteInputGain(value: number) {
        if (this.remoteInputGain) {
            this.remoteInputGain.gain.value = Math.max(0, Math.min(2, value));
        }
    }

    // ─── Cleanup ─────────────────────────────────────────────────────

    async destroy() {
        this.stopMetronome();
        if (this.state.isRecording) await this.stopRecording();
        await this.unloadBackingTrack();
        this.stopAllLoopers();
        for (let i = 0; i < this.padSources.length; i++) this.stopPad(i);
        try { this.voice.destroy(); } catch { /* ok */ }
        try { this.mainBus.disconnect(); } catch { /* ok */ }
        try { this.masterLimiter.disconnect(); } catch { /* ok */ }
        try { this.masterGain.disconnect(); } catch { /* ok */ }
        try { this.masterAnalyserL.disconnect(); } catch { /* ok */ }
        try { this.masterAnalyserR.disconnect(); } catch { /* ok */ }
        try { this.masterFftAnalyser.disconnect(); } catch { /* ok */ }
        try { this.masterSplitter.disconnect(); } catch { /* ok */ }
        try { this.recordDest.disconnect(); } catch { /* ok */ }
        try { this.streamDest?.disconnect(); } catch { /* ok */ }
        try { this.remoteInputSource?.disconnect(); } catch { /* ok */ }
        try { this.remoteInputGain?.disconnect(); } catch { /* ok */ }
        try { await this.ctx.close(); } catch { /* ok */ }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function noteIndexToName(idx: number): string {
    return NOTE_NAMES[((idx % 12) + 12) % 12];
}

export function formatLiveTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatRecordTime(ms: number): string {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m}:${s.toString().padStart(2, "0")}`;
}
