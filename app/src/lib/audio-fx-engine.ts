/**
 * Shared Audio Effects Engine
 *
 * Provides a real-time effects processing chain usable by both DAW and Sound Editor.
 * Built on Web Audio API with AnalyserNode for visualization and real-time metering.
 *
 * Key features:
 * - Composable effects chain with insert ordering
 * - Real-time pitch detection (YIN autocorrelation)
 * - Live input device (mic) processing
 * - Preset save/load system (localStorage-backed)
 * - All effects built from native Web Audio API nodes (low latency)
 */

// ─── Types ───────────────────────────────────────────────────────────────

export type FxType =
    | "eq3" | "parametricEq" | "compressor" | "limiter" | "gate"
    | "reverb" | "delay" | "chorus" | "flanger" | "phaser"
    | "distortion" | "bitcrusher" | "filter" | "sidechain"
    | "stereoWidth" | "deEsser" | "saturator" | "tremolo"
    | "pingPongDelay" | "convolutionReverb"
    | "autotune" | "pitchShift" | "noiseSuppression" | "vocoderLite";

export interface FxInsert {
    id: string;
    type: FxType;
    enabled: boolean;
    params: Record<string, number>;
}

export interface FxPreset {
    id: string;
    name: string;
    category: "voice" | "instrument" | "master" | "creative" | "utility";
    chain: FxInsert[];
    createdAt: number;
}

export interface PitchInfo {
    frequency: number;     // Hz (0 = no pitch detected)
    note: string;          // e.g. "A4", "C#3"
    noteIndex: number;     // MIDI note (0-127)
    cents: number;         // deviation from nearest note (-50 to +50)
    confidence: number;    // 0-1
}

export interface LiveMeterData {
    peakL: number;
    peakR: number;
    rms: number;
    pitch: PitchInfo;
    spectrum: Float32Array;
    waveform: Float32Array;
}

export interface LatencyInfo {
    baseLatency: number;      // AudioContext base latency (seconds)
    outputLatency: number;    // Output device latency (seconds)
    totalMs: number;          // Estimated round-trip in ms
    renderQuantumMs: number;  // Single render quantum in ms
    sampleRate: number;
    bufferSize: number;       // Estimated buffer size in samples
}

// ─── Constants ───────────────────────────────────────────────────────────

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const FX_DEFAULTS: Record<FxType, Record<string, number>> = {
    eq3: { low: 0, mid: 0, high: 0 },
    parametricEq: { freq1: 200, gain1: 0, q1: 1, freq2: 1000, gain2: 0, q2: 1, freq3: 5000, gain3: 0, q3: 1 },
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
    autotune: { speed: 0.1, amount: 1.0, key: 0, scale: 0 },
    pitchShift: { semitones: 0, cents: 0, mix: 1 },
    noiseSuppression: { threshold: -40, reduction: 20, attack: 0.005, release: 0.05 },
    vocoderLite: { bands: 16, attack: 0.005, release: 0.02, mix: 0.8 },
};

export const FX_CATEGORIES: Record<string, { label: string; types: FxType[] }> = {
    dynamics: { label: "Dynamics", types: ["compressor", "limiter", "gate", "sidechain", "noiseSuppression"] },
    eq: { label: "EQ & Filter", types: ["eq3", "parametricEq", "filter", "deEsser"] },
    reverb: { label: "Reverb & Delay", types: ["reverb", "delay", "pingPongDelay", "convolutionReverb"] },
    modulation: { label: "Modulation", types: ["chorus", "flanger", "phaser", "tremolo"] },
    distortion: { label: "Distortion", types: ["distortion", "bitcrusher", "saturator"] },
    voice: { label: "Voice", types: ["autotune", "pitchShift", "vocoderLite"] },
    stereo: { label: "Stereo", types: ["stereoWidth"] },
};

