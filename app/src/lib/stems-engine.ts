/**
 * Core Stems Separation Engine
 *
 * Provides audio stem separation using the Web Audio API.
 * This is a client-side engine that splits audio into stems using
 * frequency-domain isolation (spectral filtering approach).
 *
 * Stem types: vocals, drums, bass, melody (other)
 *
 * Used by: Mixer (real-time per-deck), DAW (offline to tracks), Sound Editor (offline edit)
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type StemType = "vocals" | "drums" | "bass" | "melody";

export const STEM_TYPES: StemType[] = ["vocals", "drums", "bass", "melody"];

export const STEM_LABELS: Record<StemType, string> = {
    vocals: "Vocals",
    drums: "Drums",
    bass: "Bass",
    melody: "Melody",
};

export const STEM_COLORS: Record<StemType, string> = {
    vocals: "#a855f7",  // purple
    drums: "#ef4444",   // red
    bass: "#3b82f6",    // blue
    melody: "#22c55e",  // green
};

export const STEM_ICONS: Record<StemType, string> = {
    vocals: "mic",
    drums: "drum",
    bass: "music",
    melody: "piano",
};

export interface StemConfig {
    type: StemType;
    enabled: boolean;
    volume: number;   // 0-1
    muted: boolean;
    solo: boolean;
}

export interface StemSeparationResult {
    vocals: AudioBuffer | null;
    drums: AudioBuffer | null;
    bass: AudioBuffer | null;
    melody: AudioBuffer | null;
    duration: number;
    sampleRate: number;
}

export interface StemProgress {
    stage: "loading" | "processing" | "isolating" | "finalizing" | "complete" | "error";
    progress: number;  // 0-1
    currentStem?: StemType;
    message: string;
}

export type StemProgressCallback = (progress: StemProgress) => void;

// ─── Default stem config ─────────────────────────────────────────────────────

export function createDefaultStemConfigs(): StemConfig[] {
    return STEM_TYPES.map((type) => ({
        type,
        enabled: true,
        volume: 1,
        muted: false,
        solo: false,
    }));
}

// ─── Frequency band definitions for spectral isolation ───────────────────────

interface FrequencyBand {
    lowFreq: number;
    highFreq: number;
    label: string;
}

const STEM_BANDS: Record<StemType, FrequencyBand> = {
    bass: { lowFreq: 20, highFreq: 250, label: "Sub & Bass" },
    drums: { lowFreq: 60, highFreq: 8000, label: "Percussive" },
    vocals: { lowFreq: 300, highFreq: 5000, label: "Vocal Range" },
    melody: { lowFreq: 200, highFreq: 12000, label: "Melodic" },
};

// ─── Real-stems loader (companion analyzer pre-computed WAVs) ───────────────
//
// Preferred path. When the companion's Python analyzer (BS-Roformer /
// Mel-Roformer / Demucs v4) has already separated the track, the stem
// WAVs live on the companion at `/library/stems/<trackId>/<stem>.wav`.
// Fetching + decoding them yields an order-of-magnitude better
// separation quality than the band-pass fallback in `separateStems`.
//
// The web app ships URLs through here rather than ever sending raw
// audio data — the companion authenticates with the device token and
// streams with HTTP range support, so the four stems decode in
// parallel and the browser never touches the original file.

export interface RealStemsLoadOptions {
    /** Per-stem URL. Caller (`useStems`) builds these via
     *  `companionAnalyzer.stemUrl(link, trackId, stem)`. Stems whose
     *  URL is missing fall back to silence in the result. */
    urls: Partial<Record<"vocals" | "drums" | "bass" | "other", string>>;
    /** Auth headers to include — typically `{ "X-Device-Token": …,
     *  "X-User-Id": … }` matching the companion-library client. */
    headers?: Record<string, string>;
    /** Optional AudioContext to decode into. Avoids resample by reusing
     *  the same ctx the engine plays through. */
    audioContext?: AudioContext;
    /** Progress 0..1 (one tick per stem decoded). */
    onProgress?: StemProgressCallback;
}