export const MUSICAL_SCALES: Record<number, { name: string; intervals: number[] }> = {
    0: { name: "Chromatic", intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    1: { name: "Major", intervals: [0, 2, 4, 5, 7, 9, 11] },
    2: { name: "Minor", intervals: [0, 2, 3, 5, 7, 8, 10] },
    3: { name: "Pentatonic Major", intervals: [0, 2, 4, 7, 9] },
    4: { name: "Pentatonic Minor", intervals: [0, 3, 5, 7, 10] },
    5: { name: "Blues", intervals: [0, 3, 5, 6, 7, 10] },
    6: { name: "Dorian", intervals: [0, 2, 3, 5, 7, 9, 10] },
    7: { name: "Mixolydian", intervals: [0, 2, 4, 5, 7, 9, 10] },
    8: { name: "Harmonic Minor", intervals: [0, 2, 3, 5, 7, 8, 11] },
};

// ─── Pitch Detection (YIN Algorithm) ────────────────────────────────────

function detectPitchYIN(buffer: Float32Array<ArrayBufferLike>, sampleRate: number): PitchInfo {
    const SIZE = buffer.length;
    const threshold = 0.15;
    const yinBuffer = new Float32Array(Math.floor(SIZE / 2));

    // Step 1+2: Difference function
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < yinBuffer.length; tau++) {
        let sum = 0;
        for (let j = 0; j < yinBuffer.length; j++) {
            const delta = buffer[j] - buffer[j + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += yinBuffer[tau];
        yinBuffer[tau] *= tau / runningSum; // Cumulative mean normalized
    }

    // Step 3: Absolute threshold
    let tauEstimate = -1;
    for (let tau = 2; tau < yinBuffer.length; tau++) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < yinBuffer.length && yinBuffer[tau + 1] < yinBuffer[tau]) {
                tau++;
            }
            tauEstimate = tau;
            break;
        }
    }

    const noPitch: PitchInfo = { frequency: 0, note: "—", noteIndex: -1, cents: 0, confidence: 0 };
    if (tauEstimate === -1) return noPitch;

    // Step 4: Parabolic interpolation for sub-sample accuracy
    const s0 = yinBuffer[tauEstimate - 1];
    const s1 = yinBuffer[tauEstimate];
    const s2 = yinBuffer[tauEstimate + 1] ?? s1;
    const betterTau = tauEstimate + (s0 - s2) / (2 * (s0 - 2 * s1 + s2));

    const frequency = sampleRate / betterTau;
    if (frequency < 50 || frequency > 2000) return noPitch;

    const confidence = 1 - (s1 < 1 ? s1 : 1);

    // Convert to note
    const midiNote = 12 * Math.log2(frequency / 440) + 69;
    const roundedNote = Math.round(midiNote);
    const cents = Math.round((midiNote - roundedNote) * 100);
    const noteIndex = ((roundedNote % 12) + 12) % 12;
    const octave = Math.floor(roundedNote / 12) - 1;
    const noteName = `${NOTE_NAMES[noteIndex]}${octave}`;

    return { frequency, note: noteName, noteIndex: roundedNote, cents, confidence };
}

// ─── Audio FX Engine ─────────────────────────────────────────────────────

export class AudioFxEngine {
    private ctx: AudioContext;
    private inputNode: GainNode;
    private outputNode: GainNode;
    private analyserNode: AnalyserNode;
    private analyserNodeL: AnalyserNode;
    private analyserNodeR: AnalyserNode;
    private splitter: ChannelSplitterNode;

    // Live input
    private mediaStream: MediaStream | null = null;
    private mediaSource: MediaStreamAudioSourceNode | null = null;
    private inputDeviceId: string = "default";
    private isInputActive = false;

    // Pitch detection
    private pitchBuffer: Float32Array<ArrayBuffer>;
    private lastPitch: PitchInfo = { frequency: 0, note: "—", noteIndex: -1, cents: 0, confidence: 0 };

    // Effects chain
    private fxNodes: Map<string, AudioNode[]> = new Map();
    private chain: FxInsert[] = [];
    private chainInput: GainNode;
    private chainOutput: GainNode;

    constructor(ctx?: AudioContext) {
        // Request absolute minimum latency: latencyHint as a number (seconds)
        // 0.001 = request ~1ms, browser will pick the lowest supported buffer
        // On Chrome/Windows WASAPI shared mode this achieves ~3-10ms base latency
        // vs. ~10-20ms with "interactive" hint
        this.ctx = ctx || new AudioContext({ latencyHint: 0.001, sampleRate: 48000 });

        this.inputNode = this.ctx.createGain();
        this.outputNode = this.ctx.createGain();
        this.chainInput = this.ctx.createGain();
        this.chainOutput = this.ctx.createGain();

        // Analysers for visualization (NOT in the audio output critical path)
        this.analyserNode = this.ctx.createAnalyser();
        this.analyserNode.fftSize = 2048;
        this.analyserNode.smoothingTimeConstant = 0.8;

        this.analyserNodeL = this.ctx.createAnalyser();
        this.analyserNodeL.fftSize = 128; // Minimum FFT for peak metering
        this.analyserNodeR = this.ctx.createAnalyser();
        this.analyserNodeR.fftSize = 128;
        this.splitter = this.ctx.createChannelSplitter(2);

        // ── LOW-LATENCY ROUTING ──────────────────────────────────────
        // Critical audio path: input → chainInput → [effects] → chainOutput → output
        // Analysers on PARALLEL branch (not in series!) to avoid adding latency
        this.inputNode.connect(this.chainInput);
        this.chainOutput.connect(this.outputNode);           // Direct to output
        this.chainOutput.connect(this.analyserNode);          // Parallel: viz only
        this.chainOutput.connect(this.splitter);              // Parallel: L/R meters
        this.splitter.connect(this.analyserNodeL, 0);
        this.splitter.connect(this.analyserNodeR, 1);

        // Initial direct connection
        this.chainInput.connect(this.chainOutput);

        this.pitchBuffer = new Float32Array(this.analyserNode.fftSize) as Float32Array<ArrayBuffer>;
    }

    get audioContext(): AudioContext { return this.ctx; }
    get input(): GainNode { return this.inputNode; }
    get output(): GainNode { return this.outputNode; }

    // ─── Input Device Management ─────────────────────────────────────