export async function loadCompanionStems(
    opts: RealStemsLoadOptions,
): Promise<StemSeparationResult> {
    const ctx = opts.audioContext
        ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const fetched: Record<"vocals" | "drums" | "bass" | "other", AudioBuffer | null> = {
        vocals: null, drums: null, bass: null, other: null,
    };
    const stems = (Object.keys(opts.urls) as Array<keyof typeof opts.urls>)
        .filter((k) => !!opts.urls[k]);

    let done = 0;
    await Promise.all(stems.map(async (stem) => {
        const url = opts.urls[stem]!;
        try {
            const res = await fetch(url, { headers: opts.headers, cache: "force-cache" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buf = await res.arrayBuffer();
            fetched[stem] = await ctx.decodeAudioData(buf);
            done++;
            opts.onProgress?.({
                stage: "isolating",
                progress: done / stems.length,
                currentStem: stem === "other" ? "melody" : stem,
                message: `Loaded ${stem} stem`,
            });
        } catch (e) {
            // Soft-fail per stem — the consumer can still play the rest.
            // The DJ panel will show a "missing" badge for any null one.
            console.warn(`[stems] failed to load ${stem} from ${url}:`, e);
        }
    }));

    // Reference any non-null buffer for shape info.
    const ref = fetched.vocals ?? fetched.drums ?? fetched.bass ?? fetched.other;
    if (!ref) {
        throw new Error("No companion stems were available to load.");
    }
    opts.onProgress?.({ stage: "complete", progress: 1, message: "Stems loaded." });
    return {
        // Map UVR's "other" naming to our canonical "melody" so the
        // Mixer/Sound Editor/DAW don't need to learn a second taxonomy.
        vocals: fetched.vocals,
        drums: fetched.drums,
        bass: fetched.bass,
        melody: fetched.other,
        duration: ref.duration,
        sampleRate: ref.sampleRate,
    };
}

// ─── Core Stem Separation (Offline, fallback band-pass) ─────────────────────
//
// Fallback. Used when the companion analyzer hasn't yet processed the
// track (or Python deps aren't installed). This is purely band-pass
// filtering — DO NOT mistake it for real source separation. It exists
// so the Mixer / DAW / Sound Editor never break when a track was just
// imported and stems aren't ready yet.

/**
 * Separates an AudioBuffer into stems using spectral filtering.
 * This is an offline process that creates separate AudioBuffers for each stem.
 * Uses multi-band spectral decomposition with transient detection for drums.
 */
export async function separateStems(
    sourceBuffer: AudioBuffer,
    onProgress?: StemProgressCallback,
): Promise<StemSeparationResult> {
    const sampleRate = sourceBuffer.sampleRate;
    const length = sourceBuffer.length;
    const channels = sourceBuffer.numberOfChannels;
    const duration = sourceBuffer.duration;

    onProgress?.({ stage: "processing", progress: 0, message: "Analyzing frequency content..." });

    // Get channel data
    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < channels; ch++) {
        channelData.push(sourceBuffer.getChannelData(ch));
    }

    // FFT parameters
    const fftSize = 4096;
    const hopSize = fftSize / 4;
    const numFrames = Math.ceil(length / hopSize);
    const window = createHannWindow(fftSize);

    // Process each channel
    const stemChannelData: Record<StemType, Float32Array[]> = {
        vocals: [],
        drums: [],
        bass: [],
        melody: [],
    };

    for (let ch = 0; ch < channels; ch++) {
        const input = channelData[ch];

        // Create output buffers for this channel
        const outputs: Record<StemType, Float32Array> = {
            vocals: new Float32Array(length),
            drums: new Float32Array(length),
            bass: new Float32Array(length),
            melody: new Float32Array(length),
        };

        // STFT processing
        const fftReal = new Float32Array(fftSize);
        const fftImag = new Float32Array(fftSize);

        for (let frame = 0; frame < numFrames; frame++) {
            const offset = frame * hopSize;

            // Window the input
            for (let i = 0; i < fftSize; i++) {
                const idx = offset + i;
                fftReal[i] = idx < length ? input[idx] * window[i] : 0;
                fftImag[i] = 0;
            }

            // Forward FFT
            fft(fftReal, fftImag, false);

            // Calculate magnitude and phase
            const magnitude = new Float32Array(fftSize);
            const phase = new Float32Array(fftSize);
            for (let i = 0; i < fftSize; i++) {
                magnitude[i] = Math.sqrt(fftReal[i] * fftReal[i] + fftImag[i] * fftImag[i]);
                phase[i] = Math.atan2(fftImag[i], fftReal[i]);
            }

            // Separate stems by frequency masks
            for (const stemType of STEM_TYPES) {
                const band = STEM_BANDS[stemType];
                const stemReal = new Float32Array(fftSize);
                const stemImag = new Float32Array(fftSize);

                for (let bin = 0; bin < fftSize / 2; bin++) {
                    const freq = (bin * sampleRate) / fftSize;
                    let gain = 0;

                    if (stemType === "bass") {
                        // Bass: strong low frequencies with smooth rolloff
                        if (freq < band.lowFreq) {
                            gain = 1;
                        } else if (freq < band.highFreq) {
                            gain = 1 - smoothstep(band.lowFreq, band.highFreq, freq);
                        }
                    } else if (stemType === "drums") {
                        // Drums: use transient detection via spectral flux
                        const transientWeight = getTransientWeight(magnitude, bin, fftSize);
                        if (freq >= band.lowFreq && freq <= band.highFreq) {
                            gain = transientWeight * 0.8;
                        }
                    } else if (stemType === "vocals") {
                        // Vocals: mid-frequency emphasis with harmonic detection
                        if (freq >= band.lowFreq && freq <= band.highFreq) {
                            const center = (band.lowFreq + band.highFreq) / 2;
                            const width = band.highFreq - band.lowFreq;
                            gain = gaussianWeight(freq, center, width * 0.4);
                            // Reduce gain for very low and very high bins in vocal range
                            if (freq < 400) gain *= 0.5;
                            if (freq > 4000) gain *= 0.6;
                        }
                    } else if (stemType === "melody") {
                        // Melody: everything that's not bass, drums, or strong vocals
                        if (freq >= band.lowFreq && freq <= band.highFreq) {
                            const bassGain = freq < STEM_BANDS.bass.highFreq
                                ? 1 - smoothstep(STEM_BANDS.bass.lowFreq, STEM_BANDS.bass.highFreq, freq) : 0;
                            const vocalGain = freq >= STEM_BANDS.vocals.lowFreq && freq <= STEM_BANDS.vocals.highFreq
                                ? gaussianWeight(freq, 1500, 1000) : 0;
                            gain = Math.max(0, 1 - bassGain - vocalGain * 0.5);
                        }
                    }

                    gain = Math.max(0, Math.min(1, gain));

                    // Apply mask to both positive and negative frequencies
                    stemReal[bin] = magnitude[bin] * gain * Math.cos(phase[bin]);
                    stemImag[bin] = magnitude[bin] * gain * Math.sin(phase[bin]);

                    // Mirror for negative frequencies
                    if (bin > 0 && bin < fftSize / 2) {
                        stemReal[fftSize - bin] = stemReal[bin];
                        stemImag[fftSize - bin] = -stemImag[bin];
                    }
                }

                // Inverse FFT
                fft(stemReal, stemImag, true);

                // Overlap-add with window
                for (let i = 0; i < fftSize; i++) {
                    const idx = offset + i;
                    if (idx < length) {
                        outputs[stemType][idx] += stemReal[i] * window[i];
                    }
                }
            }

            // Progress update
            if (frame % 100 === 0) {
                const progress = (ch * numFrames + frame) / (channels * numFrames);
                onProgress?.({
                    stage: "isolating",
                    progress: 0.1 + progress * 0.8,
                    message: `Processing channel ${ch + 1}/${channels}...`,
                });
                // Yield to event loop for UI updates
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // Normalize overlap-add scaling
        const normalizeScale = 2.0 / (3.0 * (fftSize / hopSize));
        for (const stemType of STEM_TYPES) {
            for (let i = 0; i < length; i++) {
                outputs[stemType][i] *= normalizeScale;
            }
            stemChannelData[stemType].push(outputs[stemType]);
        }
    }

    onProgress?.({ stage: "finalizing", progress: 0.9, message: "Creating stem buffers..." });

    // Create AudioBuffers for each stem
    const ctx = new OfflineAudioContext(channels, length, sampleRate);
    const result: StemSeparationResult = {
        vocals: null,
        drums: null,
        bass: null,
        melody: null,
        duration,
        sampleRate,
    };

    for (const stemType of STEM_TYPES) {
        const buffer = ctx.createBuffer(channels, length, sampleRate);
        for (let ch = 0; ch < channels; ch++) {
            buffer.copyToChannel(new Float32Array(stemChannelData[stemType][ch]), ch);
        }
        result[stemType] = buffer;
    }

    onProgress?.({ stage: "complete", progress: 1, message: "Stem separation complete" });

    return result;
}

// ─── Real-time Stem Processor (for Mixer) ────────────────────────────────────

/**
 * Creates a real-time stem isolation node chain using Web Audio filters.
 * Each stem gets its own filter chain with gain control.
 * This is less accurate than offline FFT but runs in real-time.
 */
export class RealtimeStemProcessor {
    private ctx: AudioContext;
    private input: GainNode;
    private output: GainNode;
    private stemChains: Map<StemType, StemChain> = new Map();
    private _configs: StemConfig[];
    private _isActive = false;

    constructor(ctx: AudioContext) {
        this.ctx = ctx;
        this.input = ctx.createGain();
        this.output = ctx.createGain();
        this._configs = createDefaultStemConfigs();
        this.buildChains();
    }

    get inputNode(): GainNode { return this.input; }
    get outputNode(): GainNode { return this.output; }
    get isActive(): boolean { return this._isActive; }
    get configs(): StemConfig[] { return this._configs; }

    private buildChains() {
        // Disconnect existing
        for (const chain of this.stemChains.values()) {
            chain.disconnect();
        }
        this.stemChains.clear();

        for (const stemType of STEM_TYPES) {
            const chain = new StemChain(this.ctx, stemType);
            this.stemChains.set(stemType, chain);
        }

        this.reconnect();
    }

    private reconnect() {
        this.input.disconnect();
        for (const chain of this.stemChains.values()) {
            chain.disconnect();
        }

        if (!this._isActive) {
            // Bypass: connect input directly to output
            this.input.connect(this.output);
            return;
        }

        // Active: split input into stem chains, sum to output
        for (const chain of this.stemChains.values()) {
            this.input.connect(chain.inputNode);
            chain.outputNode.connect(this.output);
        }
    }

    activate() {
        this._isActive = true;
        this.reconnect();
        this.applyConfigs();
    }

    deactivate() {
        this._isActive = false;
        this.reconnect();
    }

    toggle() {
        if (this._isActive) this.deactivate();
        else this.activate();
    }

    setStemVolume(stem: StemType, volume: number) {
        const config = this._configs.find(c => c.type === stem);
        if (config) config.volume = Math.max(0, Math.min(1, volume));
        this.applyConfigs();
    }

    setStemMuted(stem: StemType, muted: boolean) {
        const config = this._configs.find(c => c.type === stem);
        if (config) config.muted = muted;
        this.applyConfigs();
    }

    toggleStemMute(stem: StemType) {
        const config = this._configs.find(c => c.type === stem);
        if (config) config.muted = !config.muted;
        this.applyConfigs();
    }

    setStemSolo(stem: StemType, solo: boolean) {
        // Solo: mute all other stems
        for (const config of this._configs) {
            config.solo = config.type === stem ? solo : false;
        }
        this.applyConfigs();
    }

    toggleStemSolo(stem: StemType) {
        const config = this._configs.find(c => c.type === stem);
        if (!config) return;
        const newSolo = !config.solo;
        for (const c of this._configs) {
            c.solo = c.type === stem ? newSolo : false;
        }
        this.applyConfigs();
    }

    setConfigs(configs: StemConfig[]) {
        this._configs = configs;
        this.applyConfigs();
    }

    private applyConfigs() {
        const hasSolo = this._configs.some(c => c.solo);

        for (const config of this._configs) {
            const chain = this.stemChains.get(config.type);
            if (!chain) continue;

            let targetVolume = config.volume;
            if (config.muted) targetVolume = 0;
            if (hasSolo && !config.solo) targetVolume = 0;

            chain.setVolume(targetVolume);
        }
    }

    getAnalyser(stem: StemType): AnalyserNode | null {
        return this.stemChains.get(stem)?.analyser ?? null;
    }

    destroy() {
        this._isActive = false;
        this.input.disconnect();
        for (const chain of this.stemChains.values()) {
            chain.disconnect();
        }
        this.stemChains.clear();
    }
}

// ─── Stem Chain (Real-time filter chain for one stem) ────────────────────────

class StemChain {
    private ctx: AudioContext;
    private type: StemType;
    private filters: BiquadFilterNode[] = [];
    private gainNode: GainNode;
    readonly analyser: AnalyserNode;
    readonly inputNode: GainNode;
    readonly outputNode: GainNode;

    constructor(ctx: AudioContext, type: StemType) {
        this.ctx = ctx;
        this.type = type;

        this.inputNode = ctx.createGain();
        this.outputNode = ctx.createGain();
        this.gainNode = ctx.createGain();
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 256;

        this.buildFilterChain();
    }

    private buildFilterChain() {
        const band = STEM_BANDS[this.type];

        switch (this.type) {
            case "bass": {
                // Low-pass filter for bass
                const lpf = this.ctx.createBiquadFilter();
                lpf.type = "lowpass";
                lpf.frequency.value = band.highFreq;
                lpf.Q.value = 0.7;
                this.filters = [lpf];
                break;
            }
            case "drums": {
                // Band-pass with high Q for percussive transients
                const bpf = this.ctx.createBiquadFilter();
                bpf.type = "bandpass";
                bpf.frequency.value = Math.sqrt(band.lowFreq * band.highFreq);
                bpf.Q.value = 0.5;

                // Add a peaking filter for kick (60-150Hz)
                const kick = this.ctx.createBiquadFilter();
                kick.type = "peaking";
                kick.frequency.value = 100;
                kick.Q.value = 1;
                kick.gain.value = 4;

                // Add a peaking filter for snare (2-5kHz)
                const snare = this.ctx.createBiquadFilter();
                snare.type = "peaking";
                snare.frequency.value = 3000;
                snare.Q.value = 1;
                snare.gain.value = 3;

                this.filters = [bpf, kick, snare];
                break;
            }
            case "vocals": {
                // Band-pass focused on vocal range
                const bpf = this.ctx.createBiquadFilter();
                bpf.type = "bandpass";
                bpf.frequency.value = Math.sqrt(band.lowFreq * band.highFreq);
                bpf.Q.value = 1.2;

                // Presence boost (2-5kHz)
                const presence = this.ctx.createBiquadFilter();
                presence.type = "peaking";
                presence.frequency.value = 3000;
                presence.Q.value = 0.8;
                presence.gain.value = 2;

                this.filters = [bpf, presence];
                break;
            }
            case "melody": {
                // Wide band-pass for melodic content
                const bpf = this.ctx.createBiquadFilter();
                bpf.type = "bandpass";
                bpf.frequency.value = Math.sqrt(band.lowFreq * band.highFreq);
                bpf.Q.value = 0.4;

                // Cut the low bass to avoid overlap
                const hpf = this.ctx.createBiquadFilter();
                hpf.type = "highpass";
                hpf.frequency.value = 250;
                hpf.Q.value = 0.5;

                this.filters = [hpf, bpf];
                break;
            }
        }

        // Wire: input → filters → gain → analyser → output
        let prev: AudioNode = this.inputNode;
        for (const filter of this.filters) {
            prev.connect(filter);
            prev = filter;
        }
        prev.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        this.analyser.connect(this.outputNode);
    }

    setVolume(volume: number) {
        const time = this.ctx.currentTime;
        this.gainNode.gain.cancelScheduledValues(time);
        this.gainNode.gain.setTargetAtTime(volume, time, 0.02);
    }

    disconnect() {
        try {
            this.inputNode.disconnect();
            for (const f of this.filters) f.disconnect();
            this.gainNode.disconnect();
            this.analyser.disconnect();
            this.outputNode.disconnect();
        } catch { /* noop */ }
    }
}

// ─── DSP Utilities ───────────────────────────────────────────────────────────

function createHannWindow(size: number): Float32Array {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
        window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
    }
    return window;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function gaussianWeight(x: number, mean: number, sigma: number): number {
    const d = (x - mean) / sigma;
    return Math.exp(-0.5 * d * d);
}

function getTransientWeight(magnitude: Float32Array, bin: number, fftSize: number): number {
    // Simple transient approximation based on spectral flatness
    const halfSize = fftSize / 2;
    if (bin >= halfSize) return 0;

    let sum = 0;
    let logSum = 0;
    const range = 4;
    const start = Math.max(0, bin - range);
    const end = Math.min(halfSize, bin + range);

    for (let i = start; i < end; i++) {
        const m = magnitude[i] + 1e-10;
        sum += m;
        logSum += Math.log(m);
    }

    const n = end - start;
    const geometricMean = Math.exp(logSum / n);
    const arithmeticMean = sum / n;
    const flatness = geometricMean / (arithmeticMean + 1e-10);

    // Higher flatness = more noise-like = more transient character
    return 1 - Math.min(1, flatness);
}

/**
 * In-place Cooley-Tukey FFT / IFFT.
 * Operates on interleaved real and imaginary arrays.
 */
function fft(real: Float32Array, imag: Float32Array, inverse: boolean): void {
    const n = real.length;
    if (n <= 1) return;

    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
        let m = n >> 1;
        while (m >= 1 && j >= m) {
            j -= m;
            m >>= 1;
        }
        j += m;
    }

    // Butterfly computation
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size *= 2) {
        const halfSize = size / 2;
        const angleStep = (sign * 2 * Math.PI) / size;

        for (let i = 0; i < n; i += size) {
            for (let k = 0; k < halfSize; k++) {
                const angle = k * angleStep;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);

                const evenIdx = i + k;
                const oddIdx = i + k + halfSize;

                const tReal = cos * real[oddIdx] - sin * imag[oddIdx];
                const tImag = sin * real[oddIdx] + cos * imag[oddIdx];

                real[oddIdx] = real[evenIdx] - tReal;
                imag[oddIdx] = imag[evenIdx] - tImag;
                real[evenIdx] += tReal;
                imag[evenIdx] += tImag;
            }
        }
    }

    // Normalize for inverse FFT
    if (inverse) {
        for (let i = 0; i < n; i++) {
            real[i] /= n;
            imag[i] /= n;
        }
    }
}

// ─── Utility: Get waveform peaks for a stem buffer ───────────────────────────

export function getStemPeaks(buffer: AudioBuffer, numPeaks = 200): Float32Array {
    const channel = buffer.getChannelData(0);
    const blockSize = Math.floor(channel.length / numPeaks);
    const peaks = new Float32Array(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
        let max = 0;
        const start = i * blockSize;
        const end = Math.min(start + blockSize, channel.length);
        for (let j = start; j < end; j++) {
            const abs = Math.abs(channel[j]);
            if (abs > max) max = abs;
        }
        peaks[i] = max;
    }
    return peaks;
}