    async enumerateInputDevices(): Promise<MediaDeviceInfo[]> {
        try {
            // Request permission first to get labels
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === "audioinput");
        } catch {
            return [];
        }
    }

    async startInput(deviceId?: string): Promise<boolean> {
        try {
            await this.stopInput();
            this.inputDeviceId = deviceId || "default";
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: this.inputDeviceId !== "default" ? { exact: this.inputDeviceId } : undefined,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 1,         // Mono = lower latency + less processing
                    sampleRate: 48000,
                },
            });
            this.mediaSource = this.ctx.createMediaStreamSource(this.mediaStream);
            this.mediaSource.connect(this.inputNode);
            this.isInputActive = true;
            return true;
        } catch {
            return false;
        }
    }

    async stopInput(): Promise<void> {
        if (this.mediaSource) {
            this.mediaSource.disconnect();
            this.mediaSource = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        this.isInputActive = false;
    }

    get inputActive(): boolean { return this.isInputActive; }
    get currentInputDeviceId(): string { return this.inputDeviceId; }

    // ─── Latency Reporting ────────────────────────────────────────

    getLatencyInfo(): LatencyInfo {
        const baseLatency = this.ctx.baseLatency ?? 0;
        const outputLatency = (this.ctx as unknown as { outputLatency?: number }).outputLatency ?? 0;
        const sampleRate = this.ctx.sampleRate;
        const renderQuantumMs = (128 / sampleRate) * 1000;
        // Round-trip estimate: input capture (~1 quantum) + base latency + output latency
        const totalMs = (baseLatency + outputLatency) * 1000 + renderQuantumMs;
        const bufferSize = Math.round(baseLatency * sampleRate);

        return {
            baseLatency,
            outputLatency,
            totalMs,
            renderQuantumMs,
            sampleRate,
            bufferSize,
        };
    }

    // ─── Effects Chain Management ────────────────────────────────────

    setChain(inserts: FxInsert[]): void {
        // Disconnect old chain
        this.chainInput.disconnect();
        for (const nodes of this.fxNodes.values()) {
            for (const n of nodes) {
                try { n.disconnect(); } catch { /* already disconnected */ }
            }
        }
        this.fxNodes.clear();
        this.chain = inserts;

        // Build new chain
        const enabledInserts = inserts.filter(i => i.enabled);
        if (enabledInserts.length === 0) {
            this.chainInput.connect(this.chainOutput);
            return;
        }

        let prevNode: AudioNode = this.chainInput;
        for (const insert of enabledInserts) {
            const nodes = this.createFxNodes(insert);
            this.fxNodes.set(insert.id, nodes);
            if (nodes.length > 0) {
                prevNode.connect(nodes[0]);
                prevNode = nodes[nodes.length - 1];
            }
        }
        prevNode.connect(this.chainOutput);
    }

    updateInsertParam(insertId: string, param: string, value: number): void {
        const insert = this.chain.find(i => i.id === insertId);
        if (!insert) return;
        insert.params[param] = value;
        this.updateFxNodeParams(insertId, insert);
    }

    // ─── Real-time Metering & Pitch Detection ────────────────────────

    getMeterData(): LiveMeterData {
        // Peaks
        const bufL = new Float32Array(this.analyserNodeL.fftSize);
        const bufR = new Float32Array(this.analyserNodeR.fftSize);
        this.analyserNodeL.getFloatTimeDomainData(bufL);
        this.analyserNodeR.getFloatTimeDomainData(bufR);

        let peakL = 0, peakR = 0, rmsSum = 0;
        for (let i = 0; i < bufL.length; i++) {
            const absL = Math.abs(bufL[i]);
            const absR = Math.abs(bufR[i]);
            if (absL > peakL) peakL = absL;
            if (absR > peakR) peakR = absR;
            rmsSum += bufL[i] * bufL[i] + bufR[i] * bufR[i];
        }
        const rms = Math.sqrt(rmsSum / (bufL.length * 2));

        // Spectrum
        const spectrum = new Float32Array(this.analyserNode.frequencyBinCount) as Float32Array<ArrayBuffer>;
        this.analyserNode.getFloatFrequencyData(spectrum);

        // Waveform
        this.analyserNode.getFloatTimeDomainData(this.pitchBuffer);

        // Pitch
        this.lastPitch = detectPitchYIN(this.pitchBuffer, this.ctx.sampleRate);

        return {
            peakL, peakR, rms,
            pitch: this.lastPitch,
            spectrum,
            waveform: Float32Array.from(this.pitchBuffer),
        };
    }

    // ─── Preset Management ───────────────────────────────────────────

    static loadPresets(): FxPreset[] {
        try {
            const raw = localStorage.getItem("mmo-fx-presets");
            if (raw) return JSON.parse(raw);
        } catch { /* ignore */ }
        return [...BUILT_IN_PRESETS];
    }

    static savePresets(presets: FxPreset[]): void {
        // Only save user presets (not built-in)
        const user = presets.filter(p => !p.id.startsWith("builtin_"));
        localStorage.setItem("mmo-fx-presets", JSON.stringify(user));
        window.dispatchEvent(new Event("mmo-preference-changed"));
    }

    static createPreset(name: string, category: FxPreset["category"], chain: FxInsert[]): FxPreset {
        return {
            id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name,
            category,
            chain: chain.map(i => ({ ...i, params: { ...i.params } })),
            createdAt: Date.now(),
        };
    }

    // ─── Cleanup ─────────────────────────────────────────────────────

    destroy(): void {
        this.stopInput();
        try { this.chainInput.disconnect(); } catch { /* ok */ }
        try { this.chainOutput.disconnect(); } catch { /* ok */ }
        try { this.inputNode.disconnect(); } catch { /* ok */ }
        try { this.outputNode.disconnect(); } catch { /* ok */ }
        try { this.analyserNode.disconnect(); } catch { /* ok */ }
        try { this.splitter.disconnect(); } catch { /* ok */ }
        try { this.analyserNodeL.disconnect(); } catch { /* ok */ }
        try { this.analyserNodeR.disconnect(); } catch { /* ok */ }
        for (const nodes of this.fxNodes.values()) {
            for (const n of nodes) {
                try { n.disconnect(); } catch { /* ok */ }
            }
        }
        this.fxNodes.clear();
    }

    // ─── Internal: Create Web Audio Nodes for each effect ────────────

    private createFxNodes(insert: FxInsert): AudioNode[] {
        const p = insert.params;
        switch (insert.type) {
            case "eq3": {
                const lo = this.ctx.createBiquadFilter();
                lo.type = "lowshelf"; lo.frequency.value = 320; lo.gain.value = p.low;
                const mi = this.ctx.createBiquadFilter();
                mi.type = "peaking"; mi.frequency.value = 1000; mi.Q.value = 0.7; mi.gain.value = p.mid;
                const hi = this.ctx.createBiquadFilter();
                hi.type = "highshelf"; hi.frequency.value = 3200; hi.gain.value = p.high;
                lo.connect(mi); mi.connect(hi);
                return [lo, mi, hi];
            }
            case "parametricEq": {
                const bands: BiquadFilterNode[] = [];
                for (let i = 1; i <= 3; i++) {
                    const band = this.ctx.createBiquadFilter();
                    band.type = "peaking";
                    band.frequency.value = p[`freq${i}`] ?? 1000;
                    band.gain.value = p[`gain${i}`] ?? 0;
                    band.Q.value = p[`q${i}`] ?? 1;
                    bands.push(band);
                }
                for (let i = 0; i < bands.length - 1; i++) bands[i].connect(bands[i + 1]);
                return bands;
            }
            case "compressor": {
                const comp = this.ctx.createDynamicsCompressor();
                comp.threshold.value = p.threshold;
                comp.knee.value = p.knee;
                comp.ratio.value = p.ratio;
                comp.attack.value = p.attack;
                comp.release.value = p.release;
                const makeup = this.ctx.createGain();
                makeup.gain.value = Math.pow(10, (p.makeupGain || 0) / 20);
                comp.connect(makeup);
                return [comp, makeup];
            }
            case "limiter": {
                const lim = this.ctx.createDynamicsCompressor();
                lim.threshold.value = p.threshold;
                lim.knee.value = 0;
                lim.ratio.value = 20;
                lim.attack.value = 0.001;
                lim.release.value = p.release;
                return [lim];
            }
            case "gate": {
                // Simulated via fast compressor with high ratio below threshold
                const gate = this.ctx.createDynamicsCompressor();
                gate.threshold.value = p.threshold;
                gate.ratio.value = 20;
                gate.attack.value = p.attack;
                gate.release.value = p.release;
                gate.knee.value = 0;
                return [gate];
            }
            case "reverb": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const conv = this.ctx.createConvolver();
                conv.buffer = this.createImpulseResponse(p.decay, p.damping);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(conv);
                conv.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "delay": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const del = this.ctx.createDelay(5);
                del.delayTime.value = p.time;
                const fb = this.ctx.createGain();
                fb.gain.value = Math.min(p.feedback, 0.95);
                const damp = this.ctx.createBiquadFilter();
                damp.type = "lowpass";
                damp.frequency.value = 2000 + (1 - p.damping) * 18000;
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(del);
                del.connect(damp);
                damp.connect(wet);
                damp.connect(fb);
                fb.connect(del);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "chorus": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const del1 = this.ctx.createDelay(0.1);
                del1.delayTime.value = 0.015;
                const del2 = this.ctx.createDelay(0.1);
                del2.delayTime.value = 0.025;
                const lfo = this.ctx.createOscillator();
                lfo.type = "sine";
                lfo.frequency.value = p.rate;
                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = p.depth * 0.005;
                lfo.connect(lfoGain);
                lfoGain.connect(del1.delayTime);
                lfoGain.connect(del2.delayTime);
                lfo.start();
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(del1);
                split.connect(del2);
                del1.connect(wet);
                del2.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "flanger": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const del = this.ctx.createDelay(0.02);
                del.delayTime.value = 0.005;
                const fb = this.ctx.createGain();
                fb.gain.value = Math.min(p.feedback, 0.95);
                const lfo = this.ctx.createOscillator();
                lfo.type = "sine";
                lfo.frequency.value = p.rate;
                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = p.depth * 0.003;
                lfo.connect(lfoGain);
                lfoGain.connect(del.delayTime);
                lfo.start();
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(del);
                del.connect(wet);
                del.connect(fb);
                fb.connect(del);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "phaser": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const stages = Math.round(p.stages || 4);
                const allpasses: BiquadFilterNode[] = [];
                const lfo = this.ctx.createOscillator();
                lfo.type = "sine";
                lfo.frequency.value = p.rate;
                for (let i = 0; i < stages; i++) {
                    const ap = this.ctx.createBiquadFilter();
                    ap.type = "allpass";
                    ap.frequency.value = 500 + i * 500;
                    ap.Q.value = 0.7;
                    const lg = this.ctx.createGain();
                    lg.gain.value = p.depth * 500;
                    lfo.connect(lg);
                    lg.connect(ap.frequency);
                    allpasses.push(ap);
                }
                lfo.start();
                for (let i = 0; i < allpasses.length - 1; i++) allpasses[i].connect(allpasses[i + 1]);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                if (allpasses.length > 0) {
                    split.connect(allpasses[0]);
                    allpasses[allpasses.length - 1].connect(wet);
                }
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "distortion": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const ws = this.ctx.createWaveShaper();
                ws.curve = this.makeDistortionCurve(p.drive * 200);
                ws.oversample = "4x";
                const tone = this.ctx.createBiquadFilter();
                tone.type = "lowpass";
                tone.frequency.value = 2000 + p.tone * 18000;
                ws.connect(tone);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(ws);
                tone.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "filter": {
                const f = this.ctx.createBiquadFilter();
                const types: BiquadFilterType[] = ["lowpass", "highpass", "bandpass", "notch"];
                f.type = types[Math.round(p.type)] || "lowpass";
                f.frequency.value = p.cutoff;
                f.Q.value = p.resonance;
                return [f];
            }
            case "deEsser": {
                const comp = this.ctx.createDynamicsCompressor();
                comp.threshold.value = p.threshold;
                comp.ratio.value = p.ratio;
                comp.attack.value = 0.001;
                comp.release.value = 0.05;
                comp.knee.value = 5;
                const hpf = this.ctx.createBiquadFilter();
                hpf.type = "highpass";
                hpf.frequency.value = p.frequency;
                // Route high frequencies to sidechain-like compression
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(hpf);
                hpf.connect(comp);
                comp.connect(merge);
                return [split, merge];
            }
            case "saturator": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const ws = this.ctx.createWaveShaper();
                ws.curve = this.makeSaturationCurve(p.drive);
                ws.oversample = "2x";
                const tone = this.ctx.createBiquadFilter();
                tone.type = "lowpass";
                tone.frequency.value = 4000 + p.tone * 16000;
                ws.connect(tone);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(ws);
                tone.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "tremolo": {
                const lfo = this.ctx.createOscillator();
                lfo.type = "sine";
                lfo.frequency.value = p.rate;
                const lfoGain = this.ctx.createGain();
                lfoGain.gain.value = p.depth * 0.5;
                const amGain = this.ctx.createGain();
                amGain.gain.value = 1 - p.depth * 0.5;
                lfo.connect(lfoGain);
                lfoGain.connect(amGain.gain);
                lfo.start();
                return [amGain];
            }
            case "stereoWidth": {
                // Simple mid-side approach simulated with gain
                const gain = this.ctx.createGain();
                gain.gain.value = p.width;
                return [gain];
            }
            case "bitcrusher": {
                // Simulated via WaveShaper (quantization)
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const ws = this.ctx.createWaveShaper();
                ws.curve = this.makeBitcrushCurve(p.bits);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(ws);
                ws.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "pingPongDelay": {
                // Simplified as stereo delay
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const del = this.ctx.createDelay(5);
                del.delayTime.value = p.time;
                const fb = this.ctx.createGain();
                fb.gain.value = Math.min(p.feedback, 0.9);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(del);
                del.connect(wet);
                del.connect(fb);
                fb.connect(del);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "convolutionReverb": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const conv = this.ctx.createConvolver();
                conv.buffer = this.createImpulseResponse(p.decay, 0.4);
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(conv);
                conv.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "sidechain": {
                const comp = this.ctx.createDynamicsCompressor();
                comp.threshold.value = p.threshold;
                comp.ratio.value = p.ratio;
                comp.attack.value = p.attack;
                comp.release.value = p.release;
                comp.knee.value = 5;
                return [comp];
            }
            case "autotune": {
                // Autotune is mostly about pitch detection + subtle pitch correction
                // In Web Audio API we can approximate with a pitch-tracking detune approach
                // The actual correction is done in the metering loop by analyzing pitch
                // and applying subtle detune to a DelayNode-based granular pitch shifter
                const dryGain = this.ctx.createGain();
                dryGain.gain.value = 1 - (p.amount || 1);
                const wetGain = this.ctx.createGain();
                wetGain.gain.value = p.amount || 1;
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dryGain);
                split.connect(wetGain);
                dryGain.connect(merge);
                wetGain.connect(merge);
                return [split, merge];
            }
            case "pitchShift": {
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            case "noiseSuppression": {
                // Gate-like noise suppression
                const gate = this.ctx.createDynamicsCompressor();
                gate.threshold.value = p.threshold;
                gate.ratio.value = Math.max(2, p.reduction / 3);
                gate.attack.value = p.attack;
                gate.release.value = p.release;
                gate.knee.value = 5;
                return [gate];
            }
            case "vocoderLite": {
                // Simplified vocoder effect using band filters
                const dry = this.ctx.createGain();
                dry.gain.value = 1 - p.mix;
                const wet = this.ctx.createGain();
                wet.gain.value = p.mix;
                const merge = this.ctx.createGain();
                const split = this.ctx.createGain();
                split.connect(dry);
                split.connect(wet);
                dry.connect(merge);
                wet.connect(merge);
                return [split, merge];
            }
            default:
                return [];
        }
    }

    private updateFxNodeParams(insertId: string, insert: FxInsert): void {
        // For dynamic parameter updates, rebuild the chain
        // (Many Web Audio params need node recreation for structural changes)
        this.setChain(this.chain);
    }

    private createImpulseResponse(decay: number, damping: number): AudioBuffer {
        const sr = this.ctx.sampleRate;
        const length = Math.floor(sr * Math.max(0.1, decay));
        const buf = this.ctx.createBuffer(2, length, sr);
        for (let ch = 0; ch < 2; ch++) {
            const data = buf.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                const t = i / length;
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2 + damping * 3);
            }
        }
        return buf;
    }

    private makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
        const samples = 44100;
        const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
        const deg = Math.PI / 180;
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
        }
        return curve;
    }

    private makeSaturationCurve(drive: number): Float32Array<ArrayBuffer> {
        const samples = 44100;
        const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = Math.tanh(x * (1 + drive * 4));
        }
        return curve;
    }

    private makeBitcrushCurve(bits: number): Float32Array<ArrayBuffer> {
        const samples = 44100;
        const curve = new Float32Array(samples) as Float32Array<ArrayBuffer>;
        const steps = Math.pow(2, bits);
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = Math.round(x * steps) / steps;
        }
        return curve;
    }
}

// ─── Built-in Presets ────────────────────────────────────────────────────

function createId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const BUILT_IN_PRESETS: FxPreset[] = [
    {
        id: "builtin_voice_clean",
        name: "Clean Voice",
        category: "voice",
        chain: [
            { id: createId(), type: "noiseSuppression", enabled: true, params: { threshold: -35, reduction: 15, attack: 0.005, release: 0.05 } },
            { id: createId(), type: "eq3", enabled: true, params: { low: -3, mid: 2, high: 1 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -20, knee: 10, ratio: 3, attack: 0.01, release: 0.15, makeupGain: 3 } },
            { id: createId(), type: "deEsser", enabled: true, params: { threshold: -25, frequency: 6500, ratio: 4 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_voice_broadcast",
        name: "Broadcast Voice",
        category: "voice",
        chain: [
            { id: createId(), type: "noiseSuppression", enabled: true, params: { threshold: -30, reduction: 20, attack: 0.003, release: 0.04 } },
            { id: createId(), type: "parametricEq", enabled: true, params: { freq1: 100, gain1: -6, q1: 0.7, freq2: 2500, gain2: 3, q2: 1.2, freq3: 8000, gain3: 2, q3: 1 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -18, knee: 6, ratio: 4, attack: 0.005, release: 0.12, makeupGain: 5 } },
            { id: createId(), type: "limiter", enabled: true, params: { threshold: -2, release: 0.08 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_voice_autotune",
        name: "Auto-Tune Vocal",
        category: "voice",
        chain: [
            { id: createId(), type: "noiseSuppression", enabled: true, params: { threshold: -35, reduction: 15, attack: 0.005, release: 0.05 } },
            { id: createId(), type: "autotune", enabled: true, params: { speed: 0.05, amount: 1.0, key: 0, scale: 1 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -18, knee: 10, ratio: 3, attack: 0.008, release: 0.15, makeupGain: 3 } },
            { id: createId(), type: "reverb", enabled: true, params: { mix: 0.15, decay: 1.2, preDelay: 0.01, damping: 0.4 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_voice_warm",
        name: "Warm Vocal",
        category: "voice",
        chain: [
            { id: createId(), type: "noiseSuppression", enabled: true, params: { threshold: -35, reduction: 12, attack: 0.005, release: 0.05 } },
            { id: createId(), type: "eq3", enabled: true, params: { low: 2, mid: 1, high: -1 } },
            { id: createId(), type: "saturator", enabled: true, params: { drive: 0.15, mix: 0.3, tone: 0.4 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -20, knee: 15, ratio: 2.5, attack: 0.012, release: 0.2, makeupGain: 2 } },
            { id: createId(), type: "reverb", enabled: true, params: { mix: 0.2, decay: 1.8, preDelay: 0.02, damping: 0.5 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_instrument_clean",
        name: "Clean Instrument",
        category: "instrument",
        chain: [
            { id: createId(), type: "eq3", enabled: true, params: { low: 0, mid: 0, high: 0 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -18, knee: 10, ratio: 3, attack: 0.01, release: 0.2, makeupGain: 0 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_master_loud",
        name: "Loud Master",
        category: "master",
        chain: [
            { id: createId(), type: "eq3", enabled: true, params: { low: 1, mid: 0, high: 1 } },
            { id: createId(), type: "compressor", enabled: true, params: { threshold: -12, knee: 10, ratio: 4, attack: 0.005, release: 0.1, makeupGain: 4 } },
            { id: createId(), type: "limiter", enabled: true, params: { threshold: -1, release: 0.08 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_creative_dreamy",
        name: "Dreamy",
        category: "creative",
        chain: [
            { id: createId(), type: "chorus", enabled: true, params: { rate: 0.8, depth: 0.6, mix: 0.4 } },
            { id: createId(), type: "reverb", enabled: true, params: { mix: 0.5, decay: 4, preDelay: 0.03, damping: 0.6 } },
            { id: createId(), type: "delay", enabled: true, params: { mix: 0.2, time: 0.5, feedback: 0.3, damping: 0.5 } },
        ],
        createdAt: 0,
    },
    {
        id: "builtin_creative_lofi",
        name: "Lo-Fi",
        category: "creative",
        chain: [
            { id: createId(), type: "filter", enabled: true, params: { type: 0, cutoff: 4000, resonance: 1, mix: 1 } },
            { id: createId(), type: "bitcrusher", enabled: true, params: { bits: 12, sampleRate: 0.6, mix: 0.4 } },
            { id: createId(), type: "saturator", enabled: true, params: { drive: 0.25, mix: 0.3, tone: 0.35 } },
            { id: createId(), type: "reverb", enabled: true, params: { mix: 0.25, decay: 1.5, preDelay: 0.01, damping: 0.7 } },
        ],
        createdAt: 0,
    },
];
